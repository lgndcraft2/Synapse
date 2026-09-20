"""
Refresh-token lifecycle: issue, rotate, revoke.

The design in one paragraph: a refresh token is an opaque 256-bit value stored
only as a SHA-256 digest. Presenting it marks that row used and returns a
successor in the same `family_id`. Presenting a row that is *already* used
means two parties hold the same secret, so the entire family is revoked — we
cannot tell the thief from the victim, so both are signed out.

Two things make that safe in practice rather than just on paper:

  * `SELECT ... FOR UPDATE` on the lookup. Two concurrent refreshes of the same
    token must serialise, or both read `used_at IS NULL`, both succeed, and the
    loser's successor looks like a replay on its next use.
  * Separate families per client (`web` vs `extension`). The dashboard and the
    browser extension refresh independently; sharing a family would make normal
    operation indistinguishable from the attack.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.request_utils import client_ip
from app.core.timeutils import as_aware, is_past
from app.core.security import (
    hash_opaque_token,
    issue_access_token,
    new_opaque_token,
)
from app.models.models import RefreshToken, User

logger = logging.getLogger("synapse.auth")

WEB = "web"
EXTENSION = "extension"


class RefreshError(Exception):
    """
    A refresh attempt that cannot succeed.

    `code` is surfaced to the client so the SPA and the extension can tell
    "your session ended, sign in again" from "something transient went wrong"
    without string-matching a message.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _request_metadata(request: Request | None) -> tuple[str | None, str | None]:
    """User agent and IP for the audit trail. Never load-bearing for auth."""
    if request is None:
        return None, None
    ua = (request.headers.get("user-agent") or "")[:400] or None
    return ua, client_ip(request)


async def issue_pair(
    db: AsyncSession,
    user: User,
    *,
    client: str = WEB,
    request: Request | None = None,
    family_id: uuid.UUID | None = None,
    family_expires_at: datetime | None = None,
    parent_id: uuid.UUID | None = None,
) -> tuple[str, str, int]:
    """
    Mint an access token and a fresh refresh token.

    Returns (access_token, raw_refresh_token, access_expires_at_unix).

    Starting a new family (no `family_id`) is what login and the OAuth callback
    do. Rotation passes the existing family through so the absolute ceiling
    carries forward rather than resetting on every use.
    """
    now = _now()
    raw = new_opaque_token()
    ua, ip = _request_metadata(request)

    row = RefreshToken(
        user_id=user.id,
        family_id=family_id or uuid.uuid4(),
        parent_id=parent_id,
        token_hash=hash_opaque_token(raw),
        client=client,
        user_agent=ua,
        ip=ip,
        issued_at=now,
        expires_at=now + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS),
        family_expires_at=family_expires_at
        or (now + timedelta(seconds=settings.REFRESH_FAMILY_TTL_SECONDS)),
    )
    db.add(row)
    await db.flush()

    access, access_exp = issue_access_token(user)
    return access, raw, access_exp


async def revoke_family(db: AsyncSession, family_id: uuid.UUID, reason: str) -> None:
    """Kill every live token in a rotation lineage."""
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.family_id == family_id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=_now(), revoked_reason=reason)
    )
    await db.flush()


async def revoke_all_for_user(db: AsyncSession, user_id: uuid.UUID, reason: str) -> None:
    """Sign a user out everywhere — password change, logout-all, deletion."""
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=_now(), revoked_reason=reason)
    )
    await db.flush()


async def revoke_one(db: AsyncSession, raw_refresh: str, reason: str) -> bool:
    """
    Revoke a single token. Returns False if it was unknown or already dead.

    Logout is deliberately forgiving: a client presenting a token we have never
    seen should still end up logged out, not staring at an error.
    """
    row = await db.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == hash_opaque_token(raw_refresh)
        )
    )
    if row is None or row.revoked_at is not None:
        return False
    row.revoked_at = _now()
    row.revoked_reason = reason
    await db.flush()
    return True


async def rotate(
    db: AsyncSession, raw_refresh: str, *, request: Request | None = None
) -> tuple[str, str, int, User]:
    """
    Exchange a refresh token for a new pair.

    Returns (access_token, new_raw_refresh, access_expires_at_unix, user).
    Raises RefreshError on anything that is not a clean rotation.
    """
    token_hash = hash_opaque_token(raw_refresh)

    # FOR UPDATE is the whole reason concurrent refreshes are safe. Without it
    # two callers both observe used_at IS NULL and both rotate, and the loser's
    # successor looks like a replay on its next use.
    row = await db.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == token_hash)
        .with_for_update()
    )

    if row is None:
        raise RefreshError("invalid_refresh_token", "Unrecognised refresh token.")

    if row.used_at is not None:
        # Replay. We cannot distinguish the legitimate holder from the thief,
        # so the entire lineage dies.
        #
        # This must be committed explicitly: get_db() rolls back on any
        # exception, so raising first would silently undo the revocation and
        # leave the stolen family live.
        await revoke_family(db, row.family_id, "reuse_detected")
        await db.commit()
        logger.warning(
            "Refresh token reuse detected for user %s (family %s) — family revoked",
            row.user_id,
            row.family_id,
        )
        raise RefreshError("session_revoked", "This session has been ended.")

    if row.revoked_at is not None:
        raise RefreshError("session_revoked", "This session has been ended.")

    now = _now()
    if is_past(row.expires_at):
        raise RefreshError("refresh_expired", "Your session has expired.")
    if is_past(row.family_expires_at):
        # The absolute ceiling. A token used every day would otherwise live
        # forever.
        raise RefreshError("refresh_expired", "Your session has expired.")

    user = await db.scalar(select(User).where(User.id == row.user_id))
    if user is None:
        # The account was deleted while a token was outstanding.
        raise RefreshError("invalid_refresh_token", "Unrecognised refresh token.")

    # Refresh tokens are killed outright at password-change time, so reaching
    # here with one older than the change means that revocation did not run.
    if user.password_changed_at and as_aware(row.issued_at) < as_aware(user.password_changed_at):
        await revoke_family(db, row.family_id, "password_change")
        await db.commit()
        raise RefreshError("session_revoked", "This session has been ended.")

    row.used_at = now

    access, new_raw, access_exp = await issue_pair(
        db,
        user,
        client=row.client,
        request=request,
        family_id=row.family_id,
        family_expires_at=row.family_expires_at,
        parent_id=row.id,
    )
    return access, new_raw, access_exp, user
