import redis.asyncio as aioredis
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.core.config import settings
from app.models.models import UsageTracking, User
from datetime import datetime

# ── Redis client (Upstash) ────────────────────────────────────────
redis_client = aioredis.from_url(
    settings.UPSTASH_REDIS_URL,
    password=settings.UPSTASH_REDIS_TOKEN,
    decode_responses=True,
    ssl=True,
)


async def check_rate_limit(
    db: AsyncSession,
    user: User | None,
    fingerprint: str | None,
) -> None:
    """
    Enforces rate limits for free tier users.
    Premium/institutional users bypass all limits.
    Raises HTTP 429 if limit is exceeded.

    Strategy:
    - Daily limit tracked in Redis (TTL = seconds until midnight)
    - Lifetime limit tracked in PostgreSQL
    - Fingerprint used for anonymous users, user_id for authenticated
    """

    # ── Premium users — no limits ─────────────────────────────────
    if user and user.plan in ("premium", "institutional"):
        return

    # ── Build the rate limit key ──────────────────────────────────
    # Prefer user_id for authenticated free users (harder to abuse),
    # fall back to device fingerprint for anonymous users
    if user:
        daily_key = f"rl:daily:user:{user.id}"
        lifetime_identifier = str(user.id)
    elif fingerprint:
        daily_key = f"rl:daily:fp:{fingerprint}"
        lifetime_identifier = fingerprint
    else:
        # No way to identify — block
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit: unable to identify request origin.",
        )

    # ── Daily limit (Redis) ───────────────────────────────────────
    current_daily = await redis_client.get(daily_key)
    daily_count = int(current_daily) if current_daily else 0

    if daily_count >= settings.FREE_DAILY_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily limit of {settings.FREE_DAILY_LIMIT} requests reached. "
                   f"Upgrade to Premium for unlimited access.",
            headers={"Retry-After": "86400"},
        )

    # Increment daily count — TTL of 86400 seconds (24 hours)
    pipe = redis_client.pipeline()
    pipe.incr(daily_key)
    pipe.expire(daily_key, 86400)
    await pipe.execute()

    # ── Lifetime limit (PostgreSQL) ───────────────────────────────
    result = await db.execute(
        select(UsageTracking).where(UsageTracking.fingerprint == lifetime_identifier)
    )
    tracking = result.scalar_one_or_none()

    if tracking is None:
        # First time we've seen this identifier
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

    if tracking.flagged_for_abuse:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been flagged for abuse.",
        )

    if tracking.lifetime_requests >= settings.FREE_LIFETIME_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Free tier lifetime limit of {settings.FREE_LIFETIME_LIMIT} requests reached. "
                   f"Upgrade to Premium for unlimited access.",
        )

    # Increment lifetime count
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
