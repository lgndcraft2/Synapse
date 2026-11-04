from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, select, func, and_, case
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.timeutils import as_aware
from app.models.models import (
    AIUsageEvent, User, CognitiveProfile, ProfileHistory, FeedbackLog, ReadingSession,
    SiteActivity, ViewerOpen,
)
from app.services.ai import effective_reaction
from app.schemas.schemas import (
    ProfileOut, ProfileUpdate, FeedbackBatch, DashboardStats, SessionOut, SiteUsage, SiteUsageCleared,
    UsageDay, UsageStats, UsageTotals, Page,
)
from datetime import datetime, timedelta, timezone

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


def _profile_state(profile: CognitiveProfile) -> dict:
    """The fields recorded in profile history, before and after a change."""
    return {field: getattr(profile, field) for field in _FIELD_LABELS}


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
    previous_state = _profile_state(profile)

    # Apply updates
    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(profile, field, value)
    profile.updated_at = datetime.utcnow()

    new_state = _profile_state(profile)

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
            reexplain_path=",".join(entry.reexplain_path) if entry.reexplain_path else None,
        )
        db.add(log)

    await db.flush()
    profile_update = await _adapt_profile(db, current_user)
    return {"ok": True, "logged": len(body.entries), "profile_update": profile_update}


# Consistent feedback nudges the saved profile one step. Only reactions given
# since the last profile change count, so each change (manual or automatic)
# starts a fresh window and one streak can't move the profile twice.
ADAPT_WINDOW = 10
ADAPT_MIN_REACTIONS = 4
ADAPT_SHARE = 0.6

_CHUNK_SIMPLER = {"long": "medium", "medium": "short"}
_CHUNK_RICHER = {"short": "medium", "medium": "long"}


def _step_simpler(profile: CognitiveProfile) -> None:
    if profile.chunk_size in _CHUNK_SIMPLER:
        profile.chunk_size = _CHUNK_SIMPLER[profile.chunk_size]
    elif not profile.simplify_vocab:
        profile.simplify_vocab = True
    elif profile.max_nesting_depth > 1:
        profile.max_nesting_depth -= 1


def _step_richer(profile: CognitiveProfile) -> None:
    if profile.simplify_vocab:
        profile.simplify_vocab = False
    elif profile.chunk_size in _CHUNK_RICHER:
        profile.chunk_size = _CHUNK_RICHER[profile.chunk_size]
    elif profile.max_nesting_depth < 3:
        profile.max_nesting_depth += 1


async def _adapt_profile(db: AsyncSession, user: User) -> dict | None:
    """Move the profile one step when recent reactions clearly point one way.

    Returns {"message", "profile"} when it changed something, else None.
    """
    since = await db.scalar(
        select(func.max(ProfileHistory.changed_at)).where(ProfileHistory.user_id == user.id)
    )
    query = (
        select(FeedbackLog.reaction, FeedbackLog.reexplain_path)
        .where(FeedbackLog.user_id == user.id, FeedbackLog.reaction.is_not(None))
        .order_by(FeedbackLog.created_at.desc())
        .limit(ADAPT_WINDOW)
    )
    if since is not None:
        query = query.where(FeedbackLog.created_at > since)
    # "Clearer" on a version reached by re-explaining counts in that direction.
    reactions = [effective_reaction(r, path) for r, path in (await db.execute(query)).all()]
    if len(reactions) < ADAPT_MIN_REACTIONS:
        return None

    share = lambda r: reactions.count(r) / len(reactions)  # noqa: E731
    if share("complex") >= ADAPT_SHARE:
        step, direction = _step_simpler, "simpler"
    elif share("simple") >= ADAPT_SHARE:
        step, direction = _step_richer, "more detailed"
    else:
        return None

    profile = await db.scalar(
        select(CognitiveProfile).where(CognitiveProfile.user_id == user.id)
    )
    if profile is None:
        return None

    previous_state = _profile_state(profile)
    step(profile)
    new_state = _profile_state(profile)
    if new_state == previous_state:
        return None  # already at the end of the scale
    profile.updated_at = datetime.utcnow()

    summary = "Adjusted from your feedback: " + _summarise_changes(previous_state, new_state)
    db.add(ProfileHistory(
        user_id=user.id,
        change_summary=summary,
        previous_state=previous_state,
        new_state=new_state,
    ))
    await db.flush()
    return {
        "message": f"Your recent feedback said explanations should be {direction}. {summary}",
        "profile": new_state,
    }


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


_TOP_SITES = 8

# ai_usage_events.operation -> (the UsageTotals field, the UsageDay field).
# SQ4R questions run behind a reformat, so they aren't an action of their own.
_USAGE_OPERATIONS = {
    "explain_text": ("highlights", "explains"),
    "explain_image": ("circles", "explains"),
    "respond_text": ("responds", "responds"),
    "respond_image": ("responds", "responds"),
    "reformat": ("reformats", "reformats"),
    "document_reformat": ("documents", "reformats"),
}


