"""
Cryptographic primitives for first-party auth.

Three separate concerns live here, deliberately using three different
algorithms:

  * **Passwords** — Argon2id. Low-entropy human input, so the hash must be
    deliberately slow and memory-hard.
  * **Access tokens** — HS256 JWT over APP_SECRET_KEY. Stateless, short-lived,
    verified on every request.
  * **Refresh / email tokens** — plain SHA-256. These are 256-bit CSPRNG
    values, so there is no low-entropy secret to brute-force. A slow KDF would
    buy nothing and would cost ~100ms on the hottest auth path in the system,
    and we need an indexed constant-time lookup by hash.

That last point is the one people get wrong in both directions, which is why
it is spelled out rather than left to taste.
"""

import asyncio
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from jose import jwt
from jose.exceptions import JWTError

from app.core.config import settings

# ── Passwords ─────────────────────────────────────────────────────
# 64 MiB / 2 passes is the OWASP baseline. Raising memory_cost is the most
# effective lever if this ever needs hardening; raising parallelism is not,
# since we run one hash per request thread.
_hasher = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=1)

# Verified against when no user exists, or when the account is Google-only and
# therefore has no password_hash. Burning the same CPU either way is what keeps
# login from leaking account existence through response latency. Generated once
# at import over a throwaway value nobody can present.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(32))


async def hash_password(password: str) -> str:
    """
    Argon2id at 64 MiB blocks for ~50-100ms. Called inline from an async route
    it would stall the whole event loop, not just this request, so every call
    goes through a worker thread.
    """
    return await asyncio.to_thread(_hasher.hash, password)


async def verify_password(password: str, password_hash: str | None) -> bool:
    """
    Constant-time with respect to account existence.

    `password_hash=None` means either "no such user" or "Google-only account".
    Both still pay for a full Argon2 verify against the dummy hash before
    returning False. The Google-only case is the one that gets forgotten, and
    it leaks just as much as the missing-user case.
    """
    target = password_hash or _DUMMY_HASH

    def _verify() -> bool:
        try:
            return _hasher.verify(target, password)
        except (VerifyMismatchError, InvalidHashError):
            return False

    ok = await asyncio.to_thread(_verify)
    # A correct password against the dummy hash is not a login.
    return ok and password_hash is not None


def password_needs_rehash(password_hash: str) -> bool:
    """True when the stored hash predates a parameter change."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


# ── Opaque tokens (refresh, email verification, password reset) ───

def new_opaque_token() -> str:
    """256 bits of CSPRNG output, URL-safe."""
    return secrets.token_urlsafe(32)


def hash_opaque_token(raw: str) -> str:
    """
    SHA-256 hex. See the module docstring for why this is not Argon2.

    The digest is what goes in the unique index, so lookup is a single indexed
    equality rather than a scan-and-compare.
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    """Constant-time comparison for any secret compared outside the database."""
    return hmac.compare_digest(a, b)


# ── Access tokens ─────────────────────────────────────────────────

def issue_access_token(user) -> tuple[str, int]:
    """
    Sign a short-lived access token for `user`.

    Returns (token, expires_at_unix).

    The display claims (email/name/avatar_url) exist so the browser extension
    can render its popup without an API round-trip, and so the token and
    TokenResponse.user can never disagree. `plan` is a snapshot and advisory
    only — rate limiting must keep reading Billing from the database, never
    this claim, or a user could hold a stale premium tier for 15 minutes.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS)

    claims = {
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "sub": str(user.id),
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
        "jti": str(uuid.uuid4()),
        "typ": "access",
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "plan": user.plan,
        "email_verified": bool(user.email_verified),
    }
    token = jwt.encode(claims, settings.APP_SECRET_KEY, algorithm="HS256")
    return token, int(expires_at.timestamp())


def decode_access_token(token: str) -> dict:
    """
    Verify an access token and return its claims.

    Raises jose.JWTError (or a subclass) on any failure, matching the contract
    the old Supabase verifier exposed so callers translate it to a 401 the same
    way.
    """
    claims = jwt.decode(
        token,
        settings.APP_SECRET_KEY,
        algorithms=["HS256"],
        audience=settings.JWT_AUDIENCE,
        issuer=settings.JWT_ISSUER,
    )
    # A refresh token must never be accepted as an access token. python-jose
    # does not know about our `typ`, so this check is ours to make.
    if claims.get("typ") != "access":
        raise JWTError("Not an access token")
    return claims


# ── Short-lived signed blobs (the OAuth state cookie) ─────────────

def sign_state_blob(payload: dict, ttl_seconds: int) -> str:
    """
    Sign a small dict so it can ride in a cookie without being forgeable.

    Used for the Google OAuth transaction cookie, which must survive a
    round-trip through accounts.google.com and come back intact. Signing (as
    opposed to a bare random cookie plus server-side storage) means a subdomain
    that can set cookies on the parent domain still cannot forge a valid
    transaction.
    """
    now = datetime.now(timezone.utc)
    claims = {
        **payload,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
    }
    return jwt.encode(claims, settings.APP_SECRET_KEY, algorithm="HS256")


def unsign_state_blob(token: str) -> dict | None:
    """Return the payload, or None if tampered with or expired."""
    try:
        return jwt.decode(token, settings.APP_SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        return None


def pkce_pair() -> tuple[str, str]:
    """
    Return (code_verifier, code_challenge) for PKCE S256.

    On a confidential server-side client the client secret already binds the
    code exchange, so this is belt-and-braces — but it costs three lines and
    defends against an authorization code leaking through access logs or a
    misconfigured proxy.
    """
    import base64

    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge
