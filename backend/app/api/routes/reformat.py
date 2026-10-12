from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.core.dependencies import get_optional_user
from app.models.models import AIUsageEvent, User, ReadingSession, Billing
from app.schemas.schemas import (
    ReformatRequest, ReformatResponse,
    AnalyseSectionsRequest, AnalyseSectionsResponse,
    DocumentReformatRequest,
)
from app.services.rate_limit import check_rate_limit
from app.services.ai import (
    call_gemini, call_claude,
    generate_sq4r_questions,
)
from app.services.profile_context import (
    load_profile, load_feedback_summary, apply_session_difficulty,
)
from app.core.config import settings
from app.core.timeutils import is_past
from time import perf_counter
import asyncio
import logging

logger = logging.getLogger("synapse.reformat")

router = APIRouter(prefix="/reformat", tags=["reformat"])


def _ai_usage_event(
    *,
    user: User | None,
    provider: str,
    operation: str,
    input_characters: int,
    output_characters: int,
    duration_ms: float,
    succeeded: bool,
    source: str | None = None,
    cut_off: bool | None = None,
    input_clipped: bool | None = None,
) -> AIUsageEvent:
    """Provider telemetry without source or generated content."""
    return AIUsageEvent(
        user_id=user.id if user else None,
        provider=provider,
        operation=operation,
        source=source,
        input_characters=input_characters,
        output_characters=output_characters,
        duration_ms=max(0, round(duration_ms)),
        succeeded=succeeded,
        cut_off=cut_off,
        input_clipped=input_clipped,
    )


def _record_ai_usage(db: AsyncSession, **fields) -> None:
    """Store provider telemetry without storing source or generated content."""
    db.add(_ai_usage_event(**fields))


async def _keep_failure_records(db: AsyncSession, events: list[AIUsageEvent]) -> None:
    """Save usage records for a request that is about to fail.

    get_db rolls the session back on the error, which would drop these with
    it. Roll back here instead, so the failed request's quota charge is still
    undone as before, then commit only the records. The events are built
    before the rollback, which expires `user`.
    """
    try:
        await db.rollback()
        db.add_all(events)
        await db.commit()
    except Exception:
        logger.exception("Could not save usage records for a failed request")


async def _validate_input_length(db: AsyncSession, user: User | None, text: str):
    """Tiered validation of page_text length."""
    length = len(text)
    limit = settings.FREE_TEXT_LIMIT
    plan_name = "Free"

    if user and user.plan == "institutional":
        limit = settings.PREMIUM_TEXT_LIMIT
        plan_name = "Institutional"
    elif user and user.plan in ("premium", "lite"):
        result = await db.execute(
            select(Billing).where(Billing.user_id == user.id)
        )
        billing = result.scalar_one_or_none()
        is_active = (
            billing
            and billing.plan in ("premium", "lite")
            and billing.status in ("active", "trialing")
            and not is_past(billing.renews_at)
        )
        if is_active and billing.plan == "lite":
            limit = settings.TRIAL_TEXT_LIMIT
            plan_name = "Thinker Lite"
        elif is_active and billing.status == "trialing":
            limit = settings.TRIAL_TEXT_LIMIT
            plan_name = "Premium Trial"
        elif is_active:
            limit = settings.PREMIUM_TEXT_LIMIT
            plan_name = "Premium"

    if length > limit:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "LENGTH_EXCEEDED",
                "message": f"Content too long ({length:,} chars). Your {plan_name} limit is {limit:,} chars.",
                "current": length,
                "limit": limit,
                "plan": plan_name
            }
        )


async def _is_premium_active(user: User | None, db: AsyncSession) -> bool:
    """Verifies if a user has an active premium/institutional subscription."""
    if not user:
        return False
    
    if user.plan == "institutional":
        return True
    
    if user.plan == "premium":
        result = await db.execute(
            select(Billing).where(Billing.user_id == user.id)
        )
        billing = result.scalar_one_or_none()
        if not billing or billing.plan != "premium":
            return False
        
        # Verify both status and expiration date. renews_at comes back from
        # Postgres timezone-aware; is_past compares it safely either way.
        is_active = billing.status in ("active", "trialing")
        has_not_expired = not is_past(billing.renews_at)
        
        return is_active and has_not_expired

    return False


