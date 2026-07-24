from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.models import User, Billing
from app.schemas.schemas import CheckoutRequest, CheckoutResponse, BillingOut
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
        success_url=_frontend_url("/dashboard?session_id={CHECKOUT_SESSION_ID}"),
        cancel_url=_frontend_url("/"),
        metadata={"user_id": str(current_user.id)},
    )

    return CheckoutResponse(checkout_url=session.url)


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
