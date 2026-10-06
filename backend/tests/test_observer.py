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
