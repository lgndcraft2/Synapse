import hashlib
from datetime import datetime, timedelta

import redis.asyncio as aioredis
from fastapi import HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.entitlements import get_effective_plan
from app.core.plans import DEEP_THINKER_PLAN, FREE_PLAN, INSTITUTIONAL_PLAN, THINKER_LITE_PLAN
from app.models.models import UsageTracking, User

# Redis client (Upstash)
redis_client = aioredis.from_url(
    settings.UPSTASH_REDIS_URL,
    decode_responses=True,
)


async def check_rate_limit(
    db: AsyncSession,
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> None:
    """
    Enforces plan-aware rate limits.

    Free users keep the current daily and lifetime protection.
    Thinker Lite gets a monthly quota and the same abuse detection.
    Deep Thinker and institutional users bypass hard limits.
    """

    plan = FREE_PLAN
    if user:
        plan = await get_effective_plan(db, user)

    if plan in (DEEP_THINKER_PLAN, INSTITUTIONAL_PLAN):
        return

    if user and plan == THINKER_LITE_PLAN:
        monthly_key = f"rl:monthly:user:{user.id}"
        monthly_count = await redis_client.incr(monthly_key)

        now = datetime.utcnow()
        next_month_year = now.year + (1 if now.month == 12 else 0)
        next_month = datetime(next_month_year, 1 if now.month == 12 else now.month + 1, 1)
        seconds_until_reset = int((next_month - now).total_seconds())

        if monthly_count == 1:
            await redis_client.expire(monthly_key, seconds_until_reset)

        if monthly_count > settings.THINKER_LITE_MONTHLY_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Monthly limit of {settings.THINKER_LITE_MONTHLY_LIMIT} requests reached.",
                headers={"Retry-After": str(seconds_until_reset)},
            )

        await _record_usage_tracking(db, str(user.id), user, enforce_lifetime_limit=False)
        return

    if user:
        daily_key = f"rl:daily:user:{user.id}"
        lifetime_identifier = str(user.id)
    else:
        client_ip = request.client.host
        raw_id = f"{client_ip}:{fingerprint or 'none'}"
        hashed_id = hashlib.sha256(raw_id.encode()).hexdigest()[:16]
        daily_key = f"rl:daily:anon:{hashed_id}"
        lifetime_identifier = f"anon:{hashed_id}"

        ip_daily_key = f"rl:daily:ip:{client_ip}"
        ip_daily_count = await redis_client.get(ip_daily_key)
        if ip_daily_count and int(ip_daily_count) > settings.FREE_DAILY_LIMIT * 2:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests from this IP address today.",
            )

    daily_count = await redis_client.incr(daily_key)

    now = datetime.utcnow()
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    seconds_until_midnight = int((tomorrow - now).total_seconds())

    if daily_count == 1:
        await redis_client.expire(daily_key, seconds_until_midnight)

    if daily_count > settings.FREE_DAILY_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily limit of {settings.FREE_DAILY_LIMIT} requests reached.",
            headers={"Retry-After": str(seconds_until_midnight)},
        )

    if not user:
        client_ip = request.client.host
        ip_daily_key = f"rl:daily:ip:{client_ip}"
        ip_count = await redis_client.incr(ip_daily_key)
        if ip_count == 1:
            await redis_client.expire(ip_daily_key, seconds_until_midnight)

    await _record_usage_tracking(db, lifetime_identifier, user, enforce_lifetime_limit=True)


async def _record_usage_tracking(
    db: AsyncSession,
    lifetime_identifier: str,
    user: User | None,
    enforce_lifetime_limit: bool,
) -> None:
    from sqlalchemy.exc import IntegrityError

    result = await db.execute(
        select(UsageTracking).where(UsageTracking.fingerprint == lifetime_identifier)
    )
    tracking = result.scalar_one_or_none()

    if tracking is None:
        async with db.begin_nested():
            try:
                tracking = UsageTracking(
                    fingerprint=lifetime_identifier,
                    user_id=user.id if user else None,
                    lifetime_requests=1,
                    first_seen=datetime.utcnow(),
                    last_seen=datetime.utcnow(),
                )
                db.add(tracking)
                await db.flush()
                return
            except IntegrityError:
                pass

        result = await db.execute(
            select(UsageTracking).where(UsageTracking.fingerprint == lifetime_identifier)
        )
        tracking = result.scalar_one_or_none()
        if not tracking:
            raise HTTPException(status_code=500, detail="Rate limit tracking error.")

    if tracking.flagged_for_abuse:
        raise HTTPException(status_code=403, detail="Account flagged for abuse.")

    if enforce_lifetime_limit and tracking.lifetime_requests >= settings.FREE_LIFETIME_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Free tier lifetime limit reached.",
        )

    await db.execute(
        update(UsageTracking)
        .where(UsageTracking.fingerprint == lifetime_identifier)
        .values(
            lifetime_requests=UsageTracking.lifetime_requests + 1,
            last_seen=datetime.utcnow(),
        )
    )

    abuse_key = f"rl:abuse:{lifetime_identifier}"
    abuse_count = await redis_client.incr(abuse_key)
    if abuse_count == 1:
        await redis_client.expire(abuse_key, 3600)

    if abuse_count > 500:
        await db.execute(
            update(UsageTracking)
            .where(UsageTracking.fingerprint == lifetime_identifier)
            .values(flagged_for_abuse=True)
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Unusual usage pattern detected. Please contact support.",
        )


async def get_cache(key: str) -> str | None:
    """Get a value from Redis cache."""
    return await redis_client.get(key)


async def set_cache(key: str, value: str, ttl: int = 300) -> None:
    """Set a value in Redis cache with TTL in seconds."""
    await redis_client.set(key, value, ex=ttl)
