"""
Request-scoped auth dependencies.

There is exactly one token verifier in the application, and it lives here.
That is not tidiness for its own sake: the previous split — a JWKS-based
verifier in jwt_verify.py used by most routes, and a hand-rolled HS256 decode
inside reformat.py — meant the core /reformat endpoint silently treated every
signed-in user as anonymous, because the project issued ES256 tokens that an
HS256-only decode can never accept. Two verifiers is how that happens.
"""

import uuid

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_access_token
from app.core.timeutils import as_aware
from app.db.database import get_db
from app.models.models import User

bearer_scheme = HTTPBearer()

_CREDENTIALS_EXCEPTION = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid or expired token",
    headers={"WWW-Authenticate": "Bearer"},
)


async def _user_from_token(token: str, db: AsyncSession) -> User | None:
    """
    Resolve a bearer token to a User, or None for any failure.

    Shared by the strict and optional dependencies so there is one definition
    of what a valid caller is.
    """
    try:
        claims = decode_access_token(token)
    except JWTError:
        return None

    subject = claims.get("sub")
    if not subject:
        return None

    try:
        user_id = uuid.UUID(subject)
    except (ValueError, AttributeError, TypeError):
        return None

    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        return None

    # Tokens minted before the password changed are dead, even if unexpired.
    # Refresh tokens are revoked outright at change time; this closes the
    # remaining access-token window without needing a blacklist.
    issued_at = claims.get("iat")
    if user.password_changed_at and issued_at is not None:
        if issued_at < as_aware(user.password_changed_at).timestamp():
            return None

    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Require a signed-in user. 401 otherwise."""
    user = await _user_from_token(credentials.credentials, db)
    if user is None:
        raise _CREDENTIALS_EXCEPTION
    return user


async def get_optional_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """
    Resolve the caller if there is one, without requiring it.

    Used by /reformat and /support, where anonymous access is a supported mode
    rather than an error. A malformed or expired token is treated as anonymous,
    not as a failure — the request still succeeds, just on free-tier terms.
    """
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return await _user_from_token(header.split(" ", 1)[1], db)
