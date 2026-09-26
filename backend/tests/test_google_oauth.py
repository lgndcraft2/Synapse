"""
The Google OAuth handshake, and the state parameter in particular.

This is the feature the whole migration was undertaken for: a cryptographically
random state generated before the redirect, held in an HttpOnly cookie,
required to match exactly on callback, and destroyed after one use.

Google itself is never contacted — the token exchange and id_token
verification are stubbed. What is under test is our half of the protocol.
"""

from urllib.parse import parse_qs, urlparse

import pytest

pytestmark = pytest.mark.asyncio

from app.services import oauth_google as goauth


def _start(client):
    return client.get("/api/v1/auth/google/start?next=/dashboard", follow_redirects=False)


async def test_start_redirects_to_google_with_all_required_params(client):
    resp = await _start(client)
    assert resp.status_code == 307

    url = urlparse(resp.headers["location"])
    assert url.netloc == "accounts.google.com"
    params = parse_qs(url.query)

    for required in ("client_id", "redirect_uri", "response_type", "scope", "state", "nonce"):
        assert required in params, f"missing {required}"

    assert params["response_type"] == ["code"]
    assert params["code_challenge_method"] == ["S256"]
    assert "openid" in params["scope"][0]


async def test_state_is_high_entropy_and_never_repeats(client):
    seen = set()
    for _ in range(5):
        resp = await _start(client)
        state = parse_qs(urlparse(resp.headers["location"]).query)["state"][0]
        # 32 random bytes, urlsafe-base64 without padding.
        assert len(state) >= 40
        seen.add(state)
    assert len(seen) == 5, "state values repeated across requests"


async def test_state_cookie_is_httponly_and_samesite_lax(client):
    resp = await _start(client)

    header = resp.headers.get("set-cookie", "")
    assert goauth.COOKIE_NAME in header
    assert "HttpOnly" in header
    # Lax, never Strict: the return from accounts.google.com is a cross-site
    # top-level navigation, and Strict withholds the cookie on exactly that —
    # producing a 100% failure rate that presents as "state mismatch".
    assert "SameSite=lax" in header.lower().replace("samesite=lax", "SameSite=lax") or "samesite=lax" in header.lower()
    # Scoped so it rides along on one request in the whole application.
    assert goauth.COOKIE_PATH in header


