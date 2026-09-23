"""Access control and aggregate shape for the internal observer endpoint."""

import pytest

from app.core.config import settings

pytestmark = pytest.mark.asyncio


async def test_observer_requires_an_configured_admin(client, verified_user, monkeypatch):
    login = await client.post("/api/v1/auth/login", json=verified_user)
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    denied = await client.get("/api/v1/observer/overview", headers=headers)
    assert denied.status_code == 403

    monkeypatch.setattr(settings, "ADMIN_EMAILS", verified_user["email"])
    allowed = await client.get("/api/v1/observer/overview", headers=headers)
    assert allowed.status_code == 200, allowed.text

    body = allowed.json()
    assert set(body["metrics"]) == {
        "total_users",
        "new_users_24h",
        "active_users_30d",
        "total_sessions",
        "sessions_24h",
        "active_subscriptions",
        "open_tickets",
    }
    assert len(body["traffic"]) == 7
