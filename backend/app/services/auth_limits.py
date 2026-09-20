"""
Rate limiting for the auth endpoints.

Deliberately separate from services/rate_limit.py, which meters AI usage
against a user's plan. This one exists to slow down credential stuffing and
enumeration, so the keys, windows and failure policy are all different.

**Failure policy.** Redis going away must not become a total sign-in outage,
so this fails *open* — but failing open with nothing behind it turns a Redis
blip into an unlimited brute-force window. The compromise is a per-process
in-memory fallback: weaker than Redis (it is per-worker and resets on deploy),
far better than nothing, and no availability cliff. This is a conscious trade,
not an oversight; it is the one place in the codebase where "harden everything"
would make things worse.

Note the OAuth handoff in routes/auth.py takes the opposite line and fails
closed, because without Redis there is no way to mint a session at all.
"""

import hashlib
import logging
import time

from fastapi import HTTPException, status
from redis.exceptions import RedisError

from app.services.rate_limit import redis_client

logger = logging.getLogger("synapse.auth")

# (max_attempts, window_seconds)
LIMITS: dict[str, tuple[int, int]] = {
    "login_ip": (20, 15 * 60),
    "login_email": (5, 15 * 60),
    "register_ip": (5, 3600),
    "forgot_email": (3, 3600),
    "forgot_ip": (10, 3600),
    "verify_user": (5, 3600),
    "refresh_user": (60, 3600),
    "google_ip": (20, 15 * 60),
}

# Per-worker fallback: {key: [count, window_expiry_epoch]}
_fallback: dict[str, list[float]] = {}
_FALLBACK_MAX_KEYS = 10_000


def hash_identifier(value: str) -> str:
    """
    Keys are built from a digest so Redis never holds an email address.

    Rate-limit keys outlive the request and are visible to anyone with Redis
    access; there is no reason for them to be PII.
    """
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()[:32]


def _check_fallback(key: str, limit: int, window: int) -> bool:
    """In-process counter used only while Redis is unreachable."""
    now = time.time()

    # Cheap eviction so a sustained outage cannot grow this without bound.
    if len(_fallback) > _FALLBACK_MAX_KEYS:
        for k in [k for k, v in _fallback.items() if v[1] <= now]:
            _fallback.pop(k, None)
        if len(_fallback) > _FALLBACK_MAX_KEYS:
            _fallback.clear()

    entry = _fallback.get(key)
    if entry is None or entry[1] <= now:
        _fallback[key] = [1, now + window]
        return True
    entry[0] += 1
    return entry[0] <= limit


async def enforce(bucket: str, identifier: str) -> None:
    """
    Count one attempt against `bucket` for `identifier`, or raise 429.

    `identifier` is already-hashed for anything derived from user input.
    """
    limit, window = LIMITS[bucket]
    key = f"auth:{bucket}:{identifier}"

    try:
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, window)
        if count > limit:
            ttl = await redis_client.ttl(key)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Please wait and try again.",
                headers={"Retry-After": str(max(ttl, 1))},
            )
        return
    except RedisError as exc:
        logger.warning(
            "Auth rate limiter degraded — Redis unavailable (%s). "
            "Falling back to per-process counters for %s.",
            exc,
            bucket,
        )

    if not _check_fallback(key, limit, window):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait and try again.",
            headers={"Retry-After": str(window)},
        )


async def clear(bucket: str, identifier: str) -> None:
    """
    Drop a counter after a success.

    Called on successful login so a user who mistypes twice and then gets it
    right is not still carrying two strikes toward a lockout.
    """
    key = f"auth:{bucket}:{identifier}"
    try:
        await redis_client.delete(key)
    except RedisError:
        pass
    _fallback.pop(key, None)
