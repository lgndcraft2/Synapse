from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plans import (
    ACTIVE_PAID_PLANS,
    DEEP_THINKER_PLAN,
    FREE_PLAN,
    INSTITUTIONAL_PLAN,
    THINKER_LITE_PLAN,
    normalize_plan,
)
from app.models.models import Billing, User


def _billing_is_active(billing: Billing | None) -> bool:
    return bool(
        billing
        and billing.status in ("active", "trialing")
        and (billing.renews_at is None or billing.renews_at > datetime.utcnow())
    )


async def get_effective_plan(db: AsyncSession, user: User | None) -> str:
    if not user:
        return FREE_PLAN

    user_plan = normalize_plan(user.plan)
    if user_plan == INSTITUTIONAL_PLAN:
        return INSTITUTIONAL_PLAN

    result = await db.execute(
        select(Billing).where(Billing.user_id == user.id)
    )
    billing = result.scalar_one_or_none()

    if not _billing_is_active(billing):
        return FREE_PLAN

    billing_plan = normalize_plan(billing.plan)
    if billing_plan in ACTIVE_PAID_PLANS:
        return billing_plan

    return FREE_PLAN


async def has_paid_entitlement(db: AsyncSession, user: User | None) -> bool:
    plan = await get_effective_plan(db, user)
    return plan in ACTIVE_PAID_PLANS or plan == INSTITUTIONAL_PLAN


async def has_high_tier_entitlement(db: AsyncSession, user: User | None) -> bool:
    return (await get_effective_plan(db, user)) in (DEEP_THINKER_PLAN, INSTITUTIONAL_PLAN)
