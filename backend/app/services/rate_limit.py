import redis.asyncio as aioredis
from redis.exceptions import RedisError
import httpx
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
class UpstashRestRedis:
    """The small async Redis surface this app needs over Upstash's HTTPS API.

    Upstash's `https://...upstash.io` endpoint is a REST endpoint, not a
    `redis://` socket URI. It therefore cannot be passed to redis-py. Sending
    commands as JSON also keeps JSON OAuth handoff payloads out of a URL path.
    """

    def __init__(self, url: str, token: str, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            base_url=url.rstrip("/") + "/",
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(5.0, connect=5.0),
        )
        self._owns_client = client is None

    async def _command(self, *parts: object):
        try:
            response = await self._client.post("", json=list(parts))
        except httpx.HTTPError as exc:
            raise RedisError(f"Upstash REST request failed: {exc}") from exc

        if response.status_code >= 400:
            raise RedisError(f"Upstash REST returned HTTP {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise RedisError("Upstash REST returned an invalid response") from exc

        if not isinstance(payload, dict):
            raise RedisError("Upstash REST returned an unexpected response")
        if payload.get("error"):
            raise RedisError(f"Upstash REST error: {payload['error']}")
        return payload.get("result")

    async def get(self, key: str):
        return await self._command("GET", key)

    async def incr(self, key: str):
        return int(await self._command("INCR", key))

    async def expire(self, key: str, seconds: int):
        return int(await self._command("EXPIRE", key, seconds))

    async def ttl(self, key: str):
        return int(await self._command("TTL", key))

    async def delete(self, key: str):
        return int(await self._command("DEL", key))

    async def setex(self, key: str, seconds: int, value: str):
        return await self._command("SETEX", key, seconds, value)

    async def getdel(self, key: str):
        return await self._command("GETDEL", key)

    async def aclose(self):
        if self._owns_client:
            await self._client.aclose()


def _create_redis_client():
    if settings.UPSTASH_REDIS_URL.startswith(("https://", "http://")):
        return UpstashRestRedis(settings.UPSTASH_REDIS_URL, settings.UPSTASH_REDIS_TOKEN)

    # Native Redis URLs remain supported for local Redis and deployments that
    # use Upstash's TCP connection string instead of its REST credentials.
    return aioredis.from_url(
        settings.UPSTASH_REDIS_URL,
        password=settings.UPSTASH_REDIS_TOKEN,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
        health_check_interval=30,
        retry_on_timeout=True,
    )


redis_client = _create_redis_client()


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
            detail="Free tier lifetime limit reached.",
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
