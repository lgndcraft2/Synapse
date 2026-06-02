from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.models.models import User, CognitiveProfile, FeedbackLog, ReadingSession
from app.schemas.schemas import ReformatRequest, ReformatResponse
from app.services.rate_limit import check_rate_limit
from app.services.ai import (
    call_gemini, call_claude,
    generate_sq4r_questions,
    build_feedback_summary
)
import asyncio

router = APIRouter(prefix="/reformat", tags=["reformat"])


@router.post("", response_model=ReformatResponse)
async def reformat(
    body: ReformatRequest,
    db: AsyncSession = Depends(get_db),
    # User is optional — anonymous free-tier users hit this too
    current_user: User | None = Depends(
        lambda credentials=None, db=None: None  # override below
    ),
):
    """
    Core proxy endpoint. The Chrome extension calls this instead of
    hitting Claude/Gemini directly — keeps API keys off the client.

    Flow:
    1. Identify user (authenticated or anonymous via fingerprint)
    2. Check rate limit
    3. Load cognitive profile + recent feedback
    4. Call Gemini (free) or Claude (premium)
    5. Fire SQ4R question generation in parallel
    6. Return HTML + questions
    """
    # Re-resolve current_user properly (optional auth)
    from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
    from fastapi import Request
    pass


# Separate implementation using proper optional auth
from fastapi import Request
from jose import jwt, JWTError
from app.core.config import settings


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


router2 = APIRouter(prefix="/reformat", tags=["reformat"])


@router2.post("", response_model=ReformatResponse)
async def reformat_page(
    request: Request,
    body: ReformatRequest,
    db: AsyncSession = Depends(get_db),
):
    # ── 1. Identify user ─────────────────────────────────────────
    user = await _get_optional_user(request, db)

    # ── 2. Rate limit check ───────────────────────────────────────
    await check_rate_limit(db, user, body.fingerprint)

    # ── 3. Load cognitive profile ─────────────────────────────────
    if user:
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
        # Anonymous user — use default profile
        profile = {
            "profile_type": "load-reducer",
            "preferred_format": "bullet points",
            "chunk_size": "short",
            "needs_examples_first": True,
            "simplify_vocab": False,
            "max_nesting_depth": 2,
            "use_headers": True,
            "notes": "",
        }

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
    is_premium = user and user.plan in ("premium", "institutional")

    if is_premium:
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
        model_used="claude-sonnet" if is_premium else "gemini-flash",
    )
