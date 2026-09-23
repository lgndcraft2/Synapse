"""The Upstash REST credentials in deployment must not be passed to redis-py."""

import json

import httpx
import pytest

from app.services.rate_limit import UpstashRestRedis

pytestmark = pytest.mark.asyncio


async def test_upstash_rest_client_sends_redis_commands_in_json_body():
    commands: list[list[object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        commands.append(json.loads(request.content))
        assert request.headers["Authorization"] == "Bearer test-token"
        command = commands[-1][0]
        result = {"INCR": 2, "EXPIRE": 1, "TTL": 59, "GET": "value", "GETDEL": "value", "DEL": 1}.get(command, "OK")
        return httpx.Response(200, json={"result": result})

    client = httpx.AsyncClient(
        base_url="https://example.upstash.io/",
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer test-token"},
    )
    redis = UpstashRestRedis("https://example.upstash.io", "test-token", client)

    assert await redis.incr("counter") == 2
    assert await redis.expire("counter", 60) == 1
    assert await redis.ttl("counter") == 59
    assert await redis.get("counter") == "value"
    assert await redis.setex("handoff", 30, '{"session":"safe"}') == "OK"
    assert await redis.getdel("handoff") == "value"
    assert await redis.delete("counter") == 1

    assert commands == [
        ["INCR", "counter"],
        ["EXPIRE", "counter", 60],
        ["TTL", "counter"],
        ["GET", "counter"],
        ["SETEX", "handoff", 30, '{"session":"safe"}'],
        ["GETDEL", "handoff"],
        ["DEL", "counter"],
    ]
    await client.aclose()
