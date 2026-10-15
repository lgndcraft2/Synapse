"""
Paystack billing: checkout with a trial, idempotent activation, cancel and
resume, prorated plan changes, webhooks and the payment history.

Paystack itself is replaced by FakePaystack, which keeps just enough state
(transactions, subscriptions, refunds) to prove what we asked it to do.
"""

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.api.routes.billing import _add_months, _prorate
from app.core.config import settings
from app.models.models import Billing, User
from app.services.paystack import PaystackError

from tests.test_tenant_isolation import _sign_in

PLANS = {
    "PLN_lite_monthly": {"plan_code": "PLN_lite_monthly", "amount": 400, "interval": "monthly", "name": "Thinker Lite"},
    "PLN_deep_monthly": {"plan_code": "PLN_deep_monthly", "amount": 800, "interval": "monthly", "name": "Deep Thinker"},
    "PLN_lite_annual": {"plan_code": "PLN_lite_annual", "amount": 4000, "interval": "annually", "name": "Thinker Lite"},
    "PLN_deep_annual": {"plan_code": "PLN_deep_annual", "amount": 8000, "interval": "annually", "name": "Deep Thinker"},
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class FakePaystack:
    def __init__(self):
        self.customers: dict[str, dict] = {}
        self.transactions: dict[str, dict] = {}
        self.subscriptions: dict[str, dict] = {}
        self.refunds: list[dict] = []
        self.charges: list[dict] = []
        self.created_subscriptions: list[dict] = []
        self.decline_charges = False

    # customers
    async def create_customer(self, email, name, user_id):
        code = f"CUS_{uuid.uuid4().hex[:10]}"
        self.customers[code] = {"id": len(self.customers) + 1, "customer_code": code, "email": email, "authorizations": []}
        return self.customers[code]

    async def fetch_customer(self, code):
        return self.customers[code]

    async def fetch_plan(self, code):
        return PLANS[code]

    # transactions
    async def initialize_transaction(self, **body):
        meta = json.loads(body["metadata"])
        email = body["email"]
        customer = next(c for c in self.customers.values() if c["email"] == email)
        self.transactions[body["reference"]] = {
            "id": len(self.transactions) + 1000,
            "reference": body["reference"],
            "status": "abandoned",
            "amount": int(body["amount"]),
            "currency": body["currency"],
            "metadata": meta,
            "customer": {"customer_code": customer["customer_code"], "email": email},
            "authorization": {"authorization_code": "AUTH_ok", "reusable": True, "last4": "4081",
                              "brand": "visa", "exp_month": "12", "exp_year": "2030", "channel": "card"},
            "paid_at": None,
            "plan": None,
        }
        return {"authorization_url": f"https://checkout.paystack.com/{body['reference']}", "reference": body["reference"]}

    def pay(self, reference):
        txn = self.transactions[reference]
        txn["status"] = "success"
        txn["paid_at"] = _iso(datetime.now(timezone.utc))
        return txn

    async def verify_transaction(self, reference):
        if reference not in self.transactions:
            raise PaystackError("Transaction reference not found", 404)
        return self.transactions[reference]

    async def charge_authorization(self, **body):
        if self.decline_charges:
            return {"status": "failed", "reference": body["reference"]}
        self.charges.append(body)
        email = body["email"]
        customer = next(c for c in self.customers.values() if c["email"] == email)
        self.transactions[body["reference"]] = {
            "id": len(self.transactions) + 1000, "reference": body["reference"], "status": "success",
            "amount": int(body["amount"]), "currency": body["currency"], "metadata": json.loads(body["metadata"]),
            "customer": {"customer_code": customer["customer_code"]}, "paid_at": _iso(datetime.now(timezone.utc)), "plan": None,
        }
        return {"status": "success", "reference": body["reference"]}

    async def list_transactions(self, customer_id, per_page, page):
        customer = next(c for c in self.customers.values() if c["id"] == customer_id)
        rows = [t for t in reversed(list(self.transactions.values()))
                if t["customer"]["customer_code"] == customer["customer_code"]]
        start = (page - 1) * per_page
        page_count = max(1, -(-len(rows) // per_page))
        return {"status": True, "data": rows[start:start + per_page],
                "meta": {"total": len(rows), "page": page, "perPage": per_page, "pageCount": page_count}}

    async def refund(self, transaction, amount=None, merchant_note=None):
        self.refunds.append({"transaction": transaction, "amount": amount, "note": merchant_note})
        for txn in self.transactions.values():
            if transaction in (txn["reference"], str(txn["id"])) and amount is None:
                txn["status"] = "reversed"
        return {"id": len(self.refunds), "status": "pending"}

    # subscriptions
    async def create_subscription(self, customer, plan, authorization, start_date):
        code = f"SUB_{uuid.uuid4().hex[:10]}"
        sub = {
            "subscription_code": code, "email_token": f"tok_{code}", "status": "active",
            "plan": PLANS[plan], "amount": PLANS[plan]["amount"],
            "next_payment_date": _iso(start_date),
            "authorization": {"authorization_code": authorization, "last4": "4081", "brand": "visa",
                              "exp_month": "12", "exp_year": "2030", "channel": "card"},
            "customer": {"customer_code": customer, "email": self.customers[customer]["email"]},
        }
        self.subscriptions[code] = sub
        self.created_subscriptions.append({"customer": customer, "plan": plan, "start_date": start_date})
        return sub

    async def fetch_subscription(self, code):
        return self.subscriptions[code]

    async def disable_subscription(self, code, email_token):
        assert self.subscriptions[code]["email_token"] == email_token
        self.subscriptions[code]["status"] = "non-renewing"

    async def enable_subscription(self, code, email_token):
        assert self.subscriptions[code]["email_token"] == email_token
        self.subscriptions[code]["status"] = "active"

    async def manage_link(self, code):
        return f"https://paystack.com/manage/subscriptions/{code}"


@pytest.fixture
def fake_paystack(monkeypatch):
    import app.services.paystack as module

    fake = FakePaystack()
    for name in (
        "create_customer", "fetch_customer", "fetch_plan", "initialize_transaction", "verify_transaction",
        "charge_authorization", "list_transactions", "refund", "create_subscription", "fetch_subscription",
        "disable_subscription", "enable_subscription", "manage_link",
    ):
        monkeypatch.setattr(module, name, getattr(fake, name))
    return fake


def _signed(body: dict) -> tuple[bytes, dict]:
    raw = json.dumps(body).encode()
    sig = hmac.new(settings.PAYSTACK_SECRET_KEY.encode(), raw, hashlib.sha512).hexdigest()
    return raw, {"x-paystack-signature": sig, "content-type": "application/json"}


async def _subscribe(client, fake, user, plan="PLN_lite_monthly"):
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": plan}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    reference = resp.json()["checkout_url"].rsplit("/", 1)[1]
    fake.pay(reference)
    resp = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    return reference, resp.json()


async def _billing(session_factory, user_id) -> Billing:
    async with session_factory() as session:
        return await session.scalar(select(Billing).where(Billing.user_id == user_id))


# ── Checkout ──────────────────────────────────────────────────────

async def test_checkout_starts_trial_and_refunds_card_check(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "trial")
    reference, body = await _subscribe(client, fake_paystack, user)

    assert body["plan"] == "lite"
    assert body["status"] == "trialing"
    assert body["subscription_id"].startswith("SUB_")
    # The card check is a small charge, refunded once the subscription exists.
    txn = fake_paystack.transactions[reference]
    assert txn["amount"] == settings.PAYSTACK_CARD_CHECK_AMOUNT
    assert fake_paystack.refunds == [{"transaction": reference, "amount": None, "note": "Card check for a free trial"}]
    # The subscription's first charge is deferred to the end of the trial.
    created = fake_paystack.created_subscriptions[0]
    delta = created["start_date"] - datetime.now(timezone.utc)
    assert timedelta(days=settings.TRIAL_DAYS) - timedelta(minutes=5) < delta <= timedelta(days=settings.TRIAL_DAYS)

    async with session_factory() as session:
        stored = await session.scalar(select(User).where(User.id == user["id"]))
        assert stored.plan == "lite"


async def test_redirect_and_webhook_create_one_subscription(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "twice")
    reference, _ = await _subscribe(client, fake_paystack, user)

    # The webhook for the same payment, then a refresh of the success page.
    raw, headers = _signed({"event": "charge.success", "data": fake_paystack.transactions[reference]})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200
    again = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=user["headers"])
    assert again.status_code == 200

    assert len(fake_paystack.created_subscriptions) == 1
    assert len(fake_paystack.refunds) == 1


async def test_webhook_alone_activates_checkout(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "hookonly")
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])
    reference = resp.json()["checkout_url"].rsplit("/", 1)[1]
    txn = fake_paystack.pay(reference)

    raw, headers = _signed({"event": "charge.success", "data": txn})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200

    billing = await _billing(session_factory, user["id"])
    assert billing.plan == "premium" and billing.status == "trialing"


