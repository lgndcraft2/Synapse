"""
Recording agreement to the Terms of Service and Privacy Policy.

Every way an account comes into existence must carry an acceptance: the
password signup (the checkbox, sent as accept_terms) and the Google callback
(the same checkbox, carried in the signed state cookie). Accounts that predate
the record, or accepted an older version, are asked again through
/auth/terms/accept.
"""

from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.asyncio

from app.core.config import settings
from app.models.models import User
from app.services import oauth_google as goauth


async def _login(client, creds) -> dict:
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": creds["email"], "password": creds["password"]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── Password signup ───────────────────────────────────────────────

async def test_register_without_the_checkbox_is_refused(client, session_factory):
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "nocheck@example.com", "password": "a-long-enough-password"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "terms_required"

    async with session_factory() as db:
        assert await db.scalar(select(User).where(User.email == "nocheck@example.com")) is None
    assert not client.sent_emails, "no verification email for a refused signup"


async def test_register_records_the_version_and_time(client, session_factory):
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "agreed@example.com", "password": "a-long-enough-password", "accept_terms": True},
    )
    assert resp.status_code == 202

    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == "agreed@example.com"))
        assert user.terms_version == settings.TERMS_VERSION
        assert user.terms_accepted_at is not None
        assert user.needs_terms_acceptance is False


async def test_new_account_is_not_asked_again(client, verified_user):
    body = await _login(client, verified_user)
    assert body["user"]["needs_terms_acceptance"] is False


# ── Existing accounts ─────────────────────────────────────────────

async def test_legacy_account_is_asked_and_can_accept(client, verified_user, session_factory):
    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == verified_user["email"]))
        user.terms_version = None
        user.terms_accepted_at = None
        await db.commit()

    body = await _login(client, verified_user)
    assert body["user"]["needs_terms_acceptance"] is True
    auth = {"Authorization": f"Bearer {body['access_token']}"}

    accepted = await client.post("/api/v1/auth/terms/accept", headers=auth)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["needs_terms_acceptance"] is False

    me = await client.get("/api/v1/auth/me", headers=auth)
    assert me.json()["needs_terms_acceptance"] is False

    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == verified_user["email"]))
        assert user.terms_version == settings.TERMS_VERSION
        assert user.terms_accepted_at is not None


async def test_bumping_the_version_asks_everyone_again(client, verified_user, monkeypatch):
    monkeypatch.setattr(settings, "TERMS_VERSION", "2099-01-01")
    body = await _login(client, verified_user)
    assert body["user"]["needs_terms_acceptance"] is True


async def test_accept_requires_sign_in(client):
    resp = await client.post("/api/v1/auth/terms/accept")
    assert resp.status_code == 401


# ── Google ────────────────────────────────────────────────────────

async def _google_callback(client, monkeypatch, *, accept_terms: bool, sub: str, email: str):
    import app.api.routes.auth as auth_routes

    query = "next=/dashboard" + ("&accept_terms=true" if accept_terms else "")
    start = await client.get(f"/api/v1/auth/google/start?{query}", follow_redirects=False)
    cookie = start.cookies.get(goauth.COOKIE_NAME)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    async def fake_exchange(code, verifier):
        return {"id_token": "stub"}

    async def fake_verify(raw, nonce):
        return {"sub": sub, "email": email, "email_verified": True, "name": "G"}

    monkeypatch.setattr(auth_routes.goauth, "exchange_code", fake_exchange)
    monkeypatch.setattr(auth_routes.goauth, "verify_id_token", fake_verify)

    return await client.get(
        f"/api/v1/auth/google/callback?code=c&state={state}",
        cookies={goauth.COOKIE_NAME: cookie},
        follow_redirects=False,
    )


async def test_google_without_the_checkbox_creates_no_account(
    client, monkeypatch, session_factory, fake_redis
):
    resp = await _google_callback(
        client, monkeypatch, accept_terms=False, sub="g-new", email="gnew@example.com"
    )
    assert resp.status_code == 303
    location = resp.headers["location"]
    # Sent to signup, where the checkbox is.
    assert "tab=signup" in location and "error=oauth_terms_required" in location

    async with session_factory() as db:
        assert await db.scalar(select(User).where(User.email == "gnew@example.com")) is None


async def test_google_with_the_checkbox_records_acceptance(
    client, monkeypatch, session_factory, fake_redis
):
    resp = await _google_callback(
        client, monkeypatch, accept_terms=True, sub="g-yes", email="gyes@example.com"
    )
    assert "/auth/callback?code=" in resp.headers["location"]

    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == "gyes@example.com"))
        assert user.terms_version == settings.TERMS_VERSION
        assert user.terms_accepted_at is not None


async def test_existing_google_account_signs_in_without_the_checkbox(
    client, monkeypatch, session_factory, fake_redis
):
    await _google_callback(client, monkeypatch, accept_terms=True, sub="g-back", email="gback@example.com")

    # Returning from the login screen, which has no checkbox.
    resp = await _google_callback(
        client, monkeypatch, accept_terms=False, sub="g-back", email="gback@example.com"
    )
    assert "/auth/callback?code=" in resp.headers["location"]


async def test_ticking_the_box_on_google_signup_updates_a_legacy_account(
    client, verified_user, monkeypatch, session_factory, fake_redis
):
    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == verified_user["email"]))
        user.terms_version = None
        await db.commit()

    await _google_callback(
        client, monkeypatch, accept_terms=True, sub="g-link", email=verified_user["email"]
    )

    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == verified_user["email"]))
        assert user.google_id == "g-link"
        assert user.terms_version == settings.TERMS_VERSION
