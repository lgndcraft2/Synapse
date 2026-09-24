"""Small, aggregate-only operations observer for configured administrators."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.db.database import get_db
from app.models.models import Billing, ReadingSession, SupportTicket, User
from app.services.observability import telemetry

router = APIRouter(prefix="/observer", tags=["observer"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _require_observer(current_user: User = Depends(get_current_user)) -> User:
    if current_user.email.lower() not in settings.admin_emails:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorised to view the observer panel.",
        )
    return current_user


@router.get("/overview")
async def overview(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_observer),
):
    """Return a seven-day operational snapshot without exposing user content."""
    now = _now()
    day_start = now - timedelta(hours=24)
    week_start = (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now - timedelta(days=30)

    total_users = await db.scalar(select(func.count(User.id))) or 0
    new_users_24h = await db.scalar(
        select(func.count(User.id)).where(User.created_at >= day_start)
    ) or 0
    active_users_30d = await db.scalar(
        select(func.count(func.distinct(ReadingSession.user_id))).where(
            ReadingSession.created_at >= month_start
        )
    ) or 0
    total_sessions = await db.scalar(select(func.count(ReadingSession.id))) or 0
    sessions_24h = await db.scalar(
        select(func.count(ReadingSession.id)).where(ReadingSession.created_at >= day_start)
    ) or 0
    active_subscriptions = await db.scalar(
        select(func.count(Billing.id)).where(Billing.status.in_(("active", "trialing")))
    ) or 0
    open_tickets = await db.scalar(
        select(func.count(SupportTicket.id)).where(SupportTicket.status == "open")
    ) or 0

    sessions_by_day_rows = await db.execute(
        select(
            func.date(ReadingSession.created_at).label("day"),
            func.count(ReadingSession.id).label("count"),
        )
        .where(ReadingSession.created_at >= week_start)
        .group_by(func.date(ReadingSession.created_at))
        .order_by(func.date(ReadingSession.created_at))
    )
    sessions_by_day = {str(day): int(count) for day, count in sessions_by_day_rows.all()}

    traffic = []
    for offset in range(6, -1, -1):
        day = (now - timedelta(days=offset)).date()
        traffic.append({"date": day.isoformat(), "sessions": sessions_by_day.get(day.isoformat(), 0)})

    return {
        "generated_at": now.isoformat(),
        "metrics": {
            "total_users": int(total_users),
            "new_users_24h": int(new_users_24h),
            "active_users_30d": int(active_users_30d),
            "total_sessions": int(total_sessions),
            "sessions_24h": int(sessions_24h),
            "active_subscriptions": int(active_subscriptions),
            "open_tickets": int(open_tickets),
        },
        "traffic": traffic,
        "runtime": telemetry.snapshot(),
    }
