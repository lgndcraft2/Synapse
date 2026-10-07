"""
Explain-specific limits: a burst cap for everyone and a circled-image quota.

Text explains are charged through the existing `check_rate_limit`, so one
highlight costs exactly one reformat. Images are costlier to send to a model,
so they get a separate counter instead of draining the reformat quota:

  * free and anonymous: FREE_IMAGE_DAILY_LIMIT per UTC day
  * Thinker Lite:       LITE_IMAGE_MONTHLY_LIMIT per calendar month
  * premium and institutional: unlimited (still counted, for the usage meter)

Re-explains get EXPLAIN_FREE_REEXPLAINS_PER_DAY free per caller per UTC day;
after that they are charged like any other explain.

Like `check_rate_limit`, everything here fails OPEN on a Redis error. A
limiter outage must not take explaining down with it.

The client is read through the `rate_limit` module at call time rather than
imported by name, so there is exactly one Redis client to configure (or to
replace in tests).
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
import hashlib
import logging

from fastapi import HTTPException, Request, status
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.request_utils import client_ip
from app.models.models import User
from app.services import rate_limit as rl
from app.services.rate_limit import _active_paid_plan

logger = logging.getLogger("synapse.explain_limits")

_BURST_WINDOW_SECONDS = 60
_MONTH_TTL_SECONDS = 60 * 60 * 24 * 32


@dataclass
class ImageUsage:
    """What one image explain consumed, for the response and for a refund.

    `used` is None when Redis was unavailable and the request was let through
    uncounted. `limit` and `period` are None for unlimited plans.
    """
    used: int | None
    limit: int | None
    period: str | None
    keys: list[str] = field(default_factory=list)


def _caller_identity(user: User | None, fingerprint: str | None, request: Request) -> str:
    """Per-user bucket, or a hashed IP+fingerprint bucket for anonymous callers."""
    if user:
        return f"user:{user.id}"
    raw_id = f"{client_ip(request)}:{fingerprint or 'none'}"
    return f"anon:{hashlib.sha256(raw_id.encode()).hexdigest()[:16]}"


def _seconds_until_utc_midnight(now: datetime) -> int:
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int((tomorrow - now).total_seconds()))


def _seconds_until_next_month(now: datetime) -> int:
    first_next = (now.replace(day=1) + timedelta(days=32)).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    return max(1, int((first_next - now).total_seconds()))


async def _incr_with_ttl(key: str, ttl: int) -> int:
    count = await rl.redis_client.incr(key)
    if count == 1:
        await rl.redis_client.expire(key, ttl)
    return count


async def _undo(keys: list[str]) -> None:
    """Best-effort decrement, used for over-limit rejections and refunds."""
    for key in keys:
        try:
            await rl.redis_client.decr(key)
        except RedisError as e:
            logger.warning("Could not release explain counter (%s).", e)


async def check_explain_burst(
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> None:
    """At most EXPLAIN_BURST_PER_MINUTE explains per minute, for every tier."""
    key = f"rl:explain:burst:{_caller_identity(user, fingerprint, request)}"
    try:
        count = await _incr_with_ttl(key, _BURST_WINDOW_SECONDS)
        if count <= settings.EXPLAIN_BURST_PER_MINUTE:
            return
        retry_after = await rl.redis_client.ttl(key)
        if retry_after is None or retry_after < 0:
            # The EXPIRE after the first INCR was lost; without a TTL this key
            # would block the caller forever.
            await rl.redis_client.expire(key, _BURST_WINDOW_SECONDS)
            retry_after = _BURST_WINDOW_SECONDS
    except RedisError as e:
        logger.warning("Explain burst limiter degraded — Redis unavailable (%s). Allowing request.", e)
        return

    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "code": "EXPLAIN_BURST",
            "message": "You're explaining things very quickly. Please wait a moment and try again.",
        },
        headers={"Retry-After": str(retry_after)},
    )


async def reserve_image_capture(
    db: AsyncSession,
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> ImageUsage:
    """Count one circled-image explain against the caller's image quota.

    Raises 429 IMAGE_LIMIT when the quota is spent. The returned usage carries
    the keys that were incremented so a failed AI call can refund them.
    """
    plan = await _active_paid_plan(db, user) if user else None
    now = datetime.utcnow()

    if plan in ("premium", "institutional", "lite"):
        keys = [f"rl:img:month:user:{user.id}:{now.strftime('%Y%m')}"]
        limit = settings.LITE_IMAGE_MONTHLY_LIMIT if plan == "lite" else None
        period = "month" if plan == "lite" else None
        ttl = _MONTH_TTL_SECONDS
        retry_after = _seconds_until_next_month(now)
        ip_key = None
    else:
        identity = _caller_identity(user, fingerprint, request)
        keys = [f"rl:img:day:{identity}:{now.strftime('%Y%m%d')}"]
        limit = settings.FREE_IMAGE_DAILY_LIMIT
        period = "day"
        ttl = retry_after = _seconds_until_utc_midnight(now)
        # Rotating the fingerprint would otherwise mint a fresh anonymous
        # quota; mirror the reformat limiter's per-IP guard at twice the cap.
        ip_key = None if user else f"rl:img:day:ip:{client_ip(request)}:{now.strftime('%Y%m%d')}"

    try:
        used = await _incr_with_ttl(keys[0], ttl)
        over = limit is not None and used > limit
        if ip_key and not over:
            keys.append(ip_key)
            over = await _incr_with_ttl(ip_key, ttl) > limit * 2
    except RedisError as e:
        logger.warning("Image capture limiter degraded — Redis unavailable (%s). Allowing request.", e)
        return ImageUsage(used=None, limit=limit, period=period)

    if over:
        # Rejected requests don't consume quota, so the meter stays truthful.
        await _undo(keys)
        noun = "today" if period == "day" else "this month"
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "IMAGE_LIMIT",
                "message": f"You've used all {limit} image explains {noun}.",
                "limit": limit,
                "period": period,
            },
            headers={"Retry-After": str(retry_after)},
        )

    return ImageUsage(used=used, limit=limit, period=period, keys=keys)


async def refund_image_capture(usage: ImageUsage) -> None:
    """Give back an image unit after the AI call failed. Best effort."""
    await _undo(usage.keys)
    usage.keys = []


@dataclass
class FreeReexplain:
    """A free re-explain taken from today's allowance.

    `remaining` is None when Redis was unavailable (the re-explain is let
    through free, like every other limiter here failing open).
    """
    remaining: int | None
    keys: list[str] = field(default_factory=list)


async def take_free_reexplain(
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> FreeReexplain | None:
    """One free re-explain from today's allowance, or None when it is spent.

    None means the caller pays: the route then charges the re-explain like a
    normal explain.
    """
    now = datetime.utcnow()
    limit = settings.EXPLAIN_FREE_REEXPLAINS_PER_DAY
    key = f"rl:reexplain:day:{_caller_identity(user, fingerprint, request)}:{now.strftime('%Y%m%d')}"
    try:
        used = await _incr_with_ttl(key, _seconds_until_utc_midnight(now))
    except RedisError as e:
        logger.warning("Re-explain allowance degraded — Redis unavailable (%s). Treating as free.", e)
        return FreeReexplain(remaining=None)
    if used > limit:
        # Paid from here on; leave the counter where it is so the answer stays
        # "none left" for the rest of the day.
        return None
    return FreeReexplain(remaining=limit - used, keys=[key])


async def refund_free_reexplain(free: FreeReexplain) -> None:
    """Give a free re-explain back after the AI call failed. Best effort."""
    await _undo(free.keys)
    free.keys = []
    if free.remaining is not None:
        free.remaining += 1
