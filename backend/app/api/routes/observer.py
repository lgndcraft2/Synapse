"""Privacy-preserving operational tooling for configured Synapse administrators."""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import String, case, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.db.database import get_db
from app.models.models import (
    AIUsageEvent,
    AdminAuditLog,
    Billing,
    CognitiveProfile,
    FeedbackLog,
    ProfileHistory,
    ReadingSession,
    SupportTicket,
    UsageTracking,
    User,
)
from app.services.observability import telemetry

stripe.api_key = settings.STRIPE_SECRET_KEY
router = APIRouter(prefix="/observer", tags=["observer"])

_PROFILE_DEFAULTS = {
    "profile_type": "load-reducer",
    "preferred_format": "bullet points",
    "chunk_size": "short",
    "needs_examples_first": True,
    "simplify_vocab": False,
    "max_nesting_depth": 2,
    "use_headers": True,
    "notes": "",
}


class TierUpdate(BaseModel):
    plan: str = Field(pattern="^(free|lite|premium|institutional)$")


class StripeRefund(BaseModel):
    payment_intent_id: str = Field(min_length=5, max_length=255)
    reason: str = Field(default="requested_by_customer", pattern="^(duplicate|fraudulent|requested_by_customer)$")
    confirm: bool = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _require_observer(current_user: User = Depends(get_current_user)) -> User:
    if current_user.email.lower() not in settings.admin_emails:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorised to view the observer panel.",
        )
    return current_user


def _estimate_cost(provider: str, input_chars: int, output_chars: int) -> float:
    """Convert the intentionally rough 4-char/token estimate using operator rates."""
    input_tokens = input_chars / 4
    output_tokens = output_chars / 4
    if provider == "claude":
        return round(
            (input_tokens * settings.CLAUDE_INPUT_USD_PER_MILLION
             + output_tokens * settings.CLAUDE_OUTPUT_USD_PER_MILLION) / 1_000_000,
            6,
        )
    return round(
        (input_tokens * settings.GEMINI_INPUT_USD_PER_MILLION
         + output_tokens * settings.GEMINI_OUTPUT_USD_PER_MILLION) / 1_000_000,
        6,
    )


def _costs_configured() -> bool:
    return any((
        settings.GEMINI_INPUT_USD_PER_MILLION,
        settings.GEMINI_OUTPUT_USD_PER_MILLION,
        settings.CLAUDE_INPUT_USD_PER_MILLION,
        settings.CLAUDE_OUTPUT_USD_PER_MILLION,
    ))


def _profile_state(profile: CognitiveProfile) -> dict:
    return {field: getattr(profile, field) for field in _PROFILE_DEFAULTS}


def _audit(db: AsyncSession, actor: User, target_user_id: uuid.UUID | None, action: str, metadata: dict) -> None:
    # Metadata is deliberately structural: IDs, plans, Stripe object IDs and
    # result flags only. Never place email, reading material or feedback notes here.
    db.add(AdminAuditLog(
        actor_user_id=actor.id,
        target_user_id=target_user_id,
        action=action,
        metadata_json=metadata,
    ))


async def _target_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


