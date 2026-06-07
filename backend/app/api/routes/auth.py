from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.models.models import User, CognitiveProfile, Billing
from app.schemas.schemas import UserOut
from app.core.dependencies import get_current_user, get_token_payload
from app.core.config import settings
from app.core.plans import normalize_plan
from supabase import create_client
from datetime import datetime
from sqlalchemy.exc import IntegrityError

router = APIRouter(prefix="/auth", tags=["auth"])

supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


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
    token_payload: dict = Depends(get_token_payload),
):
    """
    Upserts a user from Supabase Auth data.
    Called by the frontend after successful Google OAuth.
    Requires a valid Supabase JWT in the Authorization header.

    Expected body payload:
    {
        "email": "user@example.com",
        "name": "Alex",
        "avatar_url": "https://..."
    }
    Note: supabase_uid is extracted from the JWT token for security.
    """
    supabase_uid = token_payload.get("sub")
    email = payload.get("email") or token_payload.get("email")

    if not email:
        raise HTTPException(status_code=400, detail="Email is required.")

    # 1. Check if user exists
    result = await db.execute(
        select(User).where(User.supabase_uid == supabase_uid)
    )
    user = result.scalar_one_or_none()

    if user is None:
        # First login — attempt to create user + profile + billing record
        # Use a nested transaction to handle concurrent insertion race conditions
        async with db.begin_nested():
            try:
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
            except IntegrityError:
                # Concurrent request already inserted the user
                pass
        
        if not user or not user.id:
            result = await db.execute(
                select(User).where(User.supabase_uid == supabase_uid)
            )
            user = result.scalar_one_or_none()
            if not user:
                raise HTTPException(status_code=500, detail="User sync error.")
    else:
        # Update name/avatar in case they changed in Google
        user.name = payload.get("name", user.name)
        user.avatar_url = payload.get("avatar_url", user.avatar_url)
        # Also sync email if changed
        if user.email != email:
            user.email = email
        current_plan = normalize_plan(user.plan)
        if current_plan == "institutional":
            user.plan = "institutional"
        else:
            result = await db.execute(
                select(Billing).where(Billing.user_id == user.id)
            )
            billing = result.scalar_one_or_none()
            if billing:
                billing_plan = normalize_plan(billing.plan)
                is_active_paid = (
                    billing_plan in ("thinker_lite", "deep_thinker")
                    and billing.status in ("active", "trialing")
                    and (billing.renews_at is None or billing.renews_at > datetime.utcnow())
                )
                if is_active_paid:
                    user.plan = billing_plan
                    if billing_plan != billing.plan:
                        billing.plan = billing_plan
                        billing.updated_at = datetime.utcnow()
                else:
                    user.plan = "free"
                    if billing.plan != "free":
                        billing.plan = "free"
                        billing.updated_at = datetime.utcnow()
            else:
                normalized_plan = normalize_plan(user.plan)
                if normalized_plan != user.plan:
                    user.plan = normalized_plan
        user.updated_at = datetime.utcnow()

    return user


@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user
