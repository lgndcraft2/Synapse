"""
POST /explain and the explanation-history endpoints.

The model call is always replaced with a stub: these tests prove quota,
validation, history and tenant isolation, not what Gemini or Claude say.
Object storage is likewise a fake, so thumbnail handling and the retention
purge run without boto3 or a bucket.
"""

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.asyncio

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
WEBP = base64.b64encode(b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32).decode()


# ── Fixtures and helpers ──────────────────────────────────────────

@pytest.fixture
def ai_calls(monkeypatch):
    """Stub the model. Each call is recorded; set `.fail = True` to raise."""
    import app.services.ai as ai

    class Recorder(list):
        fail = False

    calls = Recorder()

    async def fake_call_explain(text, image_base64, media_type, profile, feedback_summary, use_claude=False,
                                context_text="", document_text="", reexplain=None):
        calls.append({
            "text": text, "image": image_base64, "media_type": media_type, "use_claude": use_claude,
            "context_text": context_text, "document_text": document_text, "reexplain": reexplain,
            "feedback_summary": feedback_summary,
        })
        if calls.fail:
            raise RuntimeError("provider exploded at https://provider.example/?key=secret")
        return "<div><p>Explained.</p></div>"

    monkeypatch.setattr(ai, "call_explain", fake_call_explain)
    return calls


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.fail_deletes = False

    def put_object(self, Bucket, Key, Body, ContentType, **kwargs):
        assert ContentType == "image/webp"
        self.objects[Key] = Body

    def delete_object(self, Bucket, Key):
        if self.fail_deletes:
            raise RuntimeError("storage down")
        self.objects.pop(Key, None)

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"https://bucket.example/{Params['Key']}?sig=1"


@pytest.fixture
def fake_storage(monkeypatch):
    import app.services.explain_storage as storage

    s3 = FakeS3()
    monkeypatch.setattr(storage, "is_configured", lambda: True)
    monkeypatch.setattr(storage, "_s3", lambda: s3)
    return s3


async def _sign_in(client, session_factory, label: str, plan: str = "free") -> dict:
    """Register, verify, optionally upgrade, and log in a fresh account."""
    from app.models.models import Billing, User

    email = f"{label}-{uuid.uuid4().hex[:8]}@example.com"
    password = "correct horse battery staple"
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": label.title()},
    )
    assert resp.status_code == 202, resp.text

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == email))
        user.email_verified = True
        if plan != "free":
            user.plan = plan
            billing = await session.scalar(select(Billing).where(Billing.user_id == user.id))
            if billing is None:
                billing = Billing(user_id=user.id)
                session.add(billing)
            billing.plan = plan if plan in ("lite", "premium") else "free"
            billing.status = "active"
            billing.renews_at = datetime(2099, 1, 1)
        await session.commit()

    resp = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {
        "id": uuid.UUID(body["user"]["id"]),
        "headers": {"Authorization": f"Bearer {body['access_token']}"},
    }


def _text_body(**overrides) -> dict:
    body = {
        "kind": "text",
        "text": "Photosynthesis converts light into chemical energy.",
        "anchor": {"quote": "Photosynthesis", "prefix": "", "suffix": " converts"},
        "page_url": "https://Example.com:8443/article",
        "page_title": "Plants",
        "fingerprint": "ext-test",
    }
    body.update(overrides)
    return body


def _image_body(**overrides) -> dict:
    body = {
        "kind": "image",
        "text": "Figure 1: growth by month",
        "image_base64": PNG,
        "image_media_type": "image/png",
        "anchor": {"rect": {"x": 10, "y": 20, "width": 300, "height": 200}},
        "page_url": "https://example.com/article",
        "page_title": "Plants",
        "fingerprint": "ext-test",
    }
    body.update(overrides)
    return body


async def _explain(client, body, headers=None):
    return await client.post("/api/v1/explain", json=body, headers=headers or {})


# ── Text explains ─────────────────────────────────────────────────