@stats_router.get("/usage", response_model=UsageStats)
async def get_usage_stats(
    days: int = Query(30, ge=1, le=90),
    # Minutes east of UTC, so hours and days read in the viewer's own time.
    tz_offset: int = Query(0, ge=-840, le=840),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What the caller did with Synapse: counts, peak hours and top sites.

    Failed calls aren't counted. Grouped here rather than in SQL because the
    buckets depend on the viewer's offset and the tests run on SQLite; the
    window is short and ix_ai_usage_events_user_created serves the read.
    """
    offset = timedelta(minutes=tz_offset)
    today = (datetime.now(timezone.utc) + offset).date()
    first_day = today - timedelta(days=days - 1)
    since = datetime(first_day.year, first_day.month, first_day.day, tzinfo=timezone.utc) - offset

    rows = (await db.execute(
        select(AIUsageEvent.created_at, AIUsageEvent.operation, AIUsageEvent.source).where(
            AIUsageEvent.user_id == current_user.id,
            AIUsageEvent.succeeded.is_(True),
            AIUsageEvent.created_at >= since,
            AIUsageEvent.operation.in_(_USAGE_OPERATIONS),
        )
    )).all()

    totals = dict.fromkeys(UsageTotals.model_fields, 0)
    daily = {
        first_day + timedelta(days=i): {"explains": 0, "responds": 0, "reformats": 0}
        for i in range(days)
    }
    hours = [0] * 24
    weekdays = [0] * 7
    sources = {"page": 0, "pdf": 0, "document": 0}
    for created_at, operation, source in rows:
        local = as_aware(created_at) + offset
        total_field, day_field = _USAGE_OPERATIONS[operation]
        totals[total_field] += 1
        if local.date() in daily:
            daily[local.date()][day_field] += 1
        hours[local.hour] += 1
        weekdays[local.weekday()] += 1
        sources[source or "page"] += 1

    totals["pdf_opens"] = await db.scalar(
        select(func.count()).select_from(ViewerOpen).where(
            ViewerOpen.user_id == current_user.id, ViewerOpen.created_at >= since,
        )
    ) or 0

    sites = (await db.execute(
        select(SiteActivity)
        .where(SiteActivity.user_id == current_user.id)
        .order_by(
            (SiteActivity.explains + SiteActivity.responds + SiteActivity.reformats).desc(),
            SiteActivity.last_used_at.desc(),
        )
        .limit(_TOP_SITES)
    )).scalars().all()

    return UsageStats(
        days=days,
        totals=UsageTotals(**totals),
        daily=[UsageDay(day=day, **counts) for day, counts in daily.items()],
        hours=hours,
        weekdays=weekdays,
        sources=sources,
        top_sites=[
            SiteUsage(
                hostname=site.hostname, explains=site.explains, responds=site.responds,
                reformats=site.reformats, last_used_at=as_aware(site.last_used_at),
            )
            for site in sites
        ],
    )


@stats_router.delete("/usage/sites", response_model=SiteUsageCleared)
async def clear_site_usage(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Forget which sites the caller has used Synapse on."""
    result = await db.execute(delete(SiteActivity).where(SiteActivity.user_id == current_user.id))
    await db.flush()
    return SiteUsageCleared(deleted=result.rowcount or 0)


@stats_router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # One pass over reading_sessions instead of three.
    #
    # These were three separate queries with overlapping predicates — all
    # filtered to the same user, two to the same 30-day window — so the table
    # was scanned three times to produce numbers that fall out of a single
    # grouped aggregate. CASE rather than FILTER so the expression is portable
    # to SQLite, which the test suite runs on.
    in_week = case((ReadingSession.created_at >= week_ago, ReadingSession.cards_generated), else_=0)
    result = await db.execute(
        select(
            func.coalesce(func.sum(in_week), 0),
            func.coalesce(func.sum(ReadingSession.cards_generated), 0),
            func.count(ReadingSession.id),
        ).where(and_(
            ReadingSession.user_id == current_user.id,
            ReadingSession.created_at >= month_ago,
        ))
    )
    cards_week, cards_month, pages_visited = result.one()

    # Words processed estimate (avg 250 words per card)
    words_processed = int(cards_month) * 250

    # Time saved estimate (avg 2 min per card)
    time_saved_minutes = int(cards_month) * 2

    # Recent sessions. Kept on this aggregate for existing callers even though
    # the dashboard list now reads the paged /dashboard/sessions route.
    result = await db.execute(_sessions_query(current_user.id).limit(10))
    recent_sessions = result.scalars().all()

    # Feedback breakdown, read the way the adaptive loop reads it: "clearer"
    # on a version reached by re-explaining counts as "complex" (asked for it
    # simpler) or "simple" (asked for more detail). "off-topic" is no longer
    # offered and is left out.
    result = await db.execute(
        select(FeedbackLog.reaction, FeedbackLog.reexplain_path, func.count(FeedbackLog.id))
        .where(FeedbackLog.user_id == current_user.id)
        .group_by(FeedbackLog.reaction, FeedbackLog.reexplain_path)
    )
    breakdown: dict[str, int] = {}
    for reaction, path, count in result.fetchall():
        effective = effective_reaction(reaction, path)
        if effective in ("clearer", "complex", "simple"):
            breakdown[effective] = breakdown.get(effective, 0) + count

    return DashboardStats(
        cards_this_week=int(cards_week),
        cards_this_month=int(cards_month),
        pages_visited=pages_visited,
        words_processed=words_processed,
        time_saved_minutes=time_saved_minutes,
        recent_sessions=recent_sessions,
        feedback_breakdown=breakdown,
    )
