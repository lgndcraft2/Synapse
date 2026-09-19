from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.models.models import User, CognitiveProfile, ProfileHistory, FeedbackLog, ReadingSession
from app.schemas.schemas import ProfileOut, ProfileUpdate, FeedbackBatch, DashboardStats, SessionOut, Page
from datetime import datetime, timedelta
import json

# ── Profile ───────────────────────────────────────────────────────
profile_router = APIRouter(prefix="/profile", tags=["profile"])


@profile_router.get("", response_model=ProfileOut)
async def get_profile(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(CognitiveProfile).where(CognitiveProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return profile


_FIELD_LABELS = {
    "profile_type": "Reading type",
    "preferred_format": "Preferred format",
    "chunk_size": "Chunk size",
    "needs_examples_first": "Examples first",
    "simplify_vocab": "Simplify vocabulary",
    "max_nesting_depth": "Nesting depth",
    "use_headers": "Section headers",
    "notes": "Personal notes",
}


_PROFILE_TYPE_LABELS = {
    "load-reducer": "Load Reducer",
    "comprehension-gap": "Comprehension Gap",
    "hyperfocus": "Hyperfocus Reader",
}


def _display(value, field: str = "") -> str:
    """Render a profile value for the history summary.

    Uses the same friendly names the UI shows, so the summary line and the
    before/after diff rendered beneath it can't disagree.
    """
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None or value == "":
        return "empty"
    if field == "profile_type":
        return _PROFILE_TYPE_LABELS.get(value, str(value))
    return str(value)


def _summarise_changes(previous: dict, new: dict) -> str:
    """Describe what actually changed, rather than that something did.

    The history log is surfaced on the profile page and the dashboard, so a
    per-field summary is what makes it readable. Falls back to the generic
    wording when a patch changes nothing.
    """
    parts = []
    for field, label in _FIELD_LABELS.items():
        before, after = previous.get(field), new.get(field)
        if before == after:
            continue
        if field == "notes":
            # Note bodies are too long to inline; say that they changed.
            parts.append("Personal notes updated" if after else "Personal notes cleared")
        elif isinstance(after, bool):
            parts.append(f"{label} turned {_display(after, field)}")
        else:
            parts.append(f"{label} {_display(before, field)} → {_display(after, field)}")

    if not parts:
        return "No changes were made to your profile settings."
    return "; ".join(parts) + "."


@profile_router.patch("", response_model=ProfileOut)
async def update_profile(
    body: ProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(CognitiveProfile).where(CognitiveProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")

    # Snapshot before update for history
    previous_state = {
        "profile_type": profile.profile_type,
        "preferred_format": profile.preferred_format,
        "chunk_size": profile.chunk_size,
        "needs_examples_first": profile.needs_examples_first,
        "simplify_vocab": profile.simplify_vocab,
        "max_nesting_depth": profile.max_nesting_depth,
        "use_headers": profile.use_headers,
        "notes": profile.notes,
    }

    # Apply updates
    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(profile, field, value)
    profile.updated_at = datetime.utcnow()

    new_state = {
        "profile_type": profile.profile_type,
        "preferred_format": profile.preferred_format,
        "chunk_size": profile.chunk_size,
        "needs_examples_first": profile.needs_examples_first,
        "simplify_vocab": profile.simplify_vocab,
        "max_nesting_depth": profile.max_nesting_depth,
        "use_headers": profile.use_headers,
        "notes": profile.notes,
    }

    # Log the change
    history = ProfileHistory(
        user_id=current_user.id,
        change_summary=_summarise_changes(previous_state, new_state),
        previous_state=previous_state,
        new_state=new_state,
    )
    db.add(history)

    return profile


@profile_router.get("/history")
async def get_profile_history(
    limit: int = 10,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One page of the caller's profile changes, newest first.

    Params are clamped rather than rejected: a hand-edited or stale URL should
    degrade to a sane page, not 422 in the middle of someone's history.
    """
    limit = max(1, min(limit, 50))
    offset = max(0, offset)

    owned = ProfileHistory.user_id == current_user.id

    total = await db.scalar(
        select(func.count()).select_from(ProfileHistory).where(owned)
    ) or 0

    result = await db.execute(
        select(ProfileHistory)
        .where(owned)
        .order_by(ProfileHistory.changed_at.desc())
        .offset(offset)
        .limit(limit)
    )
    history = result.scalars().all()
    return {
        "data": [
            {
                "changed_at": h.changed_at,
                "change_summary": h.change_summary,
                "previous_state": h.previous_state,
                "new_state": h.new_state,
            }
            for h in history
        ],
        "total": total,
        "has_more": offset + len(history) < total,
    }


# ── Feedback ──────────────────────────────────────────────────────
feedback_router = APIRouter(prefix="/feedback", tags=["feedback"])


@feedback_router.post("")
async def submit_feedback(
    body: FeedbackBatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Extension sends feedback batch every N interactions.
    We store each entry and trigger a profile update check.
    """
    for entry in body.entries:
        log = FeedbackLog(
            user_id=current_user.id,
            session_id=entry.session_id,
            reaction=entry.reaction,
            note=entry.note,
            time_spent_seconds=entry.time_spent_seconds,
            read_progress=entry.read_progress,
            session_difficulty=entry.session_difficulty,
            section_title=entry.section_title,
        )
        db.add(log)

    await db.flush()
    return {"ok": True, "logged": len(body.entries)}


# ── Dashboard stats ───────────────────────────────────────────────
stats_router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _sessions_query(user_id):
    """The caller's reading sessions, newest first — shared by the aggregate
    stats payload and the paged sessions list so the two can never drift."""
    return (
        select(ReadingSession)
        .where(ReadingSession.user_id == user_id)
        .order_by(ReadingSession.created_at.desc())
    )


@stats_router.get("/sessions", response_model=Page[SessionOut])
async def list_reading_sessions(
    limit: int = 10,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One page of the caller's reading sessions, newest first."""
    limit = max(1, min(limit, 50))
    offset = max(0, offset)

    total = await db.scalar(
        select(func.count())
        .select_from(ReadingSession)
        .where(ReadingSession.user_id == current_user.id)
    ) or 0

    result = await db.execute(_sessions_query(current_user.id).offset(offset).limit(limit))
    sessions = result.scalars().all()

    return Page[SessionOut](
        data=sessions,
        total=total,
        has_more=offset + len(sessions) < total,
    )


@stats_router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # Cards this week
    result = await db.execute(
        select(func.sum(ReadingSession.cards_generated))
        .where(and_(
            ReadingSession.user_id == current_user.id,
            ReadingSession.created_at >= week_ago
        ))
    )
    cards_week = result.scalar() or 0

    # Cards this month
    result = await db.execute(
        select(func.sum(ReadingSession.cards_generated))
        .where(and_(
            ReadingSession.user_id == current_user.id,
            ReadingSession.created_at >= month_ago
        ))
    )
    cards_month = result.scalar() or 0

    # Pages visited (distinct sessions this month)
    result = await db.execute(
        select(func.count(ReadingSession.id))
        .where(and_(
            ReadingSession.user_id == current_user.id,
            ReadingSession.created_at >= month_ago
        ))
    )
    pages_visited = result.scalar() or 0

    # Words processed estimate (avg 250 words per card)
    words_processed = int(cards_month) * 250

    # Time saved estimate (avg 2 min per card)
    time_saved_minutes = int(cards_month) * 2

    # Recent sessions. Kept on this aggregate for existing callers even though
    # the dashboard list now reads the paged /dashboard/sessions route.
    result = await db.execute(_sessions_query(current_user.id).limit(10))
    recent_sessions = result.scalars().all()

    # Feedback breakdown
    result = await db.execute(
        select(FeedbackLog.reaction, func.count(FeedbackLog.id))
        .where(FeedbackLog.user_id == current_user.id)
        .group_by(FeedbackLog.reaction)
    )
    breakdown = {row[0]: row[1] for row in result.fetchall() if row[0]}

    return DashboardStats(
        cards_this_week=int(cards_week),
        cards_this_month=int(cards_month),
        pages_visited=pages_visited,
        words_processed=words_processed,
        time_saved_minutes=time_saved_minutes,
        recent_sessions=recent_sessions,
        feedback_breakdown=breakdown,
    )
