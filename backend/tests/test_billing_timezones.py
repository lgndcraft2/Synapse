"""
Paid-plan checks must accept the timezone-aware renews_at Postgres returns.

They compared it with naive datetime.utcnow(), which raises TypeError, so
every reformat and explain by a Lite or Deep Thinker subscriber was a 500.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes.billing import _plan_for_subscription
from app.api.routes.reformat import _is_premium_active, _validate_input_length
from app.core.config import settings
from app.services.rate_limit import _active_paid_plan

FUTURE_AWARE = datetime.now(timezone.utc) + timedelta(days=10)
PAST_AWARE = datetime.now(timezone.utc) - timedelta(days=1)
FUTURE_NAIVE = datetime.utcnow() + timedelta(days=10)


class FakeDB:
    """Just enough AsyncSession for a single `select(Billing)` lookup."""

    def __init__(self, billing):
        self.billing = billing

    async def execute(self, _query):
        return SimpleNamespace(scalar_one_or_none=lambda: self.billing)


def _user(plan):
    return SimpleNamespace(id="u1", plan=plan)


def _billing(plan, renews_at, status="active"):
    return SimpleNamespace(plan=plan, status=status, renews_at=renews_at)


@pytest.mark.parametrize("renews_at", [FUTURE_AWARE, FUTURE_NAIVE, None])
async def test_premium_check_accepts_aware_and_naive(renews_at):
    db = FakeDB(_billing("premium", renews_at))
    assert await _is_premium_active(_user("premium"), db) is True


async def test_premium_check_lapses_after_renews_at():
    db = FakeDB(_billing("premium", PAST_AWARE))
    assert await _is_premium_active(_user("premium"), db) is False


async def test_length_limit_uses_paid_tier_with_aware_renews_at():
    db = FakeDB(_billing("lite", FUTURE_AWARE))
    text = "x" * (settings.FREE_TEXT_LIMIT + 1)
    # Over the free limit but within Lite's: allowed, and no TypeError.
    await _validate_input_length(db, _user("lite"), text)


async def test_length_limit_falls_back_to_free_once_lapsed():
    db = FakeDB(_billing("lite", PAST_AWARE))
    with pytest.raises(HTTPException) as exc:
        await _validate_input_length(db, _user("lite"), "x" * (settings.FREE_TEXT_LIMIT + 1))
    assert exc.value.detail["code"] == "LENGTH_EXCEEDED"


@pytest.mark.parametrize("renews_at, expected", [(FUTURE_AWARE, "lite"), (PAST_AWARE, None)])
async def test_rate_limit_paid_plan_with_aware_renews_at(renews_at, expected):
    db = FakeDB(_billing("lite", renews_at))
    assert await _active_paid_plan(db, _user("lite")) == expected


def test_plan_for_subscription_lapsed_is_free():
    assert _plan_for_subscription({}, "active", PAST_AWARE) == "free"
    assert _plan_for_subscription({}, "active", datetime.utcnow() - timedelta(days=1)) == "free"
