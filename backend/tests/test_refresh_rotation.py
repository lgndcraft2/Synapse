"""
Refresh-token rotation and reuse detection.

This is the security core of the session design, and the part most likely to
be broken by a plausible-looking change — so each property is pinned
separately rather than bundled into one happy-path test.

Caveat repeated from conftest: SQLite ignores `SELECT ... FOR UPDATE`, so
these prove the *logic* of rotation and replay handling, not the row locking
that makes it correct under real concurrency.
"""

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.asyncio


async def _login(client, creds):
    resp = await client.post("/api/v1/auth/login", json=creds)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_refresh_returns_a_new_token_pair(client, verified_user):
    session = await _login(client, verified_user)

    resp = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": session["refresh_token"]}
    )
    assert resp.status_code == 200, resp.text
    rotated = resp.json()

    # The rotation the whole design rests on. Nothing else in the suite would
    # notice if the server started returning the same token back.
    assert rotated["refresh_token"] != session["refresh_token"]
    assert rotated["user"]["email"] == verified_user["email"]


async def test_rotated_token_works_and_predecessor_does_not(client, verified_user):
    session = await _login(client, verified_user)
    first = session["refresh_token"]

    rotated = (
        await client.post("/api/v1/auth/refresh", json={"refresh_token": first})
    ).json()
    second = rotated["refresh_token"]

    # The successor is live.
    ok = await client.post("/api/v1/auth/refresh", json={"refresh_token": second})
    assert ok.status_code == 200

    # The predecessor is not — and using it is what trips reuse detection.
    replay = await client.post("/api/v1/auth/refresh", json={"refresh_token": first})
    assert replay.status_code == 401
    assert replay.json()["detail"]["code"] == "session_revoked"


async def test_replay_revokes_the_entire_family(client, verified_user, session_factory):
    """
    The property that makes theft survivable.

    A stolen token being replayed must not merely fail — it must take down the
    whole lineage, because we cannot tell the thief from the victim.
    """
    from app.models.models import RefreshToken

    session = await _login(client, verified_user)
    first = session["refresh_token"]

    second = (
        await client.post("/api/v1/auth/refresh", json={"refresh_token": first})
    ).json()["refresh_token"]

    # Attacker replays the spent token.
    replay = await client.post("/api/v1/auth/refresh", json={"refresh_token": first})
    assert replay.status_code == 401

    # The victim's still-valid successor is now dead too.
    victim = await client.post("/api/v1/auth/refresh", json={"refresh_token": second})
    assert victim.status_code == 401, "successor survived a family revocation"
    assert victim.json()["detail"]["code"] == "session_revoked"

    async with session_factory() as db:
        rows = (await db.scalars(select(RefreshToken))).all()
        live = [r for r in rows if r.revoked_at is None]
        assert not live, f"{len(live)} token(s) still live after reuse detection"
        assert any(r.revoked_reason == "reuse_detected" for r in rows)


async def test_family_revocation_survives_the_error_response(
    client, verified_user, session_factory
):
    """
    Regression guard for a subtle failure mode.

    get_db() rolls back on any exception. If the revocation were not committed
    before raising, the 401 would be returned *and the stolen family would stay
    live* — the code would look correct and do nothing.
    """
    from app.models.models import RefreshToken

    session = await _login(client, verified_user)
    first = session["refresh_token"]
    await client.post("/api/v1/auth/refresh", json={"refresh_token": first})
    await client.post("/api/v1/auth/refresh", json={"refresh_token": first})

    async with session_factory() as db:
        rows = (await db.scalars(select(RefreshToken))).all()
        assert rows, "no tokens persisted at all"
        assert all(r.revoked_at is not None for r in rows), (
            "revocation was rolled back with the error response"
        )


async def test_unknown_and_garbage_tokens_are_rejected(client):
    for bad in ["nonsense", "x" * 64, ""]:
        resp = await client.post("/api/v1/auth/refresh", json={"refresh_token": bad})
        assert resp.status_code in (401, 422), f"accepted {bad[:20]!r}"


async def test_logout_revokes_only_the_presented_session(client, verified_user):
    a = await _login(client, verified_user)
    b = await _login(client, verified_user)

    out = await client.post("/api/v1/auth/logout", json={"refresh_token": a["refresh_token"]})
    assert out.status_code == 204

    dead = await client.post("/api/v1/auth/refresh", json={"refresh_token": a["refresh_token"]})
    assert dead.status_code == 401

    # The other device is untouched.
    alive = await client.post("/api/v1/auth/refresh", json={"refresh_token": b["refresh_token"]})
    assert alive.status_code == 200


async def test_logout_all_revokes_every_session(client, verified_user):
    a = await _login(client, verified_user)
    b = await _login(client, verified_user)

    out = await client.post(
        "/api/v1/auth/logout-all",
        headers={"Authorization": f"Bearer {a['access_token']}"},
    )
    assert out.status_code == 204

    for session in (a, b):
        resp = await client.post(
            "/api/v1/auth/refresh", json={"refresh_token": session["refresh_token"]}
        )
        assert resp.status_code == 401


async def test_logout_is_forgiving_of_unknown_tokens(client):
    """A client holding a token we never issued should still end up logged out."""
    resp = await client.post("/api/v1/auth/logout", json={"refresh_token": "never-issued"})
    assert resp.status_code == 204


async def test_expired_refresh_token_is_rejected(client, verified_user, session_factory):
    from datetime import datetime, timedelta, timezone
    from app.models.models import RefreshToken

    session = await _login(client, verified_user)

    async with session_factory() as db:
        row = await db.scalar(select(RefreshToken))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    resp = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": session["refresh_token"]}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "refresh_expired"


async def test_family_ceiling_caps_a_sliding_token(client, verified_user, session_factory):
    """
    The absolute ceiling.

    Per-token expiry slides forward on every use, so without family_expires_at
    a regularly-used token would never die.
    """
    from datetime import datetime, timedelta, timezone
    from app.models.models import RefreshToken

    session = await _login(client, verified_user)

    async with session_factory() as db:
        row = await db.scalar(select(RefreshToken))
        row.family_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    resp = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": session["refresh_token"]}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "refresh_expired"


async def test_access_token_carries_the_claims_the_extension_reads(client, verified_user):
    """
    background.js decodes the access token to render its popup without an API
    call. It reads flat `name` and `email`; losing either shows a blank popup.
    """
    from jose import jwt

    session = await _login(client, verified_user)
    claims = jwt.get_unverified_claims(session["access_token"])

    assert claims["email"] == verified_user["email"]
    assert "name" in claims
    assert claims["typ"] == "access"
    assert claims["iss"] == "synapse"
    assert claims["aud"] == "synapse-api"


async def test_refresh_token_is_never_stored_in_plaintext(
    client, verified_user, session_factory
):
    from app.models.models import RefreshToken

    session = await _login(client, verified_user)
    raw = session["refresh_token"]

    async with session_factory() as db:
        rows = (await db.scalars(select(RefreshToken))).all()
        assert rows
        for row in rows:
            assert row.token_hash != raw
            assert len(row.token_hash) == 64  # sha256 hex
