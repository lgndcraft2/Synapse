from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.models.models import User, CognitiveProfile, FeedbackLog, ReadingSession
from app.schemas.schemas import (
    ReformatRequest, ReformatResponse,
    AnalyseSectionsRequest, AnalyseSectionsResponse,
    DocumentReformatRequest, CognitiveProfileSchema
)
from app.core.entitlements import get_effective_plan, has_high_tier_entitlement
from app.core.plans import DEEP_THINKER_PLAN, INSTITUTIONAL_PLAN, THINKER_LITE_PLAN
from app.services.rate_limit import check_rate_limit
from app.services.ai import (
    call_gemini, call_claude,
    generate_sq4r_questions,
    build_feedback_summary
)
from app.core.config import settings
from jose import jwt, JWTError
import asyncio

router = APIRouter(prefix="/reformat", tags=["reformat"])


async def _get_optional_user(request: Request, db: AsyncSession) -> User | None:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.split(" ", 1)[1]
    try:
        payload = jwt.decode(
            token, settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"], audience="authenticated"
        )
        uid = payload.get("sub")
        if not uid:
            return None
        result = await db.execute(select(User).where(User.supabase_uid == uid))
        return result.scalar_one_or_none()
    except JWTError:
        return None


async def _validate_input_length(db: AsyncSession, user: User | None, text: str):
    """Tiered validation of page_text length."""
    length = len(text)
    limit = settings.FREE_TEXT_LIMIT
    plan_name = "Free"

    effective_plan = await get_effective_plan(db, user)
    if effective_plan == INSTITUTIONAL_PLAN:
        limit = settings.DEEP_THINKER_TEXT_LIMIT
        plan_name = "Institutional"
    elif effective_plan == DEEP_THINKER_PLAN:
        limit = settings.DEEP_THINKER_TEXT_LIMIT
        plan_name = "Deep Thinker"
    elif effective_plan == THINKER_LITE_PLAN:
        limit = settings.THINKER_LITE_TEXT_LIMIT
        plan_name = "Thinker Lite"

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


async def _uses_claude(user: User | None, db: AsyncSession) -> bool:
    """Returns True for plans that should use Claude-backed rendering."""
    return await has_high_tier_entitlement(db, user)


@router.post("", response_model=ReformatResponse)
async def reformat_page(
    request: Request,
    body: ReformatRequest,
    db: AsyncSession = Depends(get_db),
):
    # ── 1. Identify user ─────────────────────────────────────────
    user = await _get_optional_user(request, db)

    # ── 1.5 Validate Input Length ────────────────────────────────
    await _validate_input_length(db, user, body.page_text)

    # ── 2. Rate limit check ───────────────────────────────────────
    await check_rate_limit(db, user, body.fingerprint, request)

    # ── 3. Load cognitive profile ─────────────────────────────────
    if body.profile:
        # User (anonymous or auth) provided a profile in the request
        profile = body.profile.model_dump()
    elif user:
        # Authenticated user - load from DB
        result = await db.execute(
            select(CognitiveProfile).where(CognitiveProfile.user_id == user.id)
        )
        profile_row = result.scalar_one_or_none()
        profile = {
            "profile_type":         profile_row.profile_type if profile_row else "load-reducer",
            "preferred_format":     profile_row.preferred_format if profile_row else "bullet points",
            "chunk_size":           profile_row.chunk_size if profile_row else "short",
            "needs_examples_first": profile_row.needs_examples_first if profile_row else True,
            "simplify_vocab":       profile_row.simplify_vocab if profile_row else False,
            "max_nesting_depth":    profile_row.max_nesting_depth if profile_row else 2,
            "use_headers":          profile_row.use_headers if profile_row else True,
            "notes":                profile_row.notes if profile_row else "",
        }
    else:
        # Fallback default
        profile = CognitiveProfileSchema().model_dump()

    # ── 4. Load recent feedback for prompt context ────────────────
    feedback_entries = []
    if user:
        result = await db.execute(
            select(FeedbackLog)
            .where(FeedbackLog.user_id == user.id)
            .order_by(FeedbackLog.created_at.desc())
            .limit(20)
        )
        rows = result.scalars().all()
        feedback_entries = [
            {
                "reaction": r.reaction,
                "time_spent_seconds": r.time_spent_seconds,
                "read_progress": r.read_progress,
                "session_difficulty": r.session_difficulty,
            }
            for r in rows
        ]

    feedback_summary = build_feedback_summary(feedback_entries)

    # ── 5. Apply session difficulty override ──────────────────────
    if body.session_difficulty == "hard":
        profile["chunk_size"] = "short"
        profile["simplify_vocab"] = True
        feedback_summary += "\nUser reported a hard reading day. Simplify aggressively."

    # ── 6. Call AI + SQ4R in parallel ────────────────────────────
    use_claude = await _uses_claude(user, db)

    if use_claude:
        html_task = call_claude(body.page_text, profile, feedback_summary)
    else:
        html_task = call_gemini(body.page_text, profile, feedback_summary)

    questions_task = generate_sq4r_questions(
        body.page_text, profile["profile_type"]
    )

    try:
        html, questions = await asyncio.gather(html_task, questions_task)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI service error: {str(e)}")

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
        model_used="claude-sonnet" if use_claude else "gemini-flash",
    )


