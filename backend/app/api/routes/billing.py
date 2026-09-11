from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.models import User, Billing
from app.schemas.schemas import (
    CheckoutRequest,
    CheckoutResponse,
    CheckoutConfirmRequest,
    BillingOut,
    ChangePlanRequest,
    InvoiceOut,
    PaymentMethodOut,
    UsageOut,
)
from datetime import datetime, timezone
import stripe
import asyncio

stripe.api_key = settings.STRIPE_SECRET_KEY

router = APIRouter(prefix="/billing", tags=["billing"])


def _frontend_url(path: str = "") -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}"


def _subscription_period_end(sub) -> datetime | None:
    """Return the subscription's current period end as a datetime.

    Newer Stripe API versions (2025+, e.g. 2026-05-27.dahlia) expose
    current_period_end on each subscription *item* rather than on the
    subscription root, so we check the root first and fall back to the item
    for backward compatibility.
    """
    ts = sub.get("current_period_end")
    if ts is None:
        try:
            ts = sub["items"]["data"][0]["current_period_end"]
        except (KeyError, IndexError, TypeError):
            ts = None
    return datetime.utcfromtimestamp(ts) if ts is not None else None


def _normalize_subscription_status(status: str | None) -> str:
    if status in ("active", "trialing", "past_due"):
        return status
    if status in ("canceled", "cancelled"):
        return "cancelled"
    return "past_due"


def _plan_for_subscription(sub, status: str, renews_at: datetime | None) -> str:
    """Resolve the plan tier a subscription grants, honoring status and expiry.

    The tier ("lite" or "premium") is derived from the subscription's price ID so
    that Thinker Lite and Deep Thinker map to distinct entitlements.
    """
    if status not in ("active", "trialing"):
        return "free"
    if renews_at is not None and renews_at <= datetime.utcnow():
        return "free"
    try:
        price_id = sub["items"]["data"][0]["price"]["id"]
    except (KeyError, IndexError, TypeError):
        # Fall back to premium if the shape is unexpected — never silently downgrade a payer.
        return "premium"
    return settings.price_plan_map.get(price_id, "premium")


def _billing_period_for_subscription(sub) -> str:
    """Resolve the billing cadence from the subscription's price ID.

    Unknown or unexpectedly shaped prices fall back to "monthly", which matches
    the Billing model's default.
    """
    try:
        price_id = sub["items"]["data"][0]["price"]["id"]
    except (KeyError, IndexError, TypeError):
        return "monthly"
    return settings.price_period_map.get(price_id, "monthly")


@router.get("/status", response_model=BillingOut)
async def billing_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns the current billing status for the authenticated user."""
    result = await db.execute(
        select(Billing).where(Billing.user_id == current_user.id)
    )
    billing = result.scalar_one_or_none()
    if not billing:
        raise HTTPException(status_code=404, detail="Billing record not found.")
    
    # Proactively check for expiration if a webhook was missed. Postgres returns
    # timezone-aware datetimes, so compare against an aware "now" (and defensively
    # coerce a naive renews_at) to avoid naive/aware comparison TypeErrors.
    now = datetime.now(timezone.utc)
    renews_at = billing.renews_at
    if renews_at is not None and renews_at.tzinfo is None:
        renews_at = renews_at.replace(tzinfo=timezone.utc)
    if billing.plan in ("premium", "lite") and renews_at and renews_at < now:
        billing.plan = "free"
        billing.status = "cancelled"
        billing.cancelled_at = now
        current_user.plan = "free"
        current_user.updated_at = now
        await db.flush()

    return billing


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout(
    body: CheckoutRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Creates a Stripe Checkout session for upgrading to Premium.
    Returns a checkout_url the frontend redirects to.
    """
    # ── 1. Validate price_id ──────────────────────────────────────
    if body.price_id not in settings.allowed_price_ids:
        raise HTTPException(
            status_code=400,
            detail="Invalid or unauthorized price ID."
        )

    # ── 2. Get or create Stripe customer ──────────────────────────
    result = await db.execute(
        select(Billing).where(Billing.user_id == current_user.id)
    )
    billing = result.scalar_one_or_none()

    if billing and billing.stripe_customer_id:
        customer_id = billing.stripe_customer_id
    else:
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            email=current_user.email,
            name=current_user.name,
            metadata={"user_id": str(current_user.id)},
        )
        customer_id = customer.id

        if billing:
            billing.stripe_customer_id = customer_id
        else:
            from sqlalchemy.exc import IntegrityError
            async with db.begin_nested():
                try:
                    billing = Billing(
                        user_id=current_user.id,
                        stripe_customer_id=customer_id,
                        plan="free",
                    )
                    db.add(billing)
                    await db.flush()
                except IntegrityError:
                    # Concurrent creation - refetch
                    pass
            
            if not billing or not billing.id:
                result = await db.execute(
                    select(Billing).where(Billing.user_id == current_user.id)
                )
                billing = result.scalar_one_or_none()
                if not billing:
                    raise HTTPException(status_code=500, detail="Billing sync error.")
                billing.stripe_customer_id = customer_id
        
        await db.flush()

    # Create checkout session with 7-day trial. Redirects are server-owned to
    # avoid open redirects and duplicated query strings.
    session = await asyncio.to_thread(
        stripe.checkout.Session.create,
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": body.price_id, "quantity": 1}],
        mode="subscription",
        subscription_data={"trial_period_days": 7},
        success_url=_frontend_url("/billing/success?session_id={CHECKOUT_SESSION_ID}"),
        cancel_url=_frontend_url("/billing/cancelled"),
        metadata={"user_id": str(current_user.id)},
    )

    return CheckoutResponse(checkout_url=session.url)


