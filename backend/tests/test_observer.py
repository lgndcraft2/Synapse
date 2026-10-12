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
        "failed_payments",
        "open_tickets",
    }
    assert len(body["traffic"]) == 7


async def test_observer_analytics_counts_plans_and_features(client, verified_user, session_factory, monkeypatch):
    import uuid
    from datetime import datetime, timedelta

    from app.models.models import AIUsageEvent, Billing, User

    login = await client.post("/api/v1/auth/login", json=verified_user)
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.get("/api/v1/observer/analytics", headers=headers)).status_code == 403
    monkeypatch.setattr(settings, "ADMIN_EMAILS", verified_user["email"])

    later = datetime.utcnow() + timedelta(days=20)
    lite = User(id=uuid.uuid4(), email="lite@example.com", plan="lite")
    lapsed = User(id=uuid.uuid4(), email="lapsed@example.com", plan="lite")
    premium = User(id=uuid.uuid4(), email="premium@example.com", plan="premium")
    school = User(id=uuid.uuid4(), email="school@example.com", plan="institutional")

    def event(user, operation, source, succeeded=True):
        return AIUsageEvent(
            user_id=user.id if user else None, provider="gemini", operation=operation,
            source=source, succeeded=succeeded,
        )

    async with session_factory() as session:
        session.add_all([lite, lapsed, premium, school])
        await session.flush()
        session.add_all([
            Billing(user_id=lite.id, plan="lite", status="active", billing_period="monthly", renews_at=later),
            Billing(user_id=lapsed.id, plan="lite", status="past_due", billing_period="monthly", renews_at=later),
            Billing(user_id=premium.id, plan="premium", status="active", billing_period="annual",
                    renews_at=later, cancel_at_period_end=True),
            event(lite, "explain_text", "page"),
            event(lite, "explain_text", "page", succeeded=False),
            event(lite, "explain_image", "page"),
            event(premium, "explain_image", "pdf"),
            event(premium, "document_reformat", "pdf"),
            event(lapsed, "document_reformat", "document"),
            event(None, "reformat", "page"),
            event(school, "explain_text", None),  # recorded before sources existed
        ])
        await session.commit()

    response = await client.get("/api/v1/observer/analytics?days=7", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()

    users = body["users"]
    assert users["total"] == 5
    assert users["paid"] == 3  # past-due lite is not paid
    assert users["active_window"] == 4  # the anonymous reformat is not a person

    plans = {row["plan"]: row for row in body["plans"]}
    assert [row["plan"] for row in body["plans"]] == ["free", "lite", "premium", "institutional"]
    assert plans["free"]["users"] == 1
    assert plans["lite"] == {
        "plan": "lite", "users": 2, "active": 1, "trialing": 0, "past_due": 1,
        "cancel_scheduled": 0, "monthly": 1, "annual": 0, "est_mrr_usd": 4.0,
    }
    assert plans["premium"]["annual"] == 1
    assert plans["premium"]["cancel_scheduled"] == 1
    assert plans["premium"]["est_mrr_usd"] == round(settings.PREMIUM_ANNUAL_USD / 12, 2)
    assert plans["institutional"]["active"] == 1

    features = {row["feature"]: row for row in body["features"]}
    assert features["explain_text"]["calls"] == 3
    assert features["explain_text"]["users"] == 2
    assert features["explain_text"]["failures"] == 1
    assert features["explain_text"]["adoption"] == 0.5
    # A circle in the PDF viewer is PDF use, not a web-page circle.
    assert features["explain_image"]["calls"] == 1
    assert features["pdf"]["calls"] == 2
    assert features["pdf"]["users"] == 1
    assert features["document_reformat"]["calls"] == 1
    assert features["page_reformat"] == {
        "feature": "page_reformat", "calls": 1, "users": 0, "anonymous_calls": 1,
        "failures": 0, "adoption": 0.0,
    }
    assert body["pdf_breakdown"] == {"explain_text": 0, "explain_image": 1, "document_reformat": 1}

    by_plan = {row["feature"]: row for row in body["feature_by_plan"]}
    assert by_plan["explain_text"]["lite"] == 1
    assert by_plan["explain_text"]["institutional"] == 1
    assert by_plan["pdf"]["premium"] == 1

    assert len(body["signups"]) == 7
    assert sum(day["paid"] for day in body["signups"]) == 3
    assert sum(day["free"] for day in body["signups"]) == 2
    assert len(body["feature_daily"]) == 7
    assert sum(day["calls"]["explain_text"] for day in body["feature_daily"]) == 3


async def test_observer_queries_never_group_by_a_bound_parameter(client, verified_user, session_factory, db_engine, monkeypatch):
    """Postgres rejects GROUP BY expressions holding bound parameters.

    asyncpg numbers a literal separately in SELECT and GROUP BY ($1 vs $2), so
    Postgres can't match the two expressions and the request answers 500.
    SQLite accepts the same SQL, so check the statements themselves.
    """
    import re

    from sqlalchemy import event, select

    from app.models.models import FeedbackLog, User

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == verified_user["email"]))
        session.add_all([FeedbackLog(user_id=user.id, reaction=None), FeedbackLog(user_id=user.id, reaction="clearer")])
        await session.commit()

    statements: list[str] = []
    listener = lambda conn, cursor, statement, *args: statements.append(statement)  # noqa: E731
    event.listen(db_engine.sync_engine, "before_cursor_execute", listener)
    try:
        monkeypatch.setattr(settings, "ADMIN_EMAILS", verified_user["email"])
        login = await client.post("/api/v1/auth/login", json=verified_user)
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        overview = await client.get("/api/v1/observer/overview", headers=headers)
        assert overview.status_code == 200, overview.text
        assert (await client.get("/api/v1/observer/analytics", headers=headers)).status_code == 200
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", listener)

    reactions = {row["reaction"]: row["count"] for row in overview.json()["product_insights"]["feedback_reactions"]}
    assert reactions == {"unrated": 1, "clearer": 1}

    group_bys = [
        match.group(1)
        for statement in statements
        for match in re.finditer(r"GROUP BY (.*?)(?=\bORDER BY\b|\bHAVING\b|\bLIMIT\b|\)|$)", statement, re.S)
    ]
    assert group_bys, "expected the observer to run grouped queries"
    assert not [clause for clause in group_bys if "?" in clause]


