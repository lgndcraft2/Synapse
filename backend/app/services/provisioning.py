"""
Creating a user and the rows that must exist alongside one.

This logic used to live inside /auth/sync, which existed only to mirror
Supabase's auth state into our database. The endpoint is gone but the work it
did is still required: a User without a CognitiveProfile row has no profile to
serve, and without a Billing row the entitlement checks in rate_limit.py have
nothing to read.

Both registration paths — password signup and the Google callback — go through
here, so the two can never drift.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Billing, CognitiveProfile, User

logger = logging.getLogger("synapse.auth")


def normalize_email(email: str) -> str:
    """
    Lowercase and strip.

    Email is the login identity, so the normalisation has to be applied on
    every write path. The functional unique index on lower(email) is the
    backstop for the write path somebody forgets.
    """
    return email.strip().lower()


async def find_by_email(db: AsyncSession, email: str) -> User | None:
    """Case-insensitive lookup, matching the functional index."""
    return await db.scalar(
        select(User).where(func.lower(User.email) == normalize_email(email))
    )


async def provision_user(
    db: AsyncSession,
    *,
    email: str,
    name: str | None = None,
    avatar_url: str | None = None,
    password_hash: str | None = None,
    google_id: str | None = None,
    email_verified: bool = False,
) -> User:
    """
    Create a user together with a default profile and billing record.

    The nested transaction guards the case where two requests for the same new
    address arrive together — the unique index on email rejects the loser, and
    we re-read rather than surfacing a 500. This mirrors the race handling the
    old sync endpoint had, which was there for a real reason.
    """
    email = normalize_email(email)
    now = datetime.now(timezone.utc)

    user: User | None = None
    try:
        async with db.begin_nested():
            user = User(
                id=uuid.uuid4(),
                email=email,
                name=name,
                avatar_url=avatar_url,
                password_hash=password_hash,
                google_id=google_id,
                email_verified=email_verified,
                email_verified_at=now if email_verified else None,
                plan="free",
            )
            db.add(user)
            await db.flush()

            db.add(
                CognitiveProfile(
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
            )
            db.add(Billing(user_id=user.id, plan="free", status="active"))
            await db.flush()
    except IntegrityError:
        # Someone else inserted this address between our check and our insert.
        user = None

    if user is None or user.id is None:
        user = await find_by_email(db, email)
        if user is None:
            logger.error("Could not provision or recover user for %s", email)
            raise RuntimeError("User provisioning failed.")

    return user


async def link_google_account(
    db: AsyncSession, user: User, google_id: str, avatar_url: str | None = None
) -> User:
    """
    Attach a Google identity to an existing account.

    Only ever called once the caller has confirmed Google reports the address
    as verified. Linking on an unverified address would let anyone who can
    create a Google account at a given address adopt the matching local one.
    """
    user.google_id = google_id
    if avatar_url and not user.avatar_url:
        user.avatar_url = avatar_url
    if not user.email_verified:
        # Google has just vouched for the address, which is a stronger signal
        # than our own pending verification email.
        user.email_verified = True
        user.email_verified_at = datetime.now(timezone.utc)
    user.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return user
