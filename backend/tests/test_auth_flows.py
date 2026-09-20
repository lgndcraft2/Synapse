"""
Registration, verification, login and account behaviour.

These test the properties that are easy to regress with a well-meaning edit —
account enumeration, the verification gate, and the distinction between a
wrong password and an unverified address.
"""

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.asyncio


async def test_register_returns_no_session_until_verified(client):
    """
    Signup must not hand back a session.

    The whole point of requiring verification is that free AI usage cannot be
    farmed with throwaway addresses; returning tokens here would defeat it.
    """
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "new@example.com", "password": "a-long-enough-password"},
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "pending_verification"
    assert "access_token" not in body
    assert "refresh_token" not in body


async def test_register_does_not_reveal_existing_accounts(client):
    """A taken address and a fresh one must be indistinguishable."""
    payload = {"email": "dup@example.com", "password": "a-long-enough-password"}
    first = await client.post("/api/v1/auth/register", json=payload)
    second = await client.post("/api/v1/auth/register", json=payload)

    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()


async def test_unverified_account_cannot_log_in(client):
    await client.post(
        "/api/v1/auth/register",
        json={"email": "unverified@example.com", "password": "a-long-enough-password"},
    )
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "unverified@example.com", "password": "a-long-enough-password"},
    )
    assert resp.status_code == 403
    # A distinct code, so the UI can offer "resend" rather than implying the
    # password was wrong.
    assert resp.json()["detail"]["code"] == "email_not_verified"


async def test_verification_link_signs_the_user_in(client, session_factory):
    from app.models.models import EmailToken

    email = "verifyme@example.com"
    await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "a-long-enough-password"},
    )

    # The emailed URL carries the raw token; the database stores only its hash.
    sent = client.sent_emails[-1]
    assert sent["type"] == "verify"
    token = sent["url"].split("token=")[1]

    resp = await client.post("/api/v1/auth/verify-email/confirm", json={"token": token})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"] and body["refresh_token"]
    assert body["user"]["email_verified"] is True

    async with session_factory() as session:
        row = await session.scalar(select(EmailToken).where(EmailToken.purpose == "email_verify"))
        assert row.used_at is not None, "token should be spent"


async def test_verification_token_is_single_use(client):
    await client.post(
        "/api/v1/auth/register",
        json={"email": "once@example.com", "password": "a-long-enough-password"},
    )
    token = client.sent_emails[-1]["url"].split("token=")[1]

    first = await client.post("/api/v1/auth/verify-email/confirm", json={"token": token})
    assert first.status_code == 200

    second = await client.post("/api/v1/auth/verify-email/confirm", json={"token": token})
    assert second.status_code == 400


async def test_login_succeeds_and_returns_a_full_session(client, verified_user):
    resp = await client.post("/api/v1/auth/login", json=verified_user)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["token_type"] == "bearer"
    assert body["access_token"] and body["refresh_token"]
    assert body["expires_at"] > 0
    # The user is inlined so the client never needs a follow-up /auth/me.
    assert body["user"]["email"] == verified_user["email"]
    assert body["user"]["auth_provider"] == "password"


async def test_wrong_password_and_unknown_account_are_indistinguishable(
    client, verified_user
):
    """
    The anti-enumeration property.

    Same status and same body whether the address exists or not.
    """
    wrong = await client.post(
        "/api/v1/auth/login",
        json={"email": verified_user["email"], "password": "not-the-password"},
    )
    missing = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@example.com", "password": "not-the-password"},
    )

    assert wrong.status_code == missing.status_code == 401
    assert wrong.json() == missing.json()


async def test_forgot_password_always_reports_success(client, verified_user):
    """202 for a real address and an imaginary one alike."""
    known = await client.post(
        "/api/v1/auth/password/forgot", json={"email": verified_user["email"]}
    )
    unknown = await client.post(
        "/api/v1/auth/password/forgot", json={"email": "ghost@example.com"}
    )

    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    # Only the real one actually produced mail.
    assert any(e["type"] == "reset" for e in client.sent_emails)


async def test_password_reset_rotates_credentials_and_kills_sessions(
    client, verified_user
):
    login = await client.post("/api/v1/auth/login", json=verified_user)
    old_refresh = login.json()["refresh_token"]

    await client.post(
        "/api/v1/auth/password/forgot", json={"email": verified_user["email"]}
    )
    token = [e for e in client.sent_emails if e["type"] == "reset"][-1]["url"].split("token=")[1]

    new_password = "an-entirely-different-password"
    resp = await client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": new_password}
    )
    assert resp.status_code == 200

    # Whoever prompted the reset may be the reason for it, so every other
    # session dies.
    reuse = await client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert reuse.status_code == 401

    old_login = await client.post("/api/v1/auth/login", json=verified_user)
    assert old_login.status_code == 401

    new_login = await client.post(
        "/api/v1/auth/login",
        json={"email": verified_user["email"], "password": new_password},
    )
    assert new_login.status_code == 200


async def test_me_requires_a_token_and_patch_renames(client, verified_user):
    anon = await client.get("/api/v1/auth/me")
    assert anon.status_code == 401  # no Authorization header

    login = await client.post("/api/v1/auth/login", json=verified_user)
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    me = await client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == verified_user["email"]

    # The endpoint that replaced the Supabase metadata round-trip.
    renamed = await client.patch(
        "/api/v1/auth/me", json={"name": "Renamed Person"}, headers=headers
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed Person"

    again = await client.get("/api/v1/auth/me", headers=headers)
    assert again.json()["name"] == "Renamed Person"


async def test_garbage_and_tampered_tokens_are_rejected(client, verified_user):
    login = await client.post("/api/v1/auth/login", json=verified_user)
    good = login.json()["access_token"]

    for bad in ["not-a-token", good[:-3] + "aaa", good + "x", ""]:
        resp = await client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {bad}"}
        )
        assert resp.status_code in (401, 403), f"accepted bad token: {bad[:20]!r}"


async def test_password_change_requires_the_current_password(client, verified_user):
    login = await client.post("/api/v1/auth/login", json=verified_user)
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    wrong = await client.post(
        "/api/v1/auth/password/change",
        json={"current_password": "wrong", "new_password": "a-brand-new-password"},
        headers=headers,
    )
    assert wrong.status_code == 401

    right = await client.post(
        "/api/v1/auth/password/change",
        json={
            "current_password": verified_user["password"],
            "new_password": "a-brand-new-password",
        },
        headers=headers,
    )
    assert right.status_code == 204
