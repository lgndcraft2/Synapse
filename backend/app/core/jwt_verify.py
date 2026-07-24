"""
Supabase JWT verification.

Supabase projects using the newer "JWT Signing Keys" feature issue access
tokens signed with an asymmetric algorithm (ES256/RS256) and a `kid` header.
These cannot be verified with the legacy shared secret. To support both, we:

  1. Read the token's unverified header to learn its `alg` and `kid`.
  2. For asymmetric tokens, fetch the project's JWKS (public keys), cache them
     by `kid`, and verify with the matching public key.
  3. For HS256 tokens (legacy / self-signed), fall back to the shared
     SUPABASE_JWT_SECRET.

Verified claims are returned as a dict; any failure raises jose.JWTError so
callers can translate it into a 401.
"""

import time
import asyncio

import httpx
from jose import jwt
from jose.exceptions import JWTError

from app.core.config import settings

# Public keys are long-lived; refresh hourly (and on an unknown `kid`, which is
# how key rotation shows up).
_JWKS_TTL_SECONDS = 3600
_JWKS_URL = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"

_AUDIENCE = "authenticated"
_ASYMMETRIC_ALGS = ("ES256", "RS256")

_jwks_by_kid: dict[str, dict] = {}
_jwks_fetched_at: float = 0.0
_jwks_lock = asyncio.Lock()


async def _refresh_jwks() -> None:
    global _jwks_by_kid, _jwks_fetched_at
    async with _jwks_lock:
        # Another coroutine may have refreshed while we waited for the lock.
        if _jwks_by_kid and (time.monotonic() - _jwks_fetched_at) < _JWKS_TTL_SECONDS:
            return
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(_JWKS_URL)
            resp.raise_for_status()
            keys = resp.json().get("keys", [])
        _jwks_by_kid = {k["kid"]: k for k in keys if "kid" in k}
        _jwks_fetched_at = time.monotonic()


async def _get_signing_key(kid: str) -> dict:
    """Return the JWK for `kid`, refreshing the cache if it's missing or stale."""
    fresh = (time.monotonic() - _jwks_fetched_at) < _JWKS_TTL_SECONDS
    if kid not in _jwks_by_kid or not fresh:
        await _refresh_jwks()
    key = _jwks_by_kid.get(kid)
    if key is None:
        # Possible key rotation since our last fetch — force one more refresh.
        await _refresh_jwks()
        key = _jwks_by_kid.get(kid)
    if key is None:
        raise JWTError(f"No signing key found for kid={kid}")
    return key


async def verify_supabase_jwt(token: str) -> dict:
    """
    Verify a Supabase access token and return its claims.

    Raises jose.JWTError (or a subclass) on any validation failure.
    """
    header = jwt.get_unverified_header(token)
    alg = header.get("alg")

    if alg in _ASYMMETRIC_ALGS:
        kid = header.get("kid")
        if not kid:
            raise JWTError("Asymmetric token missing 'kid' header")
        key = await _get_signing_key(kid)
        return jwt.decode(token, key, algorithms=[alg], audience=_AUDIENCE)

    if alg == "HS256":
        return jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience=_AUDIENCE,
        )

    raise JWTError(f"Unsupported token algorithm: {alg}")
