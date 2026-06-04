from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.models import User, Billing
from app.schemas.schemas import CheckoutRequest, CheckoutResponse, BillingOut
from datetime import datetime
import stripe
import asyncio

stripe.api_key = settings.STRIPE_SECRET_KEY

router = APIRouter(prefix="/billing", tags=["billing"])


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
    
    # Proactively check for expiration
    now = datetime.utcnow()
    if billing.plan == "premium" and billing.renews_at and billing.renews_at < now:
        # User has expired but webhook was missed - update local state
        billing.status = "expired"
        # We don't downgrade the plan string here to keep DB in sync with Stripe's 
        # last known state, but the UI/routing will see it's inactive.
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
    allowed_prices = [
        settings.STRIPE_PREMIUM_PRICE_ID,
        settings.STRIPE_PREMIUM_ANNUAL_PRICE_ID
    ]
    if body.price_id not in allowed_prices:
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

    # Create checkout session with 7-day trial
    session = await asyncio.to_thread(
        stripe.checkout.Session.create,
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": body.price_id, "quantity": 1}],
        mode="subscription",
        subscription_data={"trial_period_days": 7},
        success_url=body.success_url + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url=body.cancel_url,
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
        return_url=f"{settings.FRONTEND_URL}/dashboard",
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
            await db.execute(
                update(Billing)
                .where(Billing.stripe_customer_id == customer_id)
                .values(status="past_due", updated_at=datetime.utcnow())
            )
            await db.commit()

    return {"received": True}


async def _activate_premium(db, user_id, customer_id, subscription_id, sub):
    period_end = datetime.utcfromtimestamp(sub["current_period_end"])
    trial_end = (
        datetime.utcfromtimestamp(sub["trial_end"])
        if sub.get("trial_end") else None
    )
    status = "trialing" if sub.get("status") == "trialing" else "active"

    # Update billing table
    await db.execute(
        update(Billing)
        .where(Billing.user_id == user_id)
        .values(
            stripe_customer_id=customer_id,
            stripe_subscription_id=subscription_id,
            plan="premium",
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
        .values(plan="premium", updated_at=datetime.utcnow())
    )
    await db.commit()


async def _update_subscription(db, sub_data):
    subscription_id = sub_data["id"]
    period_end = datetime.utcfromtimestamp(sub_data["current_period_end"])
    status = sub_data.get("status", "active")

    await db.execute(
        update(Billing)
        .where(Billing.stripe_subscription_id == subscription_id)
        .values(
            status=status,
            renews_at=period_end,
            updated_at=datetime.utcnow(),
        )
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
