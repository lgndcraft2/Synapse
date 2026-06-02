from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.models.models import User, CognitiveProfile, Billing
from app.schemas.schemas import UserOut
from app.core.dependencies import get_current_user
from app.core.config import settings
from supabase import create_client
from datetime import datetime

router = APIRouter(prefix="/auth", tags=["auth"])

supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


@router.post("/callback", response_model=UserOut)
async def auth_callback(
    db: AsyncSession = Depends(get_db),
    current_user_raw: dict = None,
):
    """
    Called after Supabase Google OAuth completes on the frontend.
    The frontend exchanges the OAuth code for a Supabase session,
    then calls this endpoint with the JWT. We upsert the user into
    our own users table so we can attach profiles, billing etc.

    Frontend flow:
    1. User clicks "Sign in with Google"
    2. Supabase handles OAuth redirect
    3. Frontend gets session token from Supabase
    4. Frontend calls POST /auth/callback with Bearer token
    5. This endpoint upserts user → returns UserOut
    """
    pass  # implemented via the dependency below


@router.post("/me", response_model=UserOut)
async def upsert_me(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Called on app load after login. Returns the current user.
    Creates the user record if it doesn't exist yet (first login).
    """
    return current_user


@router.post("/sync", response_model=UserOut)
async def sync_user_from_supabase(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """
    Upserts a user from Supabase Auth data.
    Called by the frontend after successful Google OAuth.

    Expected payload:
    {
        "supabase_uid": "uuid",
        "email": "user@example.com",
        "name": "Alex",
        "avatar_url": "https://..."
    }
    """
    supabase_uid = payload.get("supabase_uid")
    email = payload.get("email")

    if not supabase_uid or not email:
        raise HTTPException(status_code=400, detail="supabase_uid and email are required.")

    # Check if user exists
    result = await db.execute(
        select(User).where(User.supabase_uid == supabase_uid)
    )
    user = result.scalar_one_or_none()

    if user is None:
        # First login — create user + default profile + billing record
        user = User(
            email=email,
            name=payload.get("name"),
            avatar_url=payload.get("avatar_url"),
            supabase_uid=supabase_uid,
            plan="free",
        )
        db.add(user)
        await db.flush()

        # Default cognitive profile
        profile = CognitiveProfile(
            user_id=user.id,
            profile_type="load-reducer",
            preferred_format="bullet points",
            chunk_size="short",
            needs_examples_first=True,
            simplify_vocab=False,
            max_nesting_depth=2,
            use_headers=True,
            notes="",
        )
        db.add(profile)

        # Default billing record
        billing = Billing(
            user_id=user.id,
            plan="free",
            status="active",
        )
        db.add(billing)
        await db.flush()
    else:
        # Update name/avatar in case they changed in Google
        user.name = payload.get("name", user.name)
        user.avatar_url = payload.get("avatar_url", user.avatar_url)
        user.updated_at = datetime.utcnow()

    return user


@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user
