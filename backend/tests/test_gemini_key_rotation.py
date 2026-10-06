"""
Gemini key rotation: dead keys must not fail requests while a healthy key exists.

A key Google rejects (invalid, or its project denied access) used to be
retried forever, because only 429s took a key out of rotation. These tests
drive `_gemini_generate` through a mock transport keyed on the API key header.
"""

import httpx
import pytest

from app.core.config import settings
from app.services import ai

_OK = {"candidates": [{"content": {"parts": [{"text": "<div>ok</div>"}]}}]}
_INVALID_KEY = {
    "error": {
        "code": 400,
        "message": "API key not valid. Please pass a valid API key.",
        "status": "INVALID_ARGUMENT",
        "details": [{"reason": "API_KEY_INVALID"}],
    }
}
_DENIED = {
    "error": {
        "code": 403,
        "message": "Your project has been denied access. Please contact support.",
        "status": "PERMISSION_DENIED",
    }
}
_BAD_PAYLOAD = {
    "error": {"code": 400, "message": "Invalid JSON payload received.", "status": "INVALID_ARGUMENT"}
}


@pytest.fixture
def gemini_pool(monkeypatch):
    """Configure a key pool and route each key to a canned response."""
    behaviour: dict[str, tuple[int, dict]] = {}
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.headers.get("x-goog-api-key")
        assert "key=" not in str(request.url), "API key must not travel in the URL"
        calls.append(key)
        status, body = behaviour[key]
        return httpx.Response(status, json=body)

    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    async def no_sleep(_seconds):
        return None

    def configure(**keys: tuple[int, dict]):
        names = ["GEMINI_KEY_1", "GEMINI_KEY_2", "GEMINI_KEY_3", "GEMINI_KEY_4", "GEMINI_KEY_5"]
        values = list(keys)
        for i, name in enumerate(names):
            monkeypatch.setattr(settings, name, values[i] if i < len(values) else "")
        behaviour.update(keys)

    monkeypatch.setattr(ai.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(ai.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(ai, "_key_index", 0)
    monkeypatch.setattr(ai, "_rate_limited_keys", set())
    monkeypatch.setattr(ai, "_dead_keys", {})
    return configure, calls


async def test_dead_keys_are_skipped_until_a_healthy_key_answers(gemini_pool):
    configure, calls = gemini_pool
    configure(
        bad=(400, _INVALID_KEY),
        denied_a=(403, _DENIED),
        denied_b=(403, _DENIED),
        good=(200, _OK),
    )

    data = await ai._gemini_generate({"contents": []}, timeout=5)

    assert data == _OK
    assert calls[-1] == "good"
    assert set(ai._dead_keys) == set(calls[:-1])


async def test_dead_keys_stay_out_of_rotation_on_later_requests(gemini_pool):
    configure, calls = gemini_pool
    configure(denied=(403, _DENIED), good=(200, _OK))

    for _ in range(4):
        await ai._gemini_generate({"contents": []}, timeout=5)

    # At most one wasted call on the denied key, then only the healthy one.
    assert calls.count("denied") <= 1
    assert calls[-3:] == ["good", "good", "good"]


async def test_every_key_dead_raises_instead_of_looping(gemini_pool):
    configure, calls = gemini_pool
    configure(bad=(400, _INVALID_KEY), denied=(403, _DENIED))

    with pytest.raises(RuntimeError, match="No working Gemini API keys"):
        await ai._gemini_generate({"contents": []}, timeout=5)
    assert sorted(calls) == ["bad", "denied"]


async def test_a_bad_payload_is_not_blamed_on_the_key(gemini_pool):
    configure, calls = gemini_pool
    configure(good=(400, _BAD_PAYLOAD))

    with pytest.raises(httpx.HTTPStatusError):
        await ai._gemini_generate({"contents": []}, timeout=5)
    assert ai._dead_keys == {}
    assert calls == ["good"]


async def test_dead_keys_return_after_the_cooldown(gemini_pool, monkeypatch):
    configure, calls = gemini_pool
    configure(only=(200, _OK))
    ai._dead_keys["only"] = 0.0  # cooldown already elapsed

    await ai._gemini_generate({"contents": []}, timeout=5)

    assert calls == ["only"]
    assert ai._dead_keys == {}


async def test_rate_limited_keys_are_still_retried_when_all_are_limited(gemini_pool):
    configure, calls = gemini_pool
    configure(busy=(429, {"error": {"code": 429}}), good=(200, _OK))

    data = await ai._gemini_generate({"contents": []}, timeout=5)

    assert data == _OK
    assert "busy" not in ai._dead_keys