async def test_confirm_rejects_another_users_checkout(client, session_factory, fake_paystack):
    alice = await _sign_in(client, session_factory, "alice")
    mallory = await _sign_in(client, session_factory, "mallory")
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": "PLN_lite_monthly"}, headers=alice["headers"])
    reference = resp.json()["checkout_url"].rsplit("/", 1)[1]
    fake_paystack.pay(reference)

    resp = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=mallory["headers"])
    assert resp.status_code == 403
    assert fake_paystack.created_subscriptions == []


async def test_unpaid_checkout_is_not_activated(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "unpaid")
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": "PLN_lite_monthly"}, headers=user["headers"])
    reference = resp.json()["checkout_url"].rsplit("/", 1)[1]

    resp = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=user["headers"])
    assert resp.status_code == 400
    assert fake_paystack.created_subscriptions == []


async def test_second_checkout_is_refused_while_subscribed(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "double")
    await _subscribe(client, fake_paystack, user)
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])
    assert resp.status_code == 400


async def test_unknown_plan_code_is_rejected(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "badplan")
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": "PLN_made_up"}, headers=user["headers"])
    assert resp.status_code == 400


# ── Cancel / resume ───────────────────────────────────────────────

async def test_cancel_keeps_access_then_resume(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "cancel")
    _, body = await _subscribe(client, fake_paystack, user)
    code = body["subscription_id"]

    resp = await client.post("/api/v1/billing/cancel", headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["cancel_at_period_end"] is True
    assert resp.json()["plan"] == "lite"
    assert fake_paystack.subscriptions[code]["status"] == "non-renewing"

    resp = await client.post("/api/v1/billing/resume", headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["cancel_at_period_end"] is False
    assert fake_paystack.subscriptions[code]["status"] == "active"


# ── Plan changes ──────────────────────────────────────────────────

async def test_change_plan_in_trial_charges_new_plan_in_full(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "trialchange")
    _, body = await _subscribe(client, fake_paystack, user)
    old_code = body["subscription_id"]

    resp = await client.post("/api/v1/billing/change-plan", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["plan"] == "premium" and out["status"] == "active"
    assert out["subscription_id"] != old_code
    assert [c["amount"] for c in fake_paystack.charges] == ["800"]
    assert fake_paystack.subscriptions[old_code]["status"] == "non-renewing"


async def _paying_subscriber(client, session_factory, fake, label, plan="PLN_lite_monthly", days_left=15):
    """A subscriber past their trial, midway through a paid period."""
    user = await _sign_in(client, session_factory, label)
    _, body = await _subscribe(client, fake, user, plan)
    code = body["subscription_id"]
    period_end = datetime.now(timezone.utc) + timedelta(days=days_left)
    fake.subscriptions[code]["next_payment_date"] = _iso(period_end)
    async with session_factory() as session:
        billing = await session.scalar(select(Billing).where(Billing.user_id == user["id"]))
        billing.trial_ends_at = datetime.now(timezone.utc) - timedelta(days=30)
        billing.status = "active"
        billing.renews_at = period_end
        await session.commit()
    return user, code, period_end


async def test_upgrade_charges_prorated_difference_and_keeps_billing_date(client, session_factory, fake_paystack):
    user, old_code, period_end = await _paying_subscriber(client, session_factory, fake_paystack, "upgrade")

    resp = await client.post("/api/v1/billing/change-plan", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])
    assert resp.status_code == 200, resp.text

    charged = int(fake_paystack.charges[0]["amount"])
    # About half a month of the $4 difference.
    assert 150 <= charged <= 250
    assert fake_paystack.created_subscriptions[-1]["start_date"] == period_end.replace(microsecond=period_end.microsecond)
    assert fake_paystack.subscriptions[old_code]["status"] == "non-renewing"


async def test_downgrade_refunds_prorated_credit(client, session_factory, fake_paystack):
    user, _, _ = await _paying_subscriber(client, session_factory, fake_paystack, "downgrade", plan="PLN_deep_monthly")
    # A real renewal payment for the refund to be taken from.
    customer = next(iter(c for c in fake_paystack.customers.values() if c["email"] == user["email"]))
    fake_paystack.transactions["renewal-1"] = {
        "id": 99, "reference": "renewal-1", "status": "success", "amount": 800, "currency": "USD",
        "metadata": {}, "customer": {"customer_code": customer["customer_code"]},
        "paid_at": _iso(datetime.now(timezone.utc)), "plan": PLANS["PLN_deep_monthly"],
    }

    resp = await client.post("/api/v1/billing/change-plan", json={"price_id": "PLN_lite_monthly"}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["plan"] == "lite"
    assert fake_paystack.charges == []
    refund = fake_paystack.refunds[-1]
    assert refund["transaction"] == "99"
    assert 150 <= refund["amount"] <= 250


async def test_declined_upgrade_changes_nothing(client, session_factory, fake_paystack):
    user, old_code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "declined")
    fake_paystack.decline_charges = True

    resp = await client.post("/api/v1/billing/change-plan", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])
    assert resp.status_code == 402
    billing = await _billing(session_factory, user["id"])
    assert billing.plan == "lite" and billing.paystack_subscription_code == old_code
    assert fake_paystack.subscriptions[old_code]["status"] == "active"


def test_prorate_cross_interval_credits_unused_time():
    now = datetime.now(timezone.utc)
    period_end = _add_months(now, 6)  # half of an annual period left
    net, start = _prorate(PLANS["PLN_lite_annual"], PLANS["PLN_deep_monthly"], period_end, trialing=False)
    # ~$20 of credit against an $8 month: a refund of about $12.
    assert -1300 <= net <= -1100
    assert (start - _add_months(now, 1)).total_seconds() < 5


def test_add_months_clamps_day():
    assert _add_months(datetime(2026, 1, 31), 1) == datetime(2026, 2, 28)
    assert _add_months(datetime(2026, 3, 31), -1) == datetime(2026, 2, 28)
    assert _add_months(datetime(2026, 11, 15), 2) == datetime(2027, 1, 15)


# ── Webhooks ──────────────────────────────────────────────────────

async def test_webhook_rejects_bad_signature(client, fake_paystack):
    raw = json.dumps({"event": "charge.success", "data": {}}).encode()
    resp = await client.post("/api/v1/webhooks/paystack", content=raw, headers={"x-paystack-signature": "nope"})
    assert resp.status_code == 400


async def test_disable_webhook_at_period_end_downgrades(client, session_factory, fake_paystack):
    user, code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "ended")
    async with session_factory() as session:
        billing = await session.scalar(select(Billing).where(Billing.user_id == user["id"]))
        billing.renews_at = datetime.now(timezone.utc)
        await session.commit()

    raw, headers = _signed({"event": "subscription.disable", "data": {"subscription_code": code, "status": "complete"}})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200

    billing = await _billing(session_factory, user["id"])
    assert billing.plan == "free" and billing.status == "cancelled"
    assert billing.paystack_subscription_code is None


