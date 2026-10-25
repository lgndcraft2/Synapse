"""
Opt-in smoke test against Paystack's real *test mode*: checkout, trial,
card-check refund, card, update-card link, cancel, resume, plan change,
history and account deletion — every Paystack call billing makes, for real.

Skipped unless PAYSTACK_LIVE_TEST=1 and PAYSTACK_SECRET_KEY is an sk_test_
key (export the backend's .env values first). The database is the suite's
in-memory SQLite, never the configured one.

The hosted checkout page needs a browser, so the payment is made with
Paystack's test card through the Charge API, on the reference our checkout
created (or, if Paystack refuses that reference, a fresh one).
"""

import json
import os
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.models import Billing
from app.services import paystack

from tests.test_tenant_isolation import _sign_in

pytestmark = pytest.mark.skipif(
    os.environ.get("PAYSTACK_LIVE_TEST") != "1" or not settings.PAYSTACK_SECRET_KEY.startswith("sk_test_"),
    reason="live Paystack test mode only (PAYSTACK_LIVE_TEST=1 and an sk_test_ key)",
)

LITE, DEEP = settings.PAYSTACK_THINKER_LITE_PLAN_CODE, settings.PAYSTACK_DEEP_THINKER_PLAN_CODE


def _api(method, path, **kwargs):
    r = httpx.request(method, f"https://api.paystack.co{path}", timeout=30,
                      headers={"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"}, **kwargs)
    return r.json()


def _pay_with_test_card(email, amount, reference, metadata):
    return _api("POST", "/charge", json={
        "email": email, "amount": str(amount), "reference": reference,
        "currency": settings.PAYSTACK_CURRENCY, "metadata": json.dumps(metadata),
        "card": {"number": "4084084084084081", "cvv": "408", "expiry_month": "12", "expiry_year": "2030"},
    })


async def test_full_flow_against_paystack_test_mode(client, session_factory):
    log = lambda *a: print("  ·", *a)  # noqa: E731
    user = await _sign_in(client, session_factory, "paystack-live")

    # 1. Checkout
    resp = await client.post("/api/v1/billing/checkout", json={"price_id": LITE}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    url = resp.json()["checkout_url"]
    assert url.startswith("https://checkout.paystack.com/")
    log("checkout url:", url)

    async with session_factory() as session:
        billing = await session.scalar(select(Billing).where(Billing.user_id == user["id"]))
        reference = billing.checkout_reference
    txn = await paystack.verify_transaction(reference)
    meta = paystack.metadata_of(txn)

    # 2. Pay the card check with the test card
    charge = _pay_with_test_card(user["email"], txn["amount"], reference, meta)
    log("charge on checkout reference:", charge.get("message"), (charge.get("data") or {}).get("status"))
    if not charge.get("status") or (charge.get("data") or {}).get("status") != "success":
        reference = f"syn-checkout-{uuid.uuid4().hex}"
        charge = _pay_with_test_card(user["email"], txn["amount"], reference, meta)
        log("charge on fresh reference:", charge.get("message"), (charge.get("data") or {}).get("status"))
        assert (charge.get("data") or {}).get("status") == "success", charge
        async with session_factory() as session:
            billing = await session.scalar(select(Billing).where(Billing.user_id == user["id"]))
            billing.checkout_reference = reference
            await session.commit()

    # 3. Confirm (the success-page redirect)
    resp = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    log("after confirm:", body["plan"], body["status"], "first charge", body["renews_at"])
    assert body["plan"] == "lite" and body["status"] == "trialing"
    code = body["subscription_id"]
    sub = await paystack.fetch_subscription(code)
    log("paystack subscription:", code, sub["status"], "next payment", sub.get("next_payment_date"))

    recent = _api("GET", "/refund", params={"perPage": 20}).get("data") or []
    refunds = [r for r in recent if reference in json.dumps(r)]
    log("card-check refund:", [(r.get("status"), r.get("amount")) for r in refunds])
    assert refunds, "no refund found for the card check"

    # A second confirm (page refresh) must not create another subscription.
    again = await client.post("/api/v1/billing/confirm", json={"reference": reference}, headers=user["headers"])
    assert again.status_code == 200 and again.json()["subscription_id"] == code

    # 4. Card and update-card link
    card = (await client.get("/api/v1/billing/payment-method", headers=user["headers"])).json()
    log("card:", card)
    assert card["last4"] == "4081"
    portal = await client.post("/api/v1/billing/portal", headers=user["headers"])
    assert portal.status_code == 200, portal.text
    log("update-card link:", portal.json()["portal_url"][:60] + "…")

    # 5. Cancel, then resume
    resp = await client.post("/api/v1/billing/cancel", headers=user["headers"])
    assert resp.status_code == 200, resp.text
    sub = await paystack.fetch_subscription(code)
    log("after cancel:", resp.json()["plan"], "cancel_at_period_end", resp.json()["cancel_at_period_end"],
        "| paystack:", sub["status"], sub.get("next_payment_date"))
    assert resp.json()["cancel_at_period_end"] is True and resp.json()["plan"] == "lite"

    resp = await client.post("/api/v1/billing/resume", headers=user["headers"])
    assert resp.status_code == 200, resp.text
    cancelled_code, code = code, resp.json()["subscription_id"]
    sub = await paystack.fetch_subscription(code)
    log("after resume:", resp.json()["status"], "cancel_at_period_end", resp.json()["cancel_at_period_end"],
        "| replacement:", code, sub["status"], sub.get("next_payment_date"),
        "| cancelled one:", (await paystack.fetch_subscription(cancelled_code))["status"])
    assert resp.json()["cancel_at_period_end"] is False and code != cancelled_code

    # 6. Change plan during the trial (charges the new plan in full)
    resp = await client.post("/api/v1/billing/change-plan", json={"price_id": DEEP}, headers=user["headers"])
    assert resp.status_code == 200, resp.text
    new = resp.json()
    old = await paystack.fetch_subscription(code)
    fresh = await paystack.fetch_subscription(new["subscription_id"])
    log("after change:", new["plan"], new["status"], "renews", new["renews_at"])
    log("old sub:", old["status"], "| new sub:", fresh["status"], fresh.get("next_payment_date"))
    assert new["plan"] == "premium" and old["status"] in ("non-renewing", "cancelled")

    # 7. Payment history
    inv = (await client.get("/api/v1/billing/invoices", headers=user["headers"])).json()
    log("history:", [(r["description"], r["status"], r["amount_paid"], r["currency"]) for r in inv["data"]])
    assert any(r["description"] == "Plan change" for r in inv["data"])

    # 8. Account deletion disables the subscription (also cleans up test mode)
    resp = await client.request("DELETE", "/api/v1/auth/account", headers=user["headers"])
    assert resp.status_code == 204, resp.text
    final = await paystack.fetch_subscription(new["subscription_id"])
    log("after deletion, new sub:", final["status"])
    assert final["status"] in ("non-renewing", "cancelled")
