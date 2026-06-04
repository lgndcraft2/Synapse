from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.models.models import User, CognitiveProfile, ProfileHistory, FeedbackLog, ReadingSession
from app.schemas.schemas import ProfileOut, ProfileUpdate, FeedbackBatch, DashboardStats, SessionOut
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
        change_summary="User manually updated profile settings.",
        previous_state=previous_state,
        new_state=new_state,
    )
    db.add(history)

    return profile


@profile_router.get("/history")
async def get_profile_history(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(ProfileHistory)
        .where(ProfileHistory.user_id == current_user.id)
        .order_by(ProfileHistory.changed_at.desc())
        .limit(20)
    )
    history = result.scalars().all()
    return [
        {
            "changed_at": h.changed_at,
            "change_summary": h.change_summary,
            "previous_state": h.previous_state,
            "new_state": h.new_state,
        }
        for h in history
    ]


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

    # Recent sessions
    result = await db.execute(
        select(ReadingSession)
        .where(ReadingSession.user_id == current_user.id)
        .order_by(ReadingSession.created_at.desc())
        .limit(10)
    )
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