async def test_early_disable_webhook_keeps_paid_access(client, session_factory, fake_paystack):
    user, code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "early")
    raw, headers = _signed({"event": "subscription.disable", "data": {"subscription_code": code}})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200

    billing = await _billing(session_factory, user["id"])
    assert billing.plan == "lite" and billing.cancel_at_period_end is True


async def test_payment_failed_webhook_marks_past_due(client, session_factory, fake_paystack):
    user, code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "failed")
    raw, headers = _signed({"event": "invoice.payment_failed", "data": {"subscription": {"subscription_code": code}}})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200

    billing = await _billing(session_factory, user["id"])
    assert billing.plan == "free" and billing.status == "past_due"


async def test_not_renew_webhook_from_paystack_page_schedules_cancel(client, session_factory, fake_paystack):
    user, code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "notrenew")
    fake_paystack.subscriptions[code]["status"] = "non-renewing"
    raw, headers = _signed({"event": "subscription.not_renew", "data": {"subscription_code": code}})
    assert (await client.post("/api/v1/webhooks/paystack", content=raw, headers=headers)).status_code == 200

    billing = await _billing(session_factory, user["id"])
    assert billing.cancel_at_period_end is True and billing.plan == "lite"


# ── History, card, portal ─────────────────────────────────────────

async def test_history_hides_card_checks_and_other_customers(client, session_factory, fake_paystack):
    user, _, _ = await _paying_subscriber(client, session_factory, fake_paystack, "history")
    await client.post("/api/v1/billing/change-plan", json={"price_id": "PLN_deep_monthly"}, headers=user["headers"])

    resp = await client.get("/api/v1/billing/invoices", headers=user["headers"])
    assert resp.status_code == 200
    rows = resp.json()["data"]
    assert [r["description"] for r in rows] == ["Plan change"]
    assert rows[0]["status"] == "paid" and rows[0]["currency"] == "USD"
    assert resp.headers["cache-control"] == "no-store, private"