async def test_viewer_opens_are_counted_without_content(client, verified_user, session_factory, fake_redis):
    from sqlalchemy import select

    from app.api.routes import viewer
    from app.models.models import User, ViewerOpen

    login = await client.post("/api/v1/auth/login", json=verified_user)
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    assert (await client.post("/api/v1/viewer/opened", headers=headers)).status_code == 204
    assert (await client.post("/api/v1/viewer/opened")).status_code == 204

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == verified_user["email"]))
        opens = (await session.scalars(select(ViewerOpen))).all()
    assert sorted(str(o.user_id) for o in opens) == sorted([str(user.id), "None"])

    # Past the hourly cap, opens still answer 204 but are not stored.
    fake_redis.store[next(k for k in fake_redis.store if k.startswith("viewer:opens:"))] = str(viewer._OPENS_PER_HOUR)
    assert (await client.post("/api/v1/viewer/opened")).status_code == 204
    async with session_factory() as session:
        assert len((await session.scalars(select(ViewerOpen))).all()) == 2


async def test_observer_analytics_measures_the_viewer_and_reformats(client, verified_user, session_factory, monkeypatch):
    import uuid

    from app.models.models import AIUsageEvent, User, ViewerOpen

    monkeypatch.setattr(settings, "ADMIN_EMAILS", verified_user["email"])
    login = await client.post("/api/v1/auth/login", json=verified_user)
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    reader = User(id=uuid.uuid4(), email="reader@example.com", plan="free")
    explainer = User(id=uuid.uuid4(), email="explainer@example.com", plan="free")

    def event(user, operation, source, **flags):
        return AIUsageEvent(
            user_id=user.id if user else None, provider="gemini", operation=operation,
            source=source, duration_ms=1000, **flags,
        )

    async with session_factory() as session:
        session.add_all([reader, explainer])
        await session.flush()
        session.add_all([
            ViewerOpen(user_id=reader.id),
            ViewerOpen(user_id=reader.id),
            ViewerOpen(user_id=explainer.id),
            ViewerOpen(user_id=None),
            event(explainer, "explain_text", "pdf"),
            event(explainer, "document_reformat", "pdf", cut_off=True),
            event(None, "document_reformat", "document", cut_off=False),
            event(reader, "reformat", "page", cut_off=False, input_clipped=True),
            event(reader, "reformat", "page", cut_off=True, input_clipped=False),
            event(None, "reformat", "page", succeeded=False),
        ])
        await session.commit()

    body = (await client.get("/api/v1/observer/analytics?days=7", headers=headers)).json()

    viewer = body["viewer"]
    assert {k: viewer[k] for k in ("opens", "users", "anonymous_opens", "ai_users", "ai_share")} == {
        "opens": 4, "users": 2, "anonymous_opens": 1, "ai_users": 1, "ai_share": 0.5,
    }
    assert len(viewer["daily"]) == 7
    assert sum(day["opens"] for day in viewer["daily"]) == 4

    reformats = {row["kind"]: row for row in body["reformats"]}
    assert [row["kind"] for row in body["reformats"]] == ["page", "pdf", "document"]
    assert reformats["page"] == {
        "kind": "page", "calls": 3, "users": 1, "anonymous_calls": 1, "failures": 1,
        "cut_off": 1, "clipped": 1, "average_duration_ms": 1000.0,
    }
    assert reformats["pdf"]["calls"] == 1 and reformats["pdf"]["cut_off"] == 1
    assert reformats["document"]["calls"] == 1 and reformats["document"]["anonymous_calls"] == 1


