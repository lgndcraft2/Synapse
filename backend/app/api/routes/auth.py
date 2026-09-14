from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from app.db.database import get_db
from app.models.models import User, CognitiveProfile, Billing
from app.schemas.schemas import UserOut
from app.core.dependencies import get_current_user, get_token_payload
from app.core.config import settings
from supabase import create_client
from datetime import datetime
from sqlalchemy.exc import IntegrityError
import asyncio
import logging

logger = logging.getLogger("synapse.auth")

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
        user.updated_at = datetime.utcnow()

    return user


@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.delete("/account", status_code=204)
async def delete_account(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Permanently deletes the caller's account.

    Order matters: cancel billing first so deletion can never strand a paying
    subscription, then remove the local rows, then the Supabase auth user. If
    the auth user survived, the next sign-in would silently recreate the
    account via /auth/sync.
    """
    import stripe

    stripe.api_key = settings.STRIPE_SECRET_KEY

    # ── 1. Cancel any live Stripe subscription ────────────────────────
    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if billing and billing.stripe_subscription_id:
        try:
            await asyncio.to_thread(stripe.Subscription.delete, billing.stripe_subscription_id)
        except stripe.error.StripeError as e:
            # Never delete the account while money is still owed on it — the
            # user would have no way left to stop the charges.
            raise HTTPException(
                status_code=400,
                detail=(
                    "We could not cancel your subscription, so your account was not "
                    f"deleted. Please cancel it first. ({e.user_message or 'Stripe error'})"
                ),
            )

    supabase_uid = current_user.supabase_uid
    user_id = current_user.id

    # ── 2. Delete the local rows ──────────────────────────────────────
    # cognitive_profiles, profile_history, reading_sessions, feedback_log and
    # billing all declare ON DELETE CASCADE; usage_tracking.user_id is SET NULL
    # by design, so abuse counters survive the account.
    #
    # This is a Core DELETE on purpose. db.delete(current_user) would make the
    # ORM "de-associate" the children by nulling their user_id first — which
    # the NOT NULL constraint rejects — because the relationships do not set
    # passive_deletes. Issuing the statement directly lets the database apply
    # the cascade the schema already declares.
    await db.execute(delete(User).where(User.id == user_id))
    await db.flush()

    # ── 3. Delete the Supabase auth user ──────────────────────────────
    if supabase_uid:
        try:
            await asyncio.to_thread(supabase.auth.admin.delete_user, supabase_uid)
        except Exception as e:
            # The local data is already gone and the transaction commits on
            # clean exit; surfacing a 500 here would wrongly suggest nothing
            # happened. Log loudly instead so the orphan can be swept up.
            logger.error(
                "Deleted local account %s but could not remove Supabase user %s: %s",
                user_id, supabase_uid, e,
            )

    return None