async def test_text_explain_happy_path(client, ai_calls, session_factory):
    from app.models.models import AIUsageEvent

    resp = await _explain(client, _text_body())
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["html"] == "<div><p>Explained.</p></div>"
    assert data["kind"] == "text"
    assert data["model_used"] == "gemini-flash"
    assert data["history_entry"] is None
    assert data["usage"] is None
    assert ai_calls[0]["image"] is None

    async with session_factory() as session:
        events = (await session.scalars(select(AIUsageEvent))).all()
    assert [(e.operation, e.succeeded) for e in events] == [("explain_text", True)]
    assert events[0].input_characters == len(_text_body()["text"])
    assert events[0].source == "page"  # no source sent, no document context


async def test_explain_records_its_source(client, ai_calls, session_factory):
    from app.models.models import AIUsageEvent

    resp = await _explain(client, _image_body(source="pdf"))
    assert resp.status_code == 200, resp.text
    async with session_factory() as session:
        events = (await session.scalars(select(AIUsageEvent))).all()
    assert [(e.operation, e.source) for e in events] == [("explain_image", "pdf")]

    bad = await _explain(client, _text_body(source="spreadsheet"))
    assert bad.status_code == 422


async def test_text_explain_counts_against_reformat_quota(client, ai_calls, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "FREE_DAILY_LIMIT", 2)
    assert (await _explain(client, _text_body())).status_code == 200
    assert (await _explain(client, _text_body())).status_code == 200
    resp = await _explain(client, _text_body())
    assert resp.status_code == 429
    assert "Daily limit" in resp.json()["detail"]
    assert len(ai_calls) == 2


async def test_text_length_limit_is_403(client, ai_calls, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "FREE_TEXT_LIMIT", 10)
    resp = await _explain(client, _text_body())
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "LENGTH_EXCEEDED"


# ── Image explains ────────────────────────────────────────────────