@router.post("", response_model=ReformatResponse)
async def reformat_page(
    request: Request,
    body: ReformatRequest,
    db: AsyncSession = Depends(get_db),
):
    # ── 1. Identify user ─────────────────────────────────────────
    user = await get_optional_user(request, db)

    # ── 1.5 Validate Input Length ────────────────────────────────
    await _validate_input_length(db, user, body.page_text)

    # ── 2. Rate limit check ───────────────────────────────────────
    await check_rate_limit(db, user, body.fingerprint, request)

    # ── 3. Load cognitive profile ─────────────────────────────────
    profile = await load_profile(db, user, body.profile)

    # ── 4. Load recent feedback for prompt context ────────────────
    feedback_summary = await load_feedback_summary(db, user, body.recent_feedback)

    # ── 5. Apply session difficulty override ──────────────────────
    feedback_summary = apply_session_difficulty(profile, feedback_summary, body.session_difficulty)

    # ── 6. Call AI + SQ4R in parallel ────────────────────────────
    is_premium = await _is_premium_active(user, db)

    if is_premium:
        html_task = call_claude(body.page_text, profile, feedback_summary)
    else:
        html_task = call_gemini(body.page_text, profile, feedback_summary)

    questions_task = generate_sq4r_questions(
        body.page_text, profile["profile_type"]
    )

    provider = "claude" if is_premium else "gemini"
    input_clipped = (
        body.source_characters > len(body.page_text) if body.source_characters is not None else None
    )
    ai_started = perf_counter()
    # return_exceptions: a failed reformat must not leave the questions call
    # running after the request, and its database session, are gone.
    output, sq4r = await asyncio.gather(html_task, questions_task, return_exceptions=True)
    if isinstance(sq4r, BaseException):  # generate_sq4r_questions shouldn't raise
        sq4r = None
    # Always Gemini, whatever the plan; counted apart from the reformat.
    sq4r_events = [_ai_usage_event(
        user=user, provider="gemini", operation="sq4r_questions", source="page",
        input_characters=sq4r.input_characters, output_characters=sq4r.output_characters,
        duration_ms=sq4r.duration_ms, succeeded=sq4r.succeeded,
    )] if sq4r and sq4r.called else []
    questions = sq4r.questions if sq4r else None
    if isinstance(output, Exception):
        await _keep_failure_records(db, sq4r_events + [_ai_usage_event(
            user=user, provider=provider, operation="reformat", source="page",
            input_characters=len(body.page_text), output_characters=0,
            duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=False,
            input_clipped=input_clipped,
        )])
        raise HTTPException(status_code=502, detail=f"AI service error: {str(output)}")
    if isinstance(output, BaseException):
        raise output
    html, cut_off = output
    db.add_all(sq4r_events)

    _record_ai_usage(
        db, user=user, provider=provider, operation="reformat", source="page",
        input_characters=len(body.page_text), output_characters=len(html),
        duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=True,
        cut_off=cut_off, input_clipped=input_clipped,
    )

    # ── 7. Log reading session ────────────────────────────────────
    if user and body.page_url:
        session = ReadingSession(
            user_id=user.id,
            page_url=body.page_url,
            page_title=body.page_title,
            session_difficulty=body.session_difficulty,
            cards_generated=1,
            mode=body.mode,
        )
        db.add(session)
        await db.flush()

    return ReformatResponse(
        html=html,
        questions=questions,
        model_used="claude-sonnet" if is_premium else "gemini-flash",
    )


@router.post("/analyse-sections", response_model=AnalyseSectionsResponse)
async def analyse_sections_route(
    request: Request,
    body: AnalyseSectionsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Identify logical sections on a page."""
    user = await get_optional_user(request, db)
    await _validate_input_length(db, user, body.page_text)
    await check_rate_limit(db, user, body.fingerprint, request)
    
    from app.services.ai import analyse_sections
    try:
        sections = await analyse_sections(body.page_text)
    except HTTPException:
        raise
    except Exception:
        # Log the real cause server-side (may include the AI provider URL/key), but
        # never leak it to the client — return a clean, safe error instead of a 500.
        logger.exception("analyse-sections failed")
        raise HTTPException(
            status_code=502,
            detail="Section analysis is temporarily unavailable. Please try again.",
        )
    return AnalyseSectionsResponse(sections=sections)


@router.post("/reformat-document", response_model=ReformatResponse)
async def reformat_document_route(
    request: Request,
    body: DocumentReformatRequest,
    db: AsyncSession = Depends(get_db),
):
    """Process and reformat a document (PDF, image)."""
    user = await get_optional_user(request, db)
    await _validate_input_length(db, user, body.base64_data)
    await check_rate_limit(db, user, body.fingerprint, request)
    
    # ── Load profile and feedback ────────────────────────────────
    profile = await load_profile(db, user, body.profile)
    feedback_summary = await load_feedback_summary(db, user, body.recent_feedback)
    feedback_summary = apply_session_difficulty(profile, feedback_summary, body.session_difficulty)

    is_premium = await _is_premium_active(user, db)
    
    from app.services.ai import call_document
    provider = "claude" if is_premium else "gemini"
    source = "pdf" if body.media_type == "application/pdf" else "document"
    ai_started = perf_counter()
    try:
        html, cut_off = await call_document(
            body.base64_data,
            body.media_type,
            profile,
            feedback_summary,
            use_claude=is_premium
        )
    except HTTPException:
        await _keep_failure_records(db, [_ai_usage_event(
            user=user, provider=provider, operation="document_reformat", source=source,
            input_characters=len(body.base64_data), output_characters=0,
            duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=False,
        )])
        raise
    except Exception:
        logger.exception("reformat-document failed")
        await _keep_failure_records(db, [_ai_usage_event(
            user=user, provider=provider, operation="document_reformat", source=source,
            input_characters=len(body.base64_data), output_characters=0,
            duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=False,
        )])
        raise HTTPException(
            status_code=502,
            detail="Document reformatting is temporarily unavailable. Please try again.",
        )

    _record_ai_usage(
        db, user=user, provider=provider, operation="document_reformat", source=source,
        input_characters=len(body.base64_data), output_characters=len(html),
        duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=True,
        cut_off=cut_off,
    )

    return ReformatResponse(
        html=html,
        questions=None,
        model_used="claude-sonnet" if is_premium else "gemini-flash"
    )
