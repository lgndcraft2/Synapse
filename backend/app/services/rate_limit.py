import redis.asyncio as aioredis
from redis.exceptions import RedisError
from fastapi import HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.core.config import settings
from app.models.models import Billing, UsageTracking, User
from datetime import datetime
import hashlib
import logging

logger = logging.getLogger("synapse.rate_limit")

# ── Redis client (Upstash) ────────────────────────────────────────
# The Upstash URL uses the rediss:// scheme, which already negotiates TLS.
# Do NOT pass ssl=True here: on redis-py 5.x it is forwarded to the connection
# constructor and raises "AbstractConnection.__init__() got an unexpected
# keyword argument 'ssl'" on the first command.
redis_client = aioredis.from_url(
    settings.UPSTASH_REDIS_URL,
    password=settings.UPSTASH_REDIS_TOKEN,
    decode_responses=True,
)


async def check_rate_limit(
    db: AsyncSession,
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> None:
    """
    Enforces rate limits, failing OPEN if Redis is unavailable.

    Rate limiting is a protective feature — if its backing store (Redis) is
    unreachable, we must not take the whole API down. On a Redis error we log a
    warning and allow the request. Genuine 429s (HTTPException) still propagate.
    """
    try:
        await _enforce_rate_limit(db, user, fingerprint, request)
    except RedisError as e:
        logger.warning("Rate limiter degraded — Redis unavailable (%s). Allowing request.", e)


async def _enforce_rate_limit(
    db: AsyncSession,
    user: User | None,
    fingerprint: str | None,
    request: Request,
) -> None:
    """
    Enforces rate limits for free tier users.
    Premium/institutional users bypass all limits.
    Raises HTTP 429 if limit is exceeded.
    """

    # ── Paid users — reduced or no limits ─────────────────────────
    if user:
        entitlement = await _active_paid_plan(db, user)
        if entitlement in ("premium", "institutional"):
            return  # unlimited
        if entitlement == "lite":
            # Thinker Lite: capped monthly reformats, but no daily/lifetime free limits.
            await _enforce_monthly_cap(user)
            return

    # ── Build the rate limit key ──────────────────────────────────
    if user:
        daily_key = f"rl:daily:user:{user.id}"
        lifetime_identifier = str(user.id)
    else:
        client_ip = request.client.host
        raw_id = f"{client_ip}:{fingerprint or 'none'}"
        hashed_id = hashlib.sha256(raw_id.encode()).hexdigest()[:16]
        daily_key = f"rl:daily:anon:{hashed_id}"
        lifetime_identifier = f"anon:{hashed_id}"
        
        # IP-based guard
        ip_daily_key = f"rl:daily:ip:{client_ip}"
        ip_daily_count = await redis_client.get(ip_daily_key)
        if ip_daily_count and int(ip_daily_count) > settings.FREE_DAILY_LIMIT * 2:
             raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests from this IP address today.",
            )

    # ── Daily limit (Redis) ───────────────────────────────────────
    # We increment FIRST and check the result for atomicity
    daily_count = await redis_client.incr(daily_key)
    
    from datetime import timedelta
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

    # Increment IP-based limit for anonymous users
    if not user:
        client_ip = request.client.host
        ip_daily_key = f"rl:daily:ip:{client_ip}"
        ip_count = await redis_client.incr(ip_daily_key)
        if ip_count == 1:
            await redis_client.expire(ip_daily_key, seconds_until_midnight)

    # ── Lifetime limit (PostgreSQL) ───────────────────────────────
    from sqlalchemy.exc import IntegrityError
    
    result = await db.execute(
        select(UsageTracking).where(UsageTracking.fingerprint == lifetime_identifier)
    )
    tracking = result.scalar_one_or_none()

    if tracking is None:
        # Isolated insertion to handle race conditions without session rollback
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
                # Another concurrent request inserted it — catch and proceed to update
                pass
        
        # Refetch the now-existing record
        result = await db.execute(
            select(UsageTracking).where(UsageTracking.fingerprint == lifetime_identifier)
        )
        tracking = result.scalar_one_or_none()
        if not tracking:
            raise HTTPException(status_code=500, detail="Rate limit tracking error.")

    if tracking.flagged_for_abuse:
        raise HTTPException(status_code=403, detail="Account flagged for abuse.")

    if tracking.lifetime_requests >= settings.FREE_LIFETIME_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Free tier lifetime limit reached.",
        )

    # Increment lifetime count (atomic update)
    await db.execute(
        update(UsageTracking)
        .where(UsageTracking.fingerprint == lifetime_identifier)
        .values(
            lifetime_requests=UsageTracking.lifetime_requests + 1,
            last_seen=datetime.utcnow(),
        )
    )

    # ── Abuse detection ───────────────────────────────────────────
    # Flag if this fingerprint made >500 requests in the last hour
    abuse_key = f"rl:abuse:{lifetime_identifier}"
    abuse_count = await redis_client.incr(abuse_key)
    if abuse_count == 1:
        await redis_client.expire(abuse_key, 3600)  # 1 hour window

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


async def _active_paid_plan(db: AsyncSession, user: User) -> str | None:
    """Returns the user's active paid plan tier ("lite"/"premium"/"institutional"),
    or None if the user is free or their subscription has lapsed."""
    if user.plan == "institutional":
        return "institutional"
    if user.plan not in ("lite", "premium"):
        return None

    result = await db.execute(select(Billing).where(Billing.user_id == user.id))
    billing = result.scalar_one_or_none()
    if not billing or billing.plan not in ("lite", "premium"):
        return None
    if billing.status not in ("active", "trialing"):
        return None
    if billing.renews_at is not None and billing.renews_at <= datetime.utcnow():
        return None
    return billing.plan


async def _enforce_monthly_cap(user: User) -> None:
    """Enforce the Thinker Lite monthly reformat cap via a per-month Redis counter."""
    now = datetime.utcnow()
    month_key = f"rl:month:user:{user.id}:{now.strftime('%Y%m')}"
    count = await redis_client.incr(month_key)
    if count == 1:
        # Expire ~1 month later; the key rolls over naturally with the %Y%m suffix.
        await redis_client.expire(month_key, 60 * 60 * 24 * 32)
    if count > settings.LITE_MONTHLY_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Monthly limit of {settings.LITE_MONTHLY_LIMIT} reformats reached. "
                "Upgrade to Deep Thinker for unlimited reformats."
            ),
        )
