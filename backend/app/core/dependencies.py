from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import datetime
from app.core.config import settings
from app.core.plans import normalize_plan, ACTIVE_PAID_PLANS, INSTITUTIONAL_PLAN
from app.db.database import get_db
from app.models.models import User

bearer_scheme = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Validates the Supabase JWT from the Authorization header.
    Returns the User ORM object or raises 401.
    """
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        supabase_uid: str = payload.get("sub")
        if supabase_uid is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    result = await db.execute(
        select(User).where(User.supabase_uid == supabase_uid)
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise credentials_exception

    normalized_plan = normalize_plan(user.plan)
    if normalized_plan != user.plan:
        user.plan = normalized_plan
        user.updated_at = datetime.utcnow()

    return user


async def get_token_payload(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    Validates the Supabase JWT and returns the payload.
    Does NOT check if the user exists in the local database.
    """
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        if payload.get("sub") is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing sub claim",
            )
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )


async def get_premium_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """Dependency that requires the user to be on a paid or institutional plan."""
    normalized_plan = normalize_plan(current_user.plan)
    if normalized_plan not in ACTIVE_PAID_PLANS and normalized_plan != INSTITUTIONAL_PLAN:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="This feature requires a paid plan.",
        )
    return current_user
