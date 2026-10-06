"""
The per-request prompt context every AI route needs: profile and feedback.

Reformat, document reformat and explain all resolve these the same way, so
the logic lives here once instead of being copied into each handler.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import CognitiveProfile, FeedbackLog, User
from app.schemas.schemas import CognitiveProfileSchema, FeedbackEntry
from app.services.ai import build_feedback_summary


async def load_profile(
    db: AsyncSession,
    user: User | None,
    inline_profile: CognitiveProfileSchema | None,
) -> dict:
    """Resolve the cognitive profile to prompt with.

    For authenticated users the server-side profile is the source of truth
    (edited from the dashboard), so it takes precedence over any inline profile
    the client sends. Anonymous callers fall back to the inline profile, then
    to the defaults.
    """
    if user:
        result = await db.execute(
            select(CognitiveProfile).where(CognitiveProfile.user_id == user.id)
        )
        profile_row = result.scalar_one_or_none()
        if profile_row is None and inline_profile:
            return inline_profile.model_dump()
        return {
            "profile_type":         profile_row.profile_type if profile_row else "load-reducer",
            "preferred_format":     profile_row.preferred_format if profile_row else "bullet points",
            "chunk_size":           profile_row.chunk_size if profile_row else "short",
            "needs_examples_first": profile_row.needs_examples_first if profile_row else True,
            "simplify_vocab":       profile_row.simplify_vocab if profile_row else False,
            "max_nesting_depth":    profile_row.max_nesting_depth if profile_row else 2,
            "use_headers":          profile_row.use_headers if profile_row else True,
            "notes":                profile_row.notes if profile_row else "",
        }
    if inline_profile:
        return inline_profile.model_dump()
    return CognitiveProfileSchema().model_dump()


FEEDBACK_WINDOW = 20


async def load_feedback_summary(
    db: AsyncSession,
    user: User | None,
    inline_feedback: list[FeedbackEntry] | None = None,
) -> str:
    """Summarise the caller's most recent feedback for the prompt.

    Signed-in users: the server log is the source of truth. Anonymous callers
    have no server log, so the extension sends its local log (oldest first)
    and that is used instead.
    """
    feedback_entries = []
    if user:
        result = await db.execute(
            select(FeedbackLog)
            .where(FeedbackLog.user_id == user.id)
            .order_by(FeedbackLog.created_at.desc())
            .limit(FEEDBACK_WINDOW)
        )
        feedback_entries = [
            {
                "reaction": r.reaction,
                "note": r.note,
                "time_spent_seconds": r.time_spent_seconds,
                "read_progress": r.read_progress,
                "session_difficulty": r.session_difficulty,
                "section_title": r.section_title,
                "reexplain_path": r.reexplain_path,
            }
            for r in result.scalars().all()
        ]
    elif inline_feedback:
        feedback_entries = [
            e.model_dump(exclude={"session_id"})
            for e in reversed(inline_feedback[-FEEDBACK_WINDOW:])
        ]
    return build_feedback_summary(feedback_entries)


def apply_session_difficulty(profile: dict, feedback_summary: str, difficulty: str) -> str:
    """Apply a "hard day" override in place on `profile`; returns the summary."""
    if difficulty == "hard":
        profile["chunk_size"] = "short"
        profile["simplify_vocab"] = True
        feedback_summary += "\nUser reported a hard reading day. Simplify aggressively."
    return feedback_summary
