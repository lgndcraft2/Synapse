"""Thin async client for the parts of the Paystack API billing uses.

Paystack has no official Python SDK, and the surface we need is small, so this
talks to the REST API directly over httpx. Every call raises PaystackError on a
transport failure or a `status: false` envelope, so routes handle one exception
type and never show a provider message to the user verbatim.
"""

import hashlib
import hmac
import json
from datetime import datetime

import httpx

from app.core.config import settings

BASE_URL = "https://api.paystack.co"
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


class PaystackError(Exception):
    """A Paystack call failed. `message` is Paystack's own text, for logs only."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


async def _request(method: str, path: str, *, json_body: dict | None = None, params: dict | None = None):
    headers = {"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"}
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=_TIMEOUT) as client:
            response = await client.request(method, path, json=json_body, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise PaystackError(f"Could not reach Paystack: {exc.__class__.__name__}") from exc

    try:
        payload = response.json()
    except ValueError:
        raise PaystackError(f"Paystack returned a non-JSON {response.status_code}", response.status_code)

    if response.status_code >= 400 or not payload.get("status"):
        raise PaystackError(payload.get("message") or "Paystack request failed", response.status_code)
    return payload


async def _data(method: str, path: str, **kwargs):
    return (await _request(method, path, **kwargs)).get("data")


def iso(dt: datetime) -> str:
    return dt.isoformat()


def parse_time(value) -> datetime | None:
    """Paystack timestamps are ISO 8601 strings ending in Z."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def metadata_of(obj: dict) -> dict:
    """Transaction metadata comes back as a dict or, depending on how it was
    sent, as a JSON string."""
    meta = obj.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            return {}
    return meta if isinstance(meta, dict) else {}


def verify_signature(payload: bytes, signature: str | None) -> bool:
    """Webhooks are signed with HMAC-SHA512 of the raw body, keyed by the secret key."""
    if not signature:
        return False
    expected = hmac.new(settings.PAYSTACK_SECRET_KEY.encode(), payload, hashlib.sha512).hexdigest()
    return hmac.compare_digest(expected, signature)


# ── Customers ─────────────────────────────────────────────────────

async def create_customer(email: str, name: str | None, user_id: str) -> dict:
    first, _, last = (name or "").partition(" ")
    try:
        return await _data("POST", "/customer", json_body={
            "email": email,
            "first_name": first or None,
            "last_name": last or None,
            "metadata": {"user_id": user_id},
        })
    except PaystackError:
        # Customers are unique by email on an integration; one that already
        # exists (an earlier checkout, a dashboard import) is reused.
        return await fetch_customer(email)


async def fetch_customer(code: str) -> dict:
    return await _data("GET", f"/customer/{code}")


# ── Plans ─────────────────────────────────────────────────────────

async def fetch_plan(code: str) -> dict:
    return await _data("GET", f"/plan/{code}")


# ── Transactions ──────────────────────────────────────────────────

async def initialize_transaction(**body) -> dict:
    return await _data("POST", "/transaction/initialize", json_body=body)


async def verify_transaction(reference: str) -> dict:
    return await _data("GET", f"/transaction/verify/{reference}")


async def charge_authorization(**body) -> dict:
    return await _data("POST", "/transaction/charge_authorization", json_body=body)


async def list_transactions(customer_id: int, per_page: int, page: int) -> dict:
    """The whole envelope, because callers need `meta` for paging."""
    return await _request("GET", "/transaction", params={
        "customer": customer_id, "perPage": per_page, "page": page,
    })


async def refund(transaction: str, amount: int | None = None, merchant_note: str | None = None) -> dict:
    body: dict = {"transaction": transaction}
    if amount is not None:
        body["amount"] = amount
    if merchant_note:
        body["merchant_note"] = merchant_note
    return await _data("POST", "/refund", json_body=body)


# ── Subscriptions ─────────────────────────────────────────────────

async def create_subscription(customer: str, plan: str, authorization: str, start_date: datetime) -> dict:
    return await _data("POST", "/subscription", json_body={
        "customer": customer,
        "plan": plan,
        "authorization": authorization,
        "start_date": iso(start_date),
    })


async def fetch_subscription(code: str) -> dict:
    return await _data("GET", f"/subscription/{code}")


async def disable_subscription(code: str, email_token: str) -> None:
    await _request("POST", "/subscription/disable", json_body={"code": code, "token": email_token})


async def enable_subscription(code: str, email_token: str) -> None:
    await _request("POST", "/subscription/enable", json_body={"code": code, "token": email_token})


async def manage_link(code: str) -> str:
    return (await _data("GET", f"/subscription/{code}/manage/link"))["link"]