@router.post("/confirm", response_model=BillingOut)
async def confirm_checkout(
    body: CheckoutConfirmRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Fallback activation used by the post-payment redirect. Verifies a completed
    Checkout Session and syncs the plan immediately, so the dashboard reflects the
    upgrade even if the Stripe webhook is delayed or (in local dev) can't reach us.
    """
    try:
        session = await asyncio.to_thread(stripe.checkout.Session.retrieve, body.session_id)
    except stripe.error.StripeError:
        raise HTTPException(status_code=400, detail="Could not retrieve checkout session.")

    # Ownership guard: the session must have been created for this user.
    if str(session.get("metadata", {}).get("user_id")) != str(current_user.id):
        raise HTTPException(status_code=403, detail="This checkout session does not belong to you.")

    subscription_id = session.get("subscription")
    customer_id = session.get("customer")
    if not subscription_id:
        raise HTTPException(status_code=400, detail="No subscription found on this session.")

    sub = await asyncio.to_thread(stripe.Subscription.retrieve, subscription_id)
    await _activate_premium(db, current_user.id, customer_id, subscription_id, sub)

    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if not billing:
        raise HTTPException(status_code=404, detail="Billing record not found.")
    return billing


@router.post("/portal")
async def billing_portal(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Opens the Stripe customer portal so users can manage/cancel their subscription.
    """
    result = await db.execute(
        select(Billing).where(Billing.user_id == current_user.id)
    )
    billing = result.scalar_one_or_none()

    if not billing or not billing.stripe_customer_id:
        raise HTTPException(status_code=400, detail="No billing record found.")

    session = await asyncio.to_thread(
        stripe.billing_portal.Session.create,
        customer=billing.stripe_customer_id,
        return_url=_frontend_url("/dashboard"),
    )

    return {"portal_url": session.url}


# ── SUBSCRIPTION MANAGEMENT ───────────────────────────────────────

async def _live_subscription(db, user: User) -> tuple[Billing, str]:
    """Fetch the caller's billing row and assert it has a subscription to act on.

    Every management action needs the same two things and fails the same way
    without them, so the check lives here rather than in each endpoint.
    """
    result = await db.execute(select(Billing).where(Billing.user_id == user.id))
    billing = result.scalar_one_or_none()
    if not billing:
        raise HTTPException(status_code=404, detail="Billing record not found.")
    if not billing.stripe_subscription_id:
        raise HTTPException(
            status_code=400,
            detail="You do not have an active subscription to manage.",
        )
    return billing, billing.stripe_subscription_id


def _sync_from_subscription(billing: Billing, sub) -> None:
    """Copy the authoritative Stripe subscription state onto the billing row."""
    status = _normalize_subscription_status(sub.get("status"))
    period_end = _subscription_period_end(sub)
    billing.status = status
    billing.plan = _plan_for_subscription(sub, status, period_end)
    billing.billing_period = _billing_period_for_subscription(sub)
    billing.cancel_at_period_end = bool(sub.get("cancel_at_period_end"))
    billing.renews_at = period_end
    billing.updated_at = datetime.utcnow()


@router.post("/cancel", response_model=BillingOut)
async def cancel_subscription(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Schedules cancellation at the end of the current billing period.

    The user keeps the access they have already paid for; the plan drops to free
    when Stripe fires customer.subscription.deleted at period end. This is
    reversible via POST /billing/resume until that moment.
    """
    billing, subscription_id = await _live_subscription(db, current_user)

    if billing.cancel_at_period_end:
        # Already scheduled — return current state rather than erroring, so a
        # double-submit from the UI is harmless.
        return billing

    try:
        sub = await asyncio.to_thread(
            stripe.Subscription.modify,
            subscription_id,
            cancel_at_period_end=True,
        )
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Could not cancel subscription: {e.user_message or 'Stripe error.'}")

    _sync_from_subscription(billing, sub)
    billing.cancelled_at = datetime.utcnow()
    await db.flush()
    return billing


@router.post("/resume", response_model=BillingOut)
async def resume_subscription(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Clears a scheduled cancellation, so the subscription renews as normal.

    Only valid while the period has not yet ended — once Stripe has actually
    deleted the subscription the user must check out again.
    """
    billing, subscription_id = await _live_subscription(db, current_user)

    try:
        sub = await asyncio.to_thread(
            stripe.Subscription.modify,
            subscription_id,
            cancel_at_period_end=False,
        )
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Could not resume subscription: {e.user_message or 'Stripe error.'}")

    _sync_from_subscription(billing, sub)
    billing.cancelled_at = None
    await db.flush()
    return billing


@router.post("/change-plan", response_model=BillingOut)
async def change_plan(
    body: ChangePlanRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Moves an existing subscription to a different price, prorated.

    Stripe credits the unused portion of the current plan against the new one,
    so an upgrade charges only the difference and a downgrade leaves a credit.
    """
    if body.price_id not in settings.allowed_price_ids:
        raise HTTPException(status_code=400, detail="Invalid or unauthorized price ID.")

    billing, subscription_id = await _live_subscription(db, current_user)

    try:
        sub = await asyncio.to_thread(stripe.Subscription.retrieve, subscription_id)
        items = sub["items"]["data"]
        if not items:
            raise HTTPException(status_code=400, detail="Subscription has no line items to change.")

        current_price_id = items[0]["price"]["id"]
        if current_price_id == body.price_id:
            raise HTTPException(status_code=400, detail="You are already on this plan.")

        updated = await asyncio.to_thread(
            stripe.Subscription.modify,
            subscription_id,
            items=[{"id": items[0]["id"], "price": body.price_id}],
            proration_behavior="create_prorations",
            # A plan change is a deliberate purchase decision — don't silently
            # keep an unfinished trial running on the new price.
            trial_end="now" if sub.get("status") == "trialing" else None,
        )
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=400, detail=f"Could not change plan: {e.user_message or 'Stripe error.'}")

    _sync_from_subscription(billing, updated)
    # The tier changed, so the denormalised copy on the user must follow.
    current_user.plan = billing.plan
    current_user.updated_at = datetime.utcnow()
    await db.flush()
    return billing


@router.get("/invoices", response_model=list[InvoiceOut])
async def list_invoices(
    limit: int = 12,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Past invoices for the caller. Empty list when they have never paid."""
    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if not billing or not billing.stripe_customer_id:
        return []

    try:
        invoices = await asyncio.to_thread(
            stripe.Invoice.list,
            customer=billing.stripe_customer_id,
            limit=max(1, min(limit, 100)),
        )
    except stripe.error.StripeError:
        raise HTTPException(status_code=400, detail="Could not load billing history.")

    return [
        InvoiceOut(
            id=inv["id"],
            number=inv.get("number"),
            created=datetime.fromtimestamp(inv["created"], tz=timezone.utc),
            amount_paid=inv.get("amount_paid", 0),
            amount_due=inv.get("amount_due", 0),
            currency=(inv.get("currency") or "usd").upper(),
            status=inv.get("status"),
            description=inv.get("description"),
            hosted_invoice_url=inv.get("hosted_invoice_url"),
            invoice_pdf=inv.get("invoice_pdf"),
        )
        for inv in invoices.get("data", [])
        # Drafts are not yet real charges and would confuse a receipts list.
        if inv.get("status") != "draft"
    ]


@router.get("/payment-method", response_model=PaymentMethodOut)
async def get_payment_method(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    The card on file, for display only.

    Returns empty fields rather than 404 when there is no card, so the UI can
    render a neutral "no payment method" state without treating it as an error.
    Updating a card always happens in Stripe's hosted portal — raw card details
    must never reach this server.
    """
    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if not billing or not billing.stripe_customer_id:
        return PaymentMethodOut()

    try:
        customer = await asyncio.to_thread(
            stripe.Customer.retrieve,
            billing.stripe_customer_id,
            expand=["invoice_settings.default_payment_method"],
        )
        pm = (customer.get("invoice_settings") or {}).get("default_payment_method")

        # Customers created before a default was set still have the card on the
        # subscription itself — fall back to the first attached card.
        if not pm:
            methods = await asyncio.to_thread(
                stripe.PaymentMethod.list,
                customer=billing.stripe_customer_id,
                type="card",
                limit=1,
            )
            data = methods.get("data", [])
            pm = data[0] if data else None
    except stripe.error.StripeError:
        return PaymentMethodOut()

    if not pm:
        return PaymentMethodOut()

    card = pm.get("card") or {}
    return PaymentMethodOut(
        brand=card.get("brand"),
        last4=card.get("last4"),
        exp_month=card.get("exp_month"),
        exp_year=card.get("exp_year"),
    )


@router.get("/usage", response_model=UsageOut)
async def get_usage(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Quota consumed against the caller's tier.

    Reads the same Redis counters and lifetime row that
    app/services/rate_limit.py enforces, so the meter cannot disagree with the
    429 the reformat endpoint would return. Fails soft: if Redis is unreachable
    the counts come back as 0 rather than breaking the billing screen.
    """
    from datetime import timedelta
    from app.services.rate_limit import redis_client
    from app.models.models import UsageTracking
    from redis.exceptions import RedisError

    entitlement = await _entitled_plan(db, current_user)
    now = datetime.now(timezone.utc)

    # Premium and institutional have no ceiling.
    if entitlement in ("premium", "institutional"):
        return UsageOut(
            plan=entitlement,
            unlimited=True,
            limit_type="none",
            used=0,
            limit=None,
            remaining=None,
            resets_at=None,
        )

    async def _count(key: str) -> int:
        try:
            value = await redis_client.get(key)
            return int(value) if value else 0
        except (RedisError, ValueError):
            return 0

    # Thinker Lite — a monthly cap, resetting at the start of next month.
    if entitlement == "lite":
        used = await _count(f"rl:month:user:{current_user.id}:{now.strftime('%Y%m')}")
        next_month = (now.replace(day=1) + timedelta(days=32)).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        limit = settings.LITE_MONTHLY_LIMIT
        return UsageOut(
            plan="lite",
            unlimited=False,
            limit_type="monthly",
            used=used,
            limit=limit,
            remaining=max(0, limit - used),
            resets_at=next_month,
        )

    # Free tier — a daily cap that rolls over at midnight UTC, plus a hard
    # lifetime cap tracked in Postgres.
    used = await _count(f"rl:daily:user:{current_user.id}")
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

    tracking = await db.execute(
        select(UsageTracking).where(UsageTracking.fingerprint == str(current_user.id))
    )
    row = tracking.scalar_one_or_none()

    limit = settings.FREE_DAILY_LIMIT
    return UsageOut(
        plan="free",
        unlimited=False,
        limit_type="daily",
        used=used,
        limit=limit,
        remaining=max(0, limit - used),
        resets_at=midnight,
        lifetime_used=row.lifetime_requests if row else 0,
        lifetime_limit=settings.FREE_LIFETIME_LIMIT,
    )


async def _entitled_plan(db, user: User) -> str:
    """The tier the caller is actually entitled to right now.

    Mirrors rate_limit._active_paid_plan: a lapsed or non-active subscription
    falls back to free, whatever the stored plan says.
    """
    if user.plan == "institutional":
        return "institutional"
    if user.plan not in ("lite", "premium"):
        return "free"

    result = await db.execute(select(Billing).where(Billing.user_id == user.id))
    billing = result.scalar_one_or_none()
    if not billing or billing.plan not in ("lite", "premium"):
        return "free"
    if billing.status not in ("active", "trialing"):
        return "free"

    renews_at = billing.renews_at
    if renews_at is not None and renews_at.tzinfo is None:
        renews_at = renews_at.replace(tzinfo=timezone.utc)
    if renews_at is not None and renews_at <= datetime.now(timezone.utc):
        return "free"
    return billing.plan


# ── STRIPE WEBHOOKS ───────────────────────────────────────────────
webhook_router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@webhook_router.post("/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    """
    Handles Stripe webhook events to keep our billing table in sync.

    Events handled:
    - checkout.session.completed     → activate subscription
    - customer.subscription.updated  → plan changes, renewals
    - customer.subscription.deleted  → cancellation
    - invoice.payment_failed         → mark as past_due
    """
    if not stripe_signature:
        raise HTTPException(status_code=400, detail="Missing Stripe-Signature header.")

    payload = await request.body()

    try:
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, settings.STRIPE_WEBHOOK_SECRET
        )
    except (stripe.error.SignatureVerificationError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid webhook signature or payload.")

    data = event["data"]["object"]

    # ── Subscription activated (after checkout or trial) ──────────
    if event["type"] == "checkout.session.completed":
        user_id = data["metadata"].get("user_id")
        subscription_id = data.get("subscription")
        customer_id = data.get("customer")

        if user_id and subscription_id:
            sub = await asyncio.to_thread(stripe.Subscription.retrieve, subscription_id)
            await _activate_premium(db, user_id, customer_id, subscription_id, sub)

    # ── Subscription updated (renewal, plan change) ───────────────
    elif event["type"] == "customer.subscription.updated":
        await _update_subscription(db, data)

    # ── Subscription cancelled ────────────────────────────────────
    elif event["type"] == "customer.subscription.deleted":
        await _cancel_subscription(db, data)

    # ── Payment failed ────────────────────────────────────────────
    elif event["type"] == "invoice.payment_failed":
        customer_id = data.get("customer")
        if customer_id:
            result = await db.execute(
                select(Billing).where(Billing.stripe_customer_id == customer_id)
            )
            billing = result.scalar_one_or_none()
            await db.execute(
                update(Billing)
                .where(Billing.stripe_customer_id == customer_id)
                .values(plan="free", status="past_due", updated_at=datetime.utcnow())
            )
            if billing:
                await db.execute(
                    update(User)
                    .where(User.id == billing.user_id)
                    .values(plan="free", updated_at=datetime.utcnow())
                )
            await db.commit()

    return {"received": True}


async def _activate_premium(db, user_id, customer_id, subscription_id, sub):
    period_end = _subscription_period_end(sub)
    trial_end = (
        datetime.utcfromtimestamp(sub["trial_end"])
        if sub.get("trial_end") else None
    )
    status = _normalize_subscription_status(sub.get("status"))
    plan = _plan_for_subscription(sub, status, period_end)

    # Update billing table
    await db.execute(
        update(Billing)
        .where(Billing.user_id == user_id)
        .values(
            stripe_customer_id=customer_id,
            stripe_subscription_id=subscription_id,
            plan=plan,
            status=status,
            billing_period=_billing_period_for_subscription(sub),
            # A fresh checkout supersedes any earlier scheduled cancellation.
            cancel_at_period_end=bool(sub.get("cancel_at_period_end")),
            cancelled_at=None,
            renews_at=period_end,
            trial_ends_at=trial_end,
            updated_at=datetime.utcnow(),
        )
    )
    # Update user plan
    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(plan=plan, updated_at=datetime.utcnow())
    )
    await db.commit()


async def _update_subscription(db, sub_data):
    subscription_id = sub_data["id"]
    period_end = _subscription_period_end(sub_data)
    status = _normalize_subscription_status(sub_data.get("status", "active"))
    plan = _plan_for_subscription(sub_data, status, period_end)

    result = await db.execute(
        select(Billing).where(Billing.stripe_subscription_id == subscription_id)
    )
    billing = result.scalar_one_or_none()

    await db.execute(
        update(Billing)
        .where(Billing.stripe_subscription_id == subscription_id)
        .values(
            plan=plan,
            status=status,
            billing_period=_billing_period_for_subscription(sub_data),
            # Keeps us in step when the user cancels or resumes from Stripe's
            # own portal rather than our screen.
            cancel_at_period_end=bool(sub_data.get("cancel_at_period_end")),
            renews_at=period_end,
            updated_at=datetime.utcnow(),
        )
    )
    if billing:
        await db.execute(
            update(User)
            .where(User.id == billing.user_id)
            .values(plan=plan, updated_at=datetime.utcnow())
        )
    await db.commit()


async def _cancel_subscription(db, sub_data):
    subscription_id = sub_data["id"]

    # Downgrade to free
    result = await db.execute(
        select(Billing).where(Billing.stripe_subscription_id == subscription_id)
    )
    billing = result.scalar_one_or_none()
    if billing:
        await db.execute(
            update(Billing)
            .where(Billing.stripe_subscription_id == subscription_id)
            .values(
                plan="free",
                status="cancelled",
                # The subscription is gone, so there is nothing left pending.
                cancel_at_period_end=False,
                cancelled_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
        )
        await db.execute(
            update(User)
            .where(User.id == billing.user_id)
            .values(plan="free", updated_at=datetime.utcnow())
        )
        await db.commit()