async def test_history_is_empty_without_a_customer(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "nohistory")
    resp = await client.get("/api/v1/billing/invoices", headers=user["headers"])
    assert resp.status_code == 200 and resp.json()["data"] == []


async def test_payment_method_and_portal_link(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "card")
    _, body = await _subscribe(client, fake_paystack, user)

    card = (await client.get("/api/v1/billing/payment-method", headers=user["headers"])).json()
    assert card == {"brand": "visa", "last4": "4081", "exp_month": 12, "exp_year": 2030}

    portal = await client.post("/api/v1/billing/portal", headers=user["headers"])
    assert portal.json()["portal_url"].endswith(body["subscription_id"])


async def test_account_deletion_disables_subscription(client, session_factory, fake_paystack):
    user = await _sign_in(client, session_factory, "deleteme")
    _, body = await _subscribe(client, fake_paystack, user)

    resp = await client.request("DELETE", "/api/v1/auth/account", headers=user["headers"])
    assert resp.status_code == 204, resp.text
    assert fake_paystack.subscriptions[body["subscription_id"]]["status"] == "non-renewing"


async def test_status_asks_paystack_before_expiring_a_renewed_plan(client, session_factory, fake_paystack):
    """A renewal whose webhook never arrived must not drop a payer to free."""
    user, code, _ = await _paying_subscriber(client, session_factory, fake_paystack, "latehook")
    next_period = datetime.now(timezone.utc) + timedelta(days=30)
    fake_paystack.subscriptions[code]["next_payment_date"] = _iso(next_period)
    async with session_factory() as session:
        billing = await session.scalar(select(Billing).where(Billing.user_id == user["id"]))
        billing.renews_at = datetime.now(timezone.utc) - timedelta(hours=2)
        await session.commit()

    resp = await client.get("/api/v1/billing/status", headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["plan"] == "lite" and resp.json()["status"] == "active"