async def test_callback_without_the_cookie_is_rejected(client):
    """A callback that did not originate from our /start cannot be completed."""
    resp = await client.get(
        "/api/v1/auth/google/callback?code=abc&state=anything",
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert "error=oauth_state" in resp.headers["location"]


async def test_callback_with_mismatched_state_is_rejected(client):
    start = await _start(client)
    cookie = start.cookies.get(goauth.COOKIE_NAME)
    assert cookie

    resp = await client.get(
        "/api/v1/auth/google/callback?code=abc&state=attacker-chosen-value",
        cookies={goauth.COOKIE_NAME: cookie},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert "error=oauth_state" in resp.headers["location"]


async def test_callback_with_tampered_cookie_is_rejected(client):
    start = await _start(client)
    cookie = start.cookies.get(goauth.COOKIE_NAME)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    resp = await client.get(
        f"/api/v1/auth/google/callback?code=abc&state={state}",
        cookies={goauth.COOKIE_NAME: cookie[:-4] + "AAAA"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert "error=oauth_state" in resp.headers["location"]


async def test_cookie_from_a_different_flow_is_rejected(client):
    """Each transaction is bound to its own state; they are not interchangeable."""
    first = await _start(client)
    second = await _start(client)

    state_of_first = parse_qs(urlparse(first.headers["location"]).query)["state"][0]
    cookie_of_second = second.cookies.get(goauth.COOKIE_NAME)

    resp = await client.get(
        f"/api/v1/auth/google/callback?code=abc&state={state_of_first}",
        cookies={goauth.COOKIE_NAME: cookie_of_second},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert "error=oauth_state" in resp.headers["location"]


async def test_cookie_is_cleared_on_every_exit_path(client):
    """
    Single use, unconditionally.

    Rejected attempts must burn the state too — otherwise an attacker gets
    unlimited retries against a live transaction.
    """
    start = await _start(client)
    cookie = start.cookies.get(goauth.COOKIE_NAME)

    cases = {
        "mismatched state": "/api/v1/auth/google/callback?code=abc&state=wrong",
        "user denied": "/api/v1/auth/google/callback?error=access_denied",
    }
    for label, url in cases.items():
        resp = await client.get(
            url, cookies={goauth.COOKIE_NAME: cookie}, follow_redirects=False
        )
        set_cookie = resp.headers.get("set-cookie", "")
        assert goauth.COOKIE_NAME in set_cookie, f"{label}: cookie not cleared"
        # Expiry in the past, or an empty value — either clears it.
        assert ('Max-Age=0' in set_cookie or 'expires=' in set_cookie.lower()
                or f'{goauth.COOKIE_NAME}=""' in set_cookie
                or f'{goauth.COOKIE_NAME}=;' in set_cookie), f"{label}: {set_cookie}"


async def test_user_denial_is_reported_distinctly(client):
    """Pressing Deny is not a security failure and should not read like one."""
    resp = await client.get(
        "/api/v1/auth/google/callback?error=access_denied", follow_redirects=False
    )
    assert resp.status_code == 303
    assert "error=oauth_denied" in resp.headers["location"]


async def test_successful_callback_creates_a_user_and_hands_off(
    client, monkeypatch, session_factory, fake_redis
):
    """The happy path, with Google stubbed at the two network boundaries."""
    from sqlalchemy import select
    from app.models.models import User
    import app.api.routes.auth as auth_routes

    start = await _start(client)
    cookie = start.cookies.get(goauth.COOKIE_NAME)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    async def fake_exchange(code, verifier):
        return {"id_token": "stub-id-token"}

    async def fake_verify(raw, nonce):
        return {
            "sub": "google-subject-12345",
            "email": "googler@example.com",
            "email_verified": True,
            "name": "Google Person",
            "picture": "https://example.com/avatar.png",
        }

    monkeypatch.setattr(auth_routes.goauth, "exchange_code", fake_exchange)
    monkeypatch.setattr(auth_routes.goauth, "verify_id_token", fake_verify)

    resp = await client.get(
        f"/api/v1/auth/google/callback?code=auth-code&state={state}",
        cookies={goauth.COOKIE_NAME: cookie},
        follow_redirects=False,
    )
    assert resp.status_code == 303, resp.text
    location = resp.headers["location"]
    assert "/auth/callback?code=" in location, location

    # Tokens must not be in the URL — that is what the handoff code is for.
    assert "access_token" not in location
    assert "refresh_token" not in location

    async with session_factory() as db:
        user = await db.scalar(select(User).where(User.email == "googler@example.com"))
        assert user is not None
        assert user.google_id == "google-subject-12345"
        assert user.email_verified is True
        # No password set, so the UI shows "Google" rather than offering a reset.
        assert user.auth_provider == "google"

    handoff = location.split("code=")[1]
    exchanged = await client.post("/api/v1/auth/google/exchange", json={"code": handoff})
    assert exchanged.status_code == 200, exchanged.text
    body = exchanged.json()
    assert body["access_token"] and body["refresh_token"]
    assert body["user"]["email"] == "googler@example.com"
    assert body["user"]["avatar_url"] == "https://example.com/avatar.png"

    blocked = await client.patch(
        "/api/v1/auth/me",
        json={"avatar_id": "aurora"},
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert blocked.status_code == 403


async def test_handoff_code_is_single_use(client, monkeypatch, fake_redis):
    import app.api.routes.auth as auth_routes

    start = await _start(client)
    cookie = start.cookies.get(goauth.COOKIE_NAME)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    async def fake_exchange(code, verifier):
        return {"id_token": "stub"}

    async def fake_verify(raw, nonce):
        return {
            "sub": "sub-once",
            "email": "once@example.com",
            "email_verified": True,
            "name": "Once",
        }

    monkeypatch.setattr(auth_routes.goauth, "exchange_code", fake_exchange)
    monkeypatch.setattr(auth_routes.goauth, "verify_id_token", fake_verify)

    resp = await client.get(
        f"/api/v1/auth/google/callback?code=x&state={state}",
        cookies={goauth.COOKIE_NAME: cookie},
        follow_redirects=False,
    )
    handoff = resp.headers["location"].split("code=")[1]

    first = await client.post("/api/v1/auth/google/exchange", json={"code": handoff})
    assert first.status_code == 200

    # GETDEL makes it single-use by construction, so two tabs racing on the
    # same redirect cannot both claim the session.
    second = await client.post("/api/v1/auth/google/exchange", json={"code": handoff})
    assert second.status_code == 400


async def test_unverified_google_address_cannot_adopt_a_local_account(client):
    """
    The account-takeover path.

    Anyone can create a Google account; without insisting Google reports the
    address as verified, that would be enough to adopt a matching local one.
    verify_id_token refuses before any linking is considered.
    """
    from app.services.oauth_google import OAuthError, verify_id_token

    async def fake_thread(fn, *a, **kw):
        return {
            "sub": "s",
            "email": "victim@example.com",
            "email_verified": False,
            "nonce": "n",
        }

    import asyncio
    original = asyncio.to_thread
    asyncio.to_thread = fake_thread
    try:
        with pytest.raises(OAuthError) as exc:
            await verify_id_token("tok", "n")
        assert exc.value.code == "oauth_unverified"
    finally:
        asyncio.to_thread = original
