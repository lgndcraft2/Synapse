"""Route-level checks for auth throttling and health-probe isolation."""

import pytest
from redis.exceptions import ConnectionError

from app.core.config import settings

pytestmark = pytest.mark.asyncio


@pytest.fixture(params=[False, True], ids=["redis", "redis-unavailable"])
def limiter_backend(request, fake_redis, monkeypatch):
    if request.param:
        async def unavailable(*args, **kwargs):
            raise ConnectionError("simulated Redis outage")

        monkeypatch.setattr(fake_redis, "incr", unavailable)


def assert_throttled(response, window):
    assert response.status_code == 429, response.text
    # FakeRedis does not advance TTL; the fallback reports its full window.
    assert int(response.headers["Retry-After"]) == window


async def test_login_email_limit(client, limiter_backend, monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_COUNT", 1)
    payload = {"email": "missing@example.com", "password": "wrong-password"}
    for attempt in range(30):
        response = await client.post(
            "/api/v1/auth/login", json=payload,
            headers={"X-Forwarded-For": f"198.51.100.{attempt + 1}"},
        )
        assert response.status_code == 401

    blocked = await client.post("/api/v1/auth/login", json=payload)
    assert_throttled(blocked, 3600)

    # An account bucket must not lock out another account on the same IP.
    payload["email"] = "another@example.com"
    assert (await client.post("/api/v1/auth/login", json=payload)).status_code == 401


async def test_login_ip_limit_cannot_be_evaded_by_changing_email_or_header(
    client, limiter_backend, monkeypatch
):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_COUNT", 0)
    for attempt in range(31):
        response = await client.post(
            "/api/v1/auth/login",
            json={"email": f"missing-{attempt}@example.com", "password": "wrong-password"},
            headers={"X-Forwarded-For": f"198.51.100.{attempt + 1}"},
        )
        if attempt < 30:
            assert response.status_code == 401
        else:
            assert_throttled(response, 3600)


async def test_signup_limit_and_health_isolation(client, limiter_backend):
    payload = {
        "email": "new@example.com",
        "password": "a-long-enough-password",
        "accept_terms": True,
    }
    for _ in range(30):
        assert (await client.post("/api/v1/auth/register", json=payload)).status_code == 202

    sent_before = len(client.sent_emails)
    assert_throttled(await client.post("/api/v1/auth/register", json=payload), 3600)
    assert len(client.sent_emails) == sent_before

    for _ in range(25):
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

    # Signup and login use separate counters even when the IP is identical.
    login = await client.post(
        "/api/v1/auth/login",
        json={"email": payload["email"], "password": "incorrect-password"},
    )
    assert login.status_code == 401


async def test_successful_login_clears_email_strikes(
    client, verified_user, limiter_backend, monkeypatch
):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_COUNT", 1)
    for _ in range(4):
        response = await client.post(
            "/api/v1/auth/login", json={**verified_user, "password": "wrong-password"}
        )
        assert response.status_code == 401

    assert (await client.post("/api/v1/auth/login", json=verified_user)).status_code == 200

    # Use different IPs so the IP counter cannot hide an email-counter failure.
    for attempt in range(30):
        response = await client.post(
            "/api/v1/auth/login", json={**verified_user, "password": "wrong-password"},
            headers={"X-Forwarded-For": f"198.51.100.{attempt + 1}"},
        )
        assert response.status_code == 401

    assert_throttled(await client.post("/api/v1/auth/login", json=verified_user), 3600)


async def test_trusted_proxy_keeps_signup_ips_separate(client, monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_COUNT", 1)
    payload = {
        "email": "proxy@example.com", "password": "a-long-enough-password", "accept_terms": True,
    }
    for _ in range(30):
        response = await client.post(
            "/api/v1/auth/register", json=payload,
            headers={"X-Forwarded-For": "198.51.100.1"},
        )
        assert response.status_code == 202

    # The leftmost entry is caller-controlled; the edge appends the real IP.
    blocked = await client.post(
        "/api/v1/auth/register", json=payload,
        headers={"X-Forwarded-For": "203.0.113.99, 198.51.100.1"},
    )
    assert_throttled(blocked, 3600)

    other_ip = await client.post(
        "/api/v1/auth/register", json=payload,
        headers={"X-Forwarded-For": "198.51.100.2"},
    )
    assert other_ip.status_code == 202


async def test_health_does_not_access_redis_or_database(client, fake_redis, monkeypatch):
    from app.db.database import get_db
    from app.main import app

    async def unexpected_access(*args, **kwargs):
        raise AssertionError("health probes must not depend on Redis or the database")

    monkeypatch.setattr(fake_redis, "incr", unexpected_access)
    monkeypatch.setitem(app.dependency_overrides, get_db, unexpected_access)
    assert (await client.get("/health")).status_code == 200