async def test_free_image_limit_is_five_per_day(client, ai_calls, session_factory):
    user = await _sign_in(client, session_factory, "free")
    for n in range(1, 6):
        resp = await _explain(client, _image_body(), user["headers"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["usage"] == {
            "image_captures_used": n, "image_captures_limit": 5, "image_period": "day",
        }

    resp = await _explain(client, _image_body(), user["headers"])
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "IMAGE_LIMIT"
    assert len(ai_calls) == 5
    assert ai_calls[0]["image"] == PNG
    assert ai_calls[0]["media_type"] == "image/png"


async def test_anonymous_image_limit(client, ai_calls):
    for _ in range(5):
        assert (await _explain(client, _image_body())).status_code == 200
    resp = await _explain(client, _image_body())
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "IMAGE_LIMIT"


async def test_lite_image_limit_is_monthly(client, ai_calls, session_factory, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "LITE_IMAGE_MONTHLY_LIMIT", 3)
    user = await _sign_in(client, session_factory, "lite", plan="lite")
    for n in range(1, 4):
        resp = await _explain(client, _image_body(), user["headers"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["usage"] == {
            "image_captures_used": n, "image_captures_limit": 3, "image_period": "month",
        }
    resp = await _explain(client, _image_body(), user["headers"])
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "IMAGE_LIMIT"


async def test_premium_images_are_unlimited_and_use_claude(client, ai_calls, session_factory, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "FREE_IMAGE_DAILY_LIMIT", 1)
    monkeypatch.setattr(settings, "LITE_IMAGE_MONTHLY_LIMIT", 1)
    user = await _sign_in(client, session_factory, "premium", plan="premium")
    for _ in range(4):
        resp = await _explain(client, _image_body(), user["headers"])
        assert resp.status_code == 200, resp.text
    usage = resp.json()["usage"]
    assert usage["image_captures_limit"] is None
    assert usage["image_period"] is None
    assert resp.json()["model_used"] == "claude-sonnet"
    assert all(c["use_claude"] for c in ai_calls)


async def test_image_explain_does_not_consume_reformat_quota(client, ai_calls, session_factory, monkeypatch, fake_redis):
    from app.core.config import settings

    monkeypatch.setattr(settings, "FREE_DAILY_LIMIT", 1)
    user = await _sign_in(client, session_factory, "mixed")
    for _ in range(3):
        assert (await _explain(client, _image_body(), user["headers"])).status_code == 200
    assert f"rl:daily:user:{user['id']}" not in fake_redis.store

    # The single daily text explain is still available.
    assert (await _explain(client, _text_body(), user["headers"])).status_code == 200
    assert (await _explain(client, _text_body(), user["headers"])).status_code == 429


async def test_image_only_circle_without_text(client, ai_calls):
    resp = await _explain(client, _image_body(text=None))
    assert resp.status_code == 200, resp.text
    assert ai_calls[0]["text"] == ""


async def test_image_text_is_truncated(client, ai_calls):
    resp = await _explain(client, _image_body(text="x" * 25_000))
    assert resp.status_code == 200
    assert len(ai_calls[0]["text"]) == 20_000


# ── Burst cap and refunds ─────────────────────────────────────────

async def test_burst_cap_applies_to_everyone(client, ai_calls, session_factory, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXPLAIN_BURST_PER_MINUTE", 2)
    user = await _sign_in(client, session_factory, "burst", plan="premium")
    assert (await _explain(client, _text_body(), user["headers"])).status_code == 200
    assert (await _explain(client, _image_body(), user["headers"])).status_code == 200
    resp = await _explain(client, _text_body(), user["headers"])
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "EXPLAIN_BURST"
    assert "Retry-After" in resp.headers
    assert len(ai_calls) == 2


async def test_ai_failure_refunds_image_unit(client, ai_calls, session_factory, fake_redis):
    from app.models.models import AIUsageEvent

    user = await _sign_in(client, session_factory, "refund")
    assert (await _explain(client, _image_body(), user["headers"])).status_code == 200
    counters = {k: v for k, v in fake_redis.store.items() if k.startswith("rl:img:")}

    ai_calls.fail = True
    resp = await _explain(client, _image_body(), user["headers"])
    assert resp.status_code == 502
    assert resp.json()["detail"]["code"] == "AI_UNAVAILABLE"
    assert "secret" not in resp.text and "provider.example" not in resp.text
    assert {k: v for k, v in fake_redis.store.items() if k.startswith("rl:img:")} == counters

    ai_calls.fail = False
    resp = await _explain(client, _image_body(), user["headers"])
    assert resp.json()["usage"]["image_captures_used"] == 2

    async with session_factory() as session:
        failed = (await session.scalars(
            select(AIUsageEvent).where(AIUsageEvent.succeeded.is_(False))
        )).all()
    assert [e.operation for e in failed] == ["explain_image"]


# ── Validation ────────────────────────────────────────────────────

@pytest.mark.parametrize("body", [
    _text_body(image_base64=PNG, image_media_type="image/png"),
    _text_body(thumbnail_base64=WEBP),
    _text_body(text="   "),
    _text_body(text=None),
    _image_body(image_base64=None),
    _image_body(image_media_type="image/gif"),
    _image_body(image_media_type=None),
    _image_body(image_base64="data:image/png;base64," + PNG),
    _image_body(image_base64="not base64!!"),
    _image_body(thumbnail_base64=PNG),  # not a WebP
    _text_body(anchor={"quote": "x" * 5000}),
])
async def test_invalid_requests_are_400(client, ai_calls, body, fake_redis):
    resp = await _explain(client, body)
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"
    assert ai_calls == []
    # Rejected before any quota was touched.
    assert not any(k.startswith(("rl:explain:", "rl:img:", "rl:daily:")) for k in fake_redis.store)


async def test_oversized_image_is_400(client, ai_calls, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXPLAIN_MAX_IMAGE_BYTES", 32)
    resp = await _explain(client, _image_body())
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"


async def test_oversized_thumbnail_is_400(client, ai_calls, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXPLAIN_MAX_THUMBNAIL_BYTES", 16)
    resp = await _explain(client, _image_body(thumbnail_base64=WEBP))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"


async def test_oversized_image_at_default_limit_is_400(client, ai_calls):
    big = base64.b64encode(b"\x00" * (4 * 1024 * 1024 + 1)).decode()
    resp = await _explain(client, _image_body(image_base64=big))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"


# ── History ───────────────────────────────────────────────────────

async def test_history_saved_for_paid_and_filtered_by_hostname(client, ai_calls, session_factory):
    user = await _sign_in(client, session_factory, "paid", plan="lite")
    h = user["headers"]

    resp = await _explain(client, _text_body(), h)
    entry = resp.json()["history_entry"]
    assert entry is not None
    assert entry["hostname"] == "example.com"  # lowercased, no port
    assert entry["kind"] == "text"
    assert entry["result_html"] == "<div><p>Explained.</p></div>"
    assert entry["anchor"]["quote"] == "Photosynthesis"
    assert entry["thumbnail_url"] is None

    await _explain(client, _image_body(page_url="https://other.example.org/x"), h)
    await _explain(client, _image_body(text="y" * 3000), h)

    resp = await client.get("/api/v1/explain/history", params={"domain": "example.com"}, headers=h)
    assert resp.status_code == 200, resp.text
    entries = resp.json()["entries"]
    assert [e["kind"] for e in entries] == ["image", "text"]  # newest first
    assert all(e["hostname"] == "example.com" for e in entries)
    assert len(entries[0]["source_text"]) == 2000
    assert resp.json()["next_before"] is None

    other = await client.get("/api/v1/explain/history", params={"domain": "other.example.org"}, headers=h)
    assert len(other.json()["entries"]) == 1


async def test_history_pagination(client, ai_calls, session_factory):
    user = await _sign_in(client, session_factory, "pages", plan="premium")
    h = user["headers"]
    for _ in range(3):
        await _explain(client, _text_body(), h)

    first = await client.get("/api/v1/explain/history", params={"domain": "example.com", "limit": 2}, headers=h)
    assert len(first.json()["entries"]) == 2
    cursor = first.json()["next_before"]
    assert cursor is not None
    second = await client.get(
        "/api/v1/explain/history",
        params={"domain": "example.com", "limit": 2, "before": cursor},
        headers=h,
    )
    assert len(second.json()["entries"]) == 1
    assert second.json()["next_before"] is None


async def test_local_file_history_is_grouped_under_local_files(client, ai_calls, session_factory):
    user = await _sign_in(client, session_factory, "localfiles", plan="lite")
    h = user["headers"]
    url = "file:///C:/Users/me/Documents/paper.pdf"
    resp = await _explain(client, _text_body(page_url=url), h)
    entry = resp.json()["history_entry"]
    assert entry["hostname"] == "local-files"
    assert entry["url"] == url

    resp = await client.get("/api/v1/explain/history", params={"domain": "local-files"}, headers=h)
    assert [e["url"] for e in resp.json()["entries"]] == [url]
    resp = await client.delete("/api/v1/explain/history", params={"domain": "local-files"}, headers=h)
    assert resp.status_code == 200, resp.text
    resp = await client.get("/api/v1/explain/history", params={"domain": "local-files"}, headers=h)
    assert resp.json()["entries"] == []


async def test_history_not_saved_for_free_or_without_url(client, ai_calls, session_factory):
    from app.models.models import ExplanationHistory

    free = await _sign_in(client, session_factory, "free")
    resp = await _explain(client, _text_body(), free["headers"])
    assert resp.json()["history_entry"] is None

    paid = await _sign_in(client, session_factory, "paid", plan="premium")
    resp = await _explain(client, _text_body(page_url=""), paid["headers"])
    assert resp.status_code == 200
    assert resp.json()["history_entry"] is None
    resp = await _explain(client, _text_body(page_url="chrome://settings"), paid["headers"])
    assert resp.json()["history_entry"] is None

    async with session_factory() as session:
        assert (await session.scalars(select(ExplanationHistory))).all() == []


async def test_thumbnail_stored_for_paid_image(client, ai_calls, session_factory, fake_storage):
    user = await _sign_in(client, session_factory, "thumbs", plan="lite")
    resp = await _explain(client, _image_body(thumbnail_base64=WEBP), user["headers"])
    entry = resp.json()["history_entry"]
    key = f"explain-thumbnails/{user['id']}/{entry['id']}.webp"
    assert fake_storage.objects[key] == base64.b64decode(WEBP)
    assert entry["thumbnail_url"].startswith("https://bucket.example/")


async def test_get_history_requires_paid_and_auth(client, session_factory):
    resp = await client.get("/api/v1/explain/history", params={"domain": "example.com"})
    assert resp.status_code == 401

    free = await _sign_in(client, session_factory, "free")
    resp = await client.get("/api/v1/explain/history", params={"domain": "example.com"}, headers=free["headers"])
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "HISTORY_REQUIRES_PAID"


async def test_delete_entry_of_another_user_is_404(client, ai_calls, session_factory, fake_storage):
    alice = await _sign_in(client, session_factory, "alice", plan="premium")
    bob = await _sign_in(client, session_factory, "bob", plan="premium")
    bob_entry = (await _explain(client, _image_body(thumbnail_base64=WEBP), bob["headers"])).json()["history_entry"]

    resp = await client.delete(f"/api/v1/explain/history/{bob_entry['id']}", headers=alice["headers"])
    assert resp.status_code == 404
    resp = await client.delete(f"/api/v1/explain/history/{uuid.uuid4()}", headers=bob["headers"])
    assert resp.status_code == 404
    resp = await client.delete(f"/api/v1/explain/history/{bob_entry['id']}")
    assert resp.status_code == 401
    assert len(fake_storage.objects) == 1

    resp = await client.delete(f"/api/v1/explain/history/{bob_entry['id']}", headers=bob["headers"])
    assert resp.status_code == 204
    assert fake_storage.objects == {}
    resp = await client.get("/api/v1/explain/history", params={"domain": "example.com"}, headers=bob["headers"])
    assert resp.json()["entries"] == []


async def test_lapsed_subscriber_can_still_delete(client, ai_calls, session_factory):
    from app.models.models import User

    user = await _sign_in(client, session_factory, "lapsed", plan="lite")
    entry = (await _explain(client, _text_body(), user["headers"])).json()["history_entry"]
    async with session_factory() as session:
        row = await session.get(User, user["id"])
        row.plan = "free"
        await session.commit()

    resp = await client.delete(f"/api/v1/explain/history/{entry['id']}", headers=user["headers"])
    assert resp.status_code == 204


async def test_delete_by_domain_and_all(client, ai_calls, session_factory):
    alice = await _sign_in(client, session_factory, "alice", plan="premium")
    bob = await _sign_in(client, session_factory, "bob", plan="premium")
    for _ in range(2):
        await _explain(client, _text_body(), alice["headers"])
    await _explain(client, _text_body(page_url="https://b.example/"), alice["headers"])
    await _explain(client, _text_body(), bob["headers"])

    resp = await client.delete("/api/v1/explain/history", params={"domain": "Example.com"}, headers=alice["headers"])
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 2}

    resp = await client.delete("/api/v1/explain/history", params={"all": "true"}, headers=alice["headers"])
    assert resp.json() == {"deleted": 1}

    # Bob's entry survived both of Alice's bulk deletes.
    resp = await client.get("/api/v1/explain/history", params={"domain": "example.com"}, headers=bob["headers"])
    assert len(resp.json()["entries"]) == 1


@pytest.mark.parametrize("params", [{}, {"domain": "example.com", "all": "true"}, {"all": "false"}])
async def test_bulk_delete_needs_exactly_one_selector(client, session_factory, params):
    user = await _sign_in(client, session_factory, "bulk")
    resp = await client.delete("/api/v1/explain/history", params=params, headers=user["headers"])
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"


async def test_bulk_delete_requires_auth(client):
    resp = await client.delete("/api/v1/explain/history", params={"all": "true"})
    assert resp.status_code == 401


# ── Thumbnail retention purge ─────────────────────────────────────

async def test_purge_clears_expired_thumbnails(client, session_factory, fake_storage):
    from app.models.models import ExplanationHistory
    from app.services.explain_storage import purge_expired_thumbnails

    user = await _sign_in(client, session_factory, "purge", plan="premium")
    now = datetime.now(timezone.utc)
    expired_id, fresh_id = uuid.uuid4(), uuid.uuid4()
    fake_storage.objects = {"old.webp": b"x", "new.webp": b"y"}

    async with session_factory() as session:
        for row_id, key, expires in (
            (expired_id, "old.webp", now - timedelta(days=1)),
            (fresh_id, "new.webp", now + timedelta(days=1)),
        ):
            session.add(ExplanationHistory(
                id=row_id, user_id=user["id"], hostname="example.com", kind="image",
                result_html="<div></div>", anchor={}, thumbnail_key=key,
                thumbnail_expires_at=expires,
            ))
        await session.commit()

    async with session_factory() as session:
        assert await purge_expired_thumbnails(session) == 1

    assert fake_storage.objects == {"new.webp": b"y"}
    async with session_factory() as session:
        expired = await session.get(ExplanationHistory, expired_id)
        fresh = await session.get(ExplanationHistory, fresh_id)
        assert expired.thumbnail_key is None and expired.thumbnail_expires_at is None
        assert expired.result_html == "<div></div>"  # the text result stays
        assert fresh.thumbnail_key == "new.webp"


async def test_purge_keeps_key_when_delete_fails(client, session_factory, fake_storage):
    from app.models.models import ExplanationHistory
    from app.services.explain_storage import purge_expired_thumbnails

    user = await _sign_in(client, session_factory, "purgefail", plan="premium")
    row_id = uuid.uuid4()
    async with session_factory() as session:
        session.add(ExplanationHistory(
            id=row_id, user_id=user["id"], hostname="example.com", kind="image",
            result_html="<div></div>", anchor={}, thumbnail_key="old.webp",
            thumbnail_expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        ))
        await session.commit()

    fake_storage.fail_deletes = True
    async with session_factory() as session:
        assert await purge_expired_thumbnails(session) == 0
    async with session_factory() as session:
        assert (await session.get(ExplanationHistory, row_id)).thumbnail_key == "old.webp"


async def test_purge_is_noop_without_storage(session_factory):
    from app.services.explain_storage import purge_expired_thumbnails

    async with session_factory() as session:
        assert await purge_expired_thumbnails(session) == 0


# ── Re-explain ────────────────────────────────────────────────────

def _reexplain(mode="simpler", **extra) -> dict:
    return {"mode": mode, "previous_html": "<div><p>First version.</p></div>", **extra}


async def test_reexplain_sends_previous_version_and_mode(client, ai_calls):
    resp = await _explain(client, _text_body(reexplain=_reexplain("more_detail")))
    assert resp.status_code == 200, resp.text
    assert ai_calls[0]["reexplain"] == {
        "mode": "more_detail", "request": None, "previous_html": "<div><p>First version.</p></div>",
    }
    status = resp.json()["reexplain"]
    assert status == {"free": True, "free_remaining": 9, "free_limit": 10}


async def test_specific_reexplain_needs_a_request(client, ai_calls):
    resp = await _explain(client, _text_body(reexplain=_reexplain("specific", request="   ")))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"
    assert ai_calls == []

    resp = await _explain(client, _text_body(reexplain=_reexplain("specific", request="Use a cooking analogy")))
    assert resp.status_code == 200
    assert ai_calls[0]["reexplain"]["request"] == "Use a cooking analogy"


async def test_ten_free_reexplains_then_charged_like_explains(client, ai_calls, monkeypatch, fake_redis):
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXPLAIN_BURST_PER_MINUTE", 100)
    monkeypatch.setattr(settings, "FREE_DAILY_LIMIT", 1)

    # Ten free ones never touch the reformat quota (which only allows 1 here).
    for i in range(10):
        resp = await _explain(client, _text_body(reexplain=_reexplain()))
        assert resp.status_code == 200, resp.text
        assert resp.json()["reexplain"]["free_remaining"] == 9 - i

    # The 11th is charged like a normal explain: it takes the one reformat...
    resp = await _explain(client, _text_body(reexplain=_reexplain()))
    assert resp.status_code == 200
    assert resp.json()["reexplain"] == {"free": False, "free_remaining": 0, "free_limit": 10}
    # ...and the 12th is refused by that quota.
    resp = await _explain(client, _text_body(reexplain=_reexplain()))
    assert resp.status_code == 429
    assert len(ai_calls) == 11


async def test_paid_image_reexplain_counts_as_image_capture(client, ai_calls, session_factory, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "EXPLAIN_BURST_PER_MINUTE", 100)
    monkeypatch.setattr(settings, "EXPLAIN_FREE_REEXPLAINS_PER_DAY", 1)
    user = await _sign_in(client, session_factory, "relook")

    first = await _explain(client, _image_body(reexplain=_reexplain()), user["headers"])
    assert first.json()["usage"] is None  # free re-explain: no image unit used
    assert ai_calls[0]["image"] == PNG    # the kept crop is sent again for the re-look

    second = await _explain(client, _image_body(reexplain=_reexplain()), user["headers"])
    assert second.json()["usage"]["image_captures_used"] == 1


async def test_failed_free_reexplain_is_given_back(client, ai_calls):
    ai_calls.fail = True
    assert (await _explain(client, _text_body(reexplain=_reexplain()))).status_code == 502
    ai_calls.fail = False
    resp = await _explain(client, _text_body(reexplain=_reexplain()))
    assert resp.json()["reexplain"]["free_remaining"] == 9


async def test_paid_reexplain_appends_a_version_to_its_entry(client, ai_calls, session_factory):
    from app.models.models import ExplanationHistory

    user = await _sign_in(client, session_factory, "versions", plan="premium")
    entry = (await _explain(client, _text_body(), user["headers"])).json()["history_entry"]
    assert entry["versions"] == []

    body = _text_body(reexplain=_reexplain("specific", request="Shorter please", parent_entry_id=entry["id"]))
    updated = (await _explain(client, body, user["headers"])).json()["history_entry"]
    assert updated["id"] == entry["id"]
    assert [(v["mode"], v["request"]) for v in updated["versions"]] == [("specific", "Shorter please")]
    assert updated["result_html"] == entry["result_html"]  # the original stays as v1

    async with session_factory() as session:
        rows = (await session.scalars(select(ExplanationHistory))).all()
    assert len(rows) == 1 and len(rows[0].versions) == 1


async def test_reexplain_cannot_append_to_another_users_entry(client, ai_calls, session_factory):
    from app.models.models import ExplanationHistory

    alice = await _sign_in(client, session_factory, "alice", plan="premium")
    bob = await _sign_in(client, session_factory, "bob", plan="premium")
    entry = (await _explain(client, _text_body(), alice["headers"])).json()["history_entry"]

    body = _text_body(reexplain=_reexplain(parent_entry_id=entry["id"]))
    bobs = (await _explain(client, body, bob["headers"])).json()["history_entry"]
    assert bobs["id"] != entry["id"]  # saved as Bob's own new entry instead

    async with session_factory() as session:
        alices = await session.get(ExplanationHistory, uuid.UUID(entry["id"]))
    assert alices.versions == []


async def test_reexplain_is_not_written_to_the_feedback_log(client, ai_calls, session_factory):
    from app.models.models import FeedbackLog

    user = await _sign_in(client, session_factory, "nolog")
    await _explain(client, _text_body(reexplain=_reexplain()), user["headers"])
    async with session_factory() as session:
        assert (await session.scalars(select(FeedbackLog))).all() == []
