import redis.asyncio as aioredis
from fastapi import HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.core.config import settings
from app.models.models import Billing, UsageTracking, User
from datetime import datetime
import hashlib

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
    request: Request,
) -> None:
    """
    Enforces rate limits for free tier users.
    Premium/institutional users bypass all limits.
    Raises HTTP 429 if limit is exceeded.
    """

    # ── Premium users — no limits ─────────────────────────────────
    if user and await _has_active_entitlement(db, user):
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


async def _has_active_entitlement(db: AsyncSession, user: User) -> bool:
    if user.plan == "institutional":
        return True
    if user.plan != "premium":
        return False

    result = await db.execute(select(Billing).where(Billing.user_id == user.id))
    billing = result.scalar_one_or_none()
    if not billing or billing.plan != "premium":
        return False
    if billing.status not in ("active", "trialing"):
        return False
    return billing.renews_at is None or billing.renews_at > datetime.utcnow()