@router.get("/overview")
async def overview(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_observer),
):
    """Return aggregate health and product signals without source/generated text."""
    now = _now()
    day_start = now - timedelta(hours=24)
    week_start = (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now - timedelta(days=30)

    total_users = await db.scalar(select(func.count(User.id))) or 0
    new_users_24h = await db.scalar(select(func.count(User.id)).where(User.created_at >= day_start)) or 0
    active_users_30d = await db.scalar(
        select(func.count(func.distinct(ReadingSession.user_id))).where(ReadingSession.created_at >= month_start)
    ) or 0
    total_sessions = await db.scalar(select(func.count(ReadingSession.id))) or 0
    sessions_24h = await db.scalar(select(func.count(ReadingSession.id)).where(ReadingSession.created_at >= day_start)) or 0
    active_subscriptions = await db.scalar(
        select(func.count(Billing.id)).where(Billing.status.in_(("active", "trialing")), Billing.plan.in_(("lite", "premium")))
    ) or 0
    failed_payments = await db.scalar(select(func.count(Billing.id)).where(Billing.status.in_(("past_due", "unpaid", "incomplete")))) or 0
    open_tickets = await db.scalar(select(func.count(SupportTicket.id)).where(SupportTicket.status == "open")) or 0

    session_rows = await db.execute(
        select(func.date(ReadingSession.created_at).label("day"), func.count(ReadingSession.id).label("count"))
        .where(ReadingSession.created_at >= week_start)
        .group_by(func.date(ReadingSession.created_at)).order_by(func.date(ReadingSession.created_at))
    )
    sessions_by_day = {str(day): int(count) for day, count in session_rows.all()}
    traffic = [
        {"date": (now - timedelta(days=offset)).date().isoformat(), "sessions": sessions_by_day.get((now - timedelta(days=offset)).date().isoformat(), 0)}
        for offset in range(6, -1, -1)
    ]

    profile_rows = await db.execute(
        select(CognitiveProfile.profile_type, func.count(CognitiveProfile.id))
        .group_by(CognitiveProfile.profile_type).order_by(CognitiveProfile.profile_type)
    )
    feedback_rows = await db.execute(
        select(func.coalesce(FeedbackLog.reaction, "unrated"), func.count(FeedbackLog.id))
        .group_by(func.coalesce(FeedbackLog.reaction, "unrated"))
        .order_by(func.count(FeedbackLog.id).desc())
    )
    profiles_changed_30d = await db.scalar(
        select(func.count(func.distinct(ProfileHistory.user_id))).where(ProfileHistory.changed_at >= month_start)
    ) or 0

    usage_rows = await db.execute(
        select(
            AIUsageEvent.provider,
            func.count(AIUsageEvent.id),
            func.coalesce(func.sum(AIUsageEvent.input_characters), 0),
            func.coalesce(func.sum(AIUsageEvent.output_characters), 0),
            func.coalesce(func.avg(AIUsageEvent.duration_ms), 0),
            func.coalesce(func.sum(case((AIUsageEvent.succeeded.is_(False), 1), else_=0)), 0),
        )
        .where(AIUsageEvent.created_at >= week_start)
        .group_by(AIUsageEvent.provider).order_by(AIUsageEvent.provider)
    )
    provider_usage = []
    for provider, calls, input_chars, output_chars, average_ms, failures in usage_rows.all():
        provider_usage.append({
            "provider": provider,
            "calls": int(calls),
            "estimated_input_tokens": round(int(input_chars) / 4),
            "estimated_output_tokens": round(int(output_chars) / 4),
            "estimated_cost_usd": _estimate_cost(provider, int(input_chars), int(output_chars)),
            "average_duration_ms": round(float(average_ms), 1),
            "failures": int(failures),
        })

    return {
        "generated_at": now.isoformat(),
        "metrics": {
            "total_users": int(total_users), "new_users_24h": int(new_users_24h),
            "active_users_30d": int(active_users_30d), "total_sessions": int(total_sessions),
            "sessions_24h": int(sessions_24h), "active_subscriptions": int(active_subscriptions),
            "failed_payments": int(failed_payments), "open_tickets": int(open_tickets),
        },
        "traffic": traffic,
        "runtime": telemetry.snapshot(),
        "product_insights": {
            "profile_distribution": [{"profile_type": label, "users": int(count)} for label, count in profile_rows.all()],
            "feedback_reactions": [{"reaction": label, "count": int(count)} for label, count in feedback_rows.all()],
            "profiles_changed_30d": int(profiles_changed_30d),
            "content_qa": {
                "retention": "not_retained",
                "detail": "Source pages and generated cards are not stored; inspect success, failure and feedback trends instead.",
            },
        },
        "ai_usage": {
            "window": "last 7 days", "scope": "primary reformat calls recorded after this deployment",
            "costs_configured": _costs_configured(), "providers": provider_usage,
        },
        "redis": {
            "queue_status": "not_configured",
            "detail": "Redis currently backs rate limits and quotas; Synapse has no Redis job queue to report depth or failures for.",
        },
    }


@router.get("/users")
async def list_users(
    search: str = Query(default="", max_length=120),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_observer),
):
    """Page through operational account data; no reading pages, notes or tokens."""
    usage_total = (
        select(func.coalesce(func.sum(UsageTracking.lifetime_requests), 0))
        .where(UsageTracking.user_id == User.id).correlate(User).scalar_subquery()
    )
    stmt = (
        select(User, Billing, CognitiveProfile, usage_total.label("lifetime_requests"))
        .outerjoin(Billing, Billing.user_id == User.id)
        .outerjoin(CognitiveProfile, CognitiveProfile.user_id == User.id)
    )
    if search.strip():
        needle = f"%{search.strip()}%"
        stmt = stmt.where(or_(User.email.ilike(needle), cast(User.id, String).ilike(needle)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (await db.execute(stmt.order_by(User.created_at.desc()).offset(offset).limit(limit))).all()
    user_ids = [user.id for user, *_ in rows]
    usage_by_user: dict[uuid.UUID, dict[str, int]] = {}
    if user_ids:
        day_start = _now() - timedelta(hours=24)
        usage_rows = await db.execute(
            select(AIUsageEvent.user_id, AIUsageEvent.provider, func.count(AIUsageEvent.id))
            .where(AIUsageEvent.user_id.in_(user_ids), AIUsageEvent.created_at >= day_start)
            .group_by(AIUsageEvent.user_id, AIUsageEvent.provider)
        )
        for tracked_user_id, provider, calls in usage_rows.all():
            usage_by_user.setdefault(tracked_user_id, {})[provider] = int(calls)
    return {
        "data": [
            {
                "id": str(user.id), "email": user.email, "name": user.name,
                "plan": user.plan, "signup_at": user.created_at.isoformat(),
                "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
                "profile_status": "configured" if profile else "missing",
                "profile_type": profile.profile_type if profile else None,
                "lifetime_requests": int(lifetime_requests or 0),
                "ai_usage_24h": usage_by_user.get(user.id, {}),
                "rate_limit_status": "flagged" if (lifetime_requests or 0) >= settings.FREE_LIFETIME_LIMIT else "normal",
                "billing": {
                    "plan": billing.plan, "status": billing.status,
                    "renews_at": billing.renews_at.isoformat() if billing.renews_at else None,
                    "cancel_at_period_end": billing.cancel_at_period_end,
                    "has_stripe_subscription": bool(billing.stripe_subscription_id),
                } if billing else None,
            }
            for user, billing, profile, lifetime_requests in rows
        ],
        "total": int(total), "has_more": offset + limit < total,
    }


@router.patch("/users/{user_id}/tier")
async def update_tier(
    user_id: uuid.UUID,
    body: TierUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(_require_observer),
):
    """Set local access entitlement only; Stripe subscriptions are never changed here."""
    user = await _target_user(db, user_id)
    billing = await db.scalar(select(Billing).where(Billing.user_id == user.id))
    old_plan = user.plan
    user.plan = body.plan
    user.updated_at = datetime.utcnow()
    if billing:
        billing.plan = body.plan
        billing.status = "active" if body.plan != "free" else "active"
        billing.updated_at = datetime.utcnow()
    else:
        db.add(Billing(user_id=user.id, plan=body.plan, status="active"))
    _audit(db, actor, user.id, "tier_updated", {"from": old_plan, "to": body.plan, "stripe_unchanged": True})
    await db.flush()
    return {"id": str(user.id), "plan": user.plan, "message": "Local entitlement updated. Stripe was not changed."}


@router.post("/users/{user_id}/reset-profile")
async def reset_profile(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(_require_observer),
):
    user = await _target_user(db, user_id)
    profile = await db.scalar(select(CognitiveProfile).where(CognitiveProfile.user_id == user.id))
    if profile:
        previous = _profile_state(profile)
        for field, value in _PROFILE_DEFAULTS.items():
            setattr(profile, field, value)
        profile.updated_at = datetime.utcnow()
    else:
        previous = {}
        profile = CognitiveProfile(user_id=user.id, **_PROFILE_DEFAULTS)
        db.add(profile)
    db.add(ProfileHistory(
        user_id=user.id, change_summary="Profile reset by an administrator.",
        previous_state=previous, new_state=_PROFILE_DEFAULTS.copy(),
    ))
    _audit(db, actor, user.id, "profile_reset", {"profile_created": not bool(previous)})
    await db.flush()
    return {"id": str(user.id), "message": "Cognitive profile reset to defaults."}


@router.post("/users/{user_id}/cancel-subscription")
async def cancel_subscription(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(_require_observer),
):
    """Schedule a real Stripe cancellation at the current period end."""
    user = await _target_user(db, user_id)
    billing = await db.scalar(select(Billing).where(Billing.user_id == user.id))
    if not billing or not billing.stripe_subscription_id:
        raise HTTPException(status_code=400, detail="This user has no Stripe subscription to cancel.")
    try:
        subscription = await asyncio.to_thread(
            stripe.Subscription.modify, billing.stripe_subscription_id, cancel_at_period_end=True,
        )
    except stripe.error.StripeError as exc:
        raise HTTPException(status_code=400, detail=f"Stripe could not schedule the cancellation: {exc.user_message or 'unknown error'}")
    billing.cancel_at_period_end = bool(subscription.get("cancel_at_period_end"))
    billing.cancelled_at = datetime.utcnow()
    billing.updated_at = datetime.utcnow()
    _audit(db, actor, user.id, "subscription_cancel_scheduled", {"subscription_id": billing.stripe_subscription_id})
    await db.flush()
    return {"id": str(user.id), "cancel_at_period_end": billing.cancel_at_period_end}


@router.post("/users/{user_id}/refund")
async def refund_payment(
    user_id: uuid.UUID,
    body: StripeRefund,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(_require_observer),
):
    """Refund one explicit Stripe PaymentIntent after a UI confirmation."""
    user = await _target_user(db, user_id)
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Set confirm to true to create a Stripe refund.")
    try:
        refund = await asyncio.to_thread(stripe.Refund.create, payment_intent=body.payment_intent_id, reason=body.reason)
    except stripe.error.StripeError as exc:
        raise HTTPException(status_code=400, detail=f"Stripe could not create the refund: {exc.user_message or 'unknown error'}")
    _audit(db, actor, user.id, "refund_created", {"payment_intent_id": body.payment_intent_id, "refund_id": refund.get("id"), "reason": body.reason})
    await db.flush()
    return {"id": str(user.id), "refund_id": refund.get("id"), "status": refund.get("status")}


@router.get("/audit-log")
async def audit_log(
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_observer),
):
    rows = await db.execute(select(AdminAuditLog).order_by(AdminAuditLog.created_at.desc()).limit(limit))
    return {"data": [
        {"id": str(entry.id), "at": entry.created_at.isoformat(), "action": entry.action,
         "actor_user_id": str(entry.actor_user_id) if entry.actor_user_id else None,
         "target_user_id": str(entry.target_user_id) if entry.target_user_id else None,
         "metadata": entry.metadata_json}
        for entry in rows.scalars().all()
    ]}