@router.post("/analyse-sections", response_model=AnalyseSectionsResponse)
async def analyse_sections_route(
    request: Request,
    body: AnalyseSectionsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Identify logical sections on a page."""
    user = await _get_optional_user(request, db)
    await _validate_input_length(db, user, body.page_text)
    await check_rate_limit(db, user, body.fingerprint, request)
    
    from app.services.ai import analyse_sections
    sections = await analyse_sections(body.page_text)
    return AnalyseSectionsResponse(sections=sections)


@router.post("/reformat-document", response_model=ReformatResponse)
async def reformat_document_route(
    request: Request,
    body: DocumentReformatRequest,
    db: AsyncSession = Depends(get_db),
):
    """Process and reformat a document (PDF, image)."""
    user = await _get_optional_user(request, db)
    await _validate_input_length(db, user, body.base64_data)
    await check_rate_limit(db, user, body.fingerprint, request)
    
    # ── Load profile ─────────────────────────────────────────────
    if body.profile:
        profile = body.profile.model_dump()
    elif user:
        result = await db.execute(select(CognitiveProfile).where(CognitiveProfile.user_id == user.id))
        profile_row = result.scalar_one_or_none()
        profile = {
            "profile_type": profile_row.profile_type if profile_row else "load-reducer",
            "preferred_format": profile_row.preferred_format if profile_row else "bullet points",
            "chunk_size": profile_row.chunk_size if profile_row else "short",
            "needs_examples_first": profile_row.needs_examples_first if profile_row else True,
            "simplify_vocab": profile_row.simplify_vocab if profile_row else False,
            "max_nesting_depth": profile_row.max_nesting_depth if profile_row else 2,
            "use_headers": profile_row.use_headers if profile_row else True,
            "notes": profile_row.notes if profile_row else "",
        }
    else:
        profile = CognitiveProfileSchema().model_dump()

    # ── Load feedback ────────────────────────────────────────────
    feedback_entries = []
    if user:
        result = await db.execute(
            select(FeedbackLog)
            .where(FeedbackLog.user_id == user.id)
            .order_by(FeedbackLog.created_at.desc())
            .limit(20)
        )
        feedback_entries = [
            {"reaction": r.reaction, "time_spent_seconds": r.time_spent_seconds, "read_progress": r.read_progress, "session_difficulty": r.session_difficulty}
            for r in result.scalars().all()
        ]

    feedback_summary = build_feedback_summary(feedback_entries)
    
    if body.session_difficulty == "hard":
        profile["chunk_size"] = "short"
        profile["simplify_vocab"] = True
        feedback_summary += "\nUser reported a hard reading day. Simplify aggressively."

    use_claude = await _uses_claude(user, db)
    
    from app.services.ai import call_document
    html = await call_document(
        body.base64_data,
        body.media_type,
        profile,
        feedback_summary,
        use_claude=use_claude
    )
    
    return ReformatResponse(
        html=html,
        questions=None,
        model_used="claude-sonnet" if use_claude else "gemini-flash"
    )