async def test_page_reformat_records_cut_off_and_clipped(client, session_factory, monkeypatch):
    from sqlalchemy import select

    from app.api.routes import reformat
    from app.models.models import AIUsageEvent
    from app.services.ai import ReformatOutput, SQ4ROutput

    async def fake_gemini(page_text, profile, feedback_summary):
        return ReformatOutput('<div class="syn"><p>Part</p></div>', True)

    async def fake_questions(page_text, profile_type):
        return SQ4ROutput(["Why?"], True, True, 600, 9, 150.0)

    monkeypatch.setattr(reformat, "call_gemini", fake_gemini)
    monkeypatch.setattr(reformat, "generate_sq4r_questions", fake_questions)

    page = "A long page. " * 40
    response = await client.post("/api/v1/reformat", json={
        "page_text": page, "mode": "fullpage", "fingerprint": "fp-reformat-flags",
        "source_characters": len(page) + 5000,
    })
    assert response.status_code == 200, response.text
    # Older extensions don't say how long the page was: clipping is unknown.
    response = await client.post("/api/v1/reformat", json={
        "page_text": page, "mode": "fullpage", "fingerprint": "fp-reformat-flags",
    })
    assert response.status_code == 200, response.text

    assert response.json()["questions"] == ["Why?"]

    async with session_factory() as session:
        events = (await session.scalars(select(AIUsageEvent).order_by(AIUsageEvent.created_at))).all()
    reformats = [e for e in events if e.operation == "reformat"]
    assert [(e.cut_off, e.input_clipped) for e in reformats] == [(True, True), (True, None)]
    # The SQ4R questions call is its own Gemini event, one per reformat.
    sq4r = [e for e in events if e.operation == "sq4r_questions"]
    assert [(e.provider, e.input_characters, e.output_characters, e.duration_ms, e.succeeded) for e in sq4r] == [
        ("gemini", 600, 9, 150, True), ("gemini", 600, 9, 150, True),
    ]


async def test_sq4r_is_recorded_even_when_the_reformat_fails(client, session_factory, monkeypatch):
    from sqlalchemy import select

    from app.api.routes import reformat
    from app.models.models import AIUsageEvent
    from app.services.ai import SQ4ROutput

    async def failing_gemini(page_text, profile, feedback_summary):
        raise RuntimeError("provider down")

    async def fake_questions(page_text, profile_type):
        return SQ4ROutput(None, True, False, 600, 0, 80.0)

    monkeypatch.setattr(reformat, "call_gemini", failing_gemini)
    monkeypatch.setattr(reformat, "generate_sq4r_questions", fake_questions)

    for _ in range(2):
        response = await client.post("/api/v1/reformat", json={
            "page_text": "A page. " * 60, "mode": "fullpage", "fingerprint": "fp-sq4r-fail",
        })
        assert response.status_code == 502

    from app.models.models import UsageTracking

    async with session_factory() as session:
        events = (await session.scalars(select(AIUsageEvent))).all()
        charged = (await session.scalars(select(UsageTracking.lifetime_requests))).all()
    assert sorted((e.operation, e.succeeded) for e in events) == [("reformat", False)] * 2 + [("sq4r_questions", False)] * 2
    # Keeping the records doesn't keep the failed request's lifetime charge.
    # The first request's row insert survives only because SQLite's driver
    # mishandles the limiter's savepoint; Postgres rolls it back. The second
    # request takes the update path, which must not stick.
    assert charged == [1]


async def test_failed_document_reformat_is_recorded(client, session_factory, monkeypatch):
    import base64

    from sqlalchemy import select

    import app.services.ai as ai
    from app.models.models import AIUsageEvent

    async def failing_document(*args, **kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr(ai, "call_document", failing_document)
    response = await client.post("/api/v1/reformat/reformat-document", json={
        "base64_data": base64.b64encode(b"some notes").decode(), "media_type": "text/plain",
        "fingerprint": "fp-doc-fail",
    })
    assert response.status_code == 502

    async with session_factory() as session:
        events = (await session.scalars(select(AIUsageEvent))).all()
    assert [(e.operation, e.source, e.succeeded) for e in events] == [("document_reformat", "document", False)]


async def test_sq4r_skipped_for_hyperfocus_is_not_a_call():
    from app.services.ai import generate_sq4r_questions

    assert (await generate_sq4r_questions("Some text", "hyperfocus")).called is False
