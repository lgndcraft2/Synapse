from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.models import User, Billing
from app.core.plans import (
    ACTIVE_PAID_PLANS,
    DEEP_THINKER_PLAN,
    FREE_PLAN,
    INSTITUTIONAL_PLAN,
    THINKER_LITE_PLAN,
    normalize_plan,
)
from app.schemas.schemas import CheckoutRequest, CheckoutResponse, BillingOut
from datetime import datetime
import stripe
import asyncio

stripe.api_key = settings.STRIPE_SECRET_KEY

PRICE_PLAN_MAP = {
    settings.STRIPE_THINKER_LITE_PRICE_ID: THINKER_LITE_PLAN,
    settings.STRIPE_DEEP_THINKER_PRICE_ID: DEEP_THINKER_PLAN,
}

router = APIRouter(prefix="/billing", tags=["billing"])


def _frontend_url(path: str = "") -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}"


def _plan_from_price_id(price_id: str | None) -> str:
    if not price_id or price_id not in PRICE_PLAN_MAP:
        raise HTTPException(status_code=400, detail="Invalid or unauthorized price ID.")
    return PRICE_PLAN_MAP[price_id]


def _plan_from_subscription_data(sub_data: dict, fallback_plan: str = FREE_PLAN) -> str:
    status = _normalize_subscription_status(sub_data.get("status"))
    current_period_end = sub_data.get("current_period_end")

    if status not in ("active", "trialing") or not current_period_end:
        return FREE_PLAN

    period_end = datetime.utcfromtimestamp(current_period_end)
    if period_end <= datetime.utcnow():
        return FREE_PLAN

    metadata = sub_data.get("metadata") or {}
    metadata_plan = normalize_plan(metadata.get("plan_slug"))
    if metadata_plan in ACTIVE_PAID_PLANS:
        return metadata_plan

    items = (sub_data.get("items") or {}).get("data", [])
    for item in items:
        price = item.get("price")
        price_id = price.get("id") if isinstance(price, dict) else price
        if price_id in PRICE_PLAN_MAP:
            return PRICE_PLAN_MAP[price_id]

    fallback_plan = normalize_plan(fallback_plan)
    return fallback_plan if fallback_plan in ACTIVE_PAID_PLANS else FREE_PLAN


def _normalize_subscription_status(status: str | None) -> str:
    if status in ("active", "trialing", "past_due"):
        return status
    if status in ("canceled", "cancelled"):
        return "cancelled"
    return "past_due"


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

    if normalize_plan(current_user.plan) == INSTITUTIONAL_PLAN:
        if billing.plan != INSTITUTIONAL_PLAN:
            billing.plan = INSTITUTIONAL_PLAN
            billing.status = "active"
            billing.updated_at = datetime.utcnow()
        await db.flush()
        return billing
    
    # Proactively check for expiration if a webhook was missed.
    now = datetime.utcnow()
    normalized_plan = normalize_plan(billing.plan)
    paid_active = (
        normalized_plan in ACTIVE_PAID_PLANS
        and billing.status in ("active", "trialing")
        and (billing.renews_at is None or billing.renews_at > now)
    )

    if paid_active:
        if normalized_plan != billing.plan:
            billing.plan = normalized_plan
            billing.updated_at = now
        if normalize_plan(current_user.plan) != normalized_plan:
            current_user.plan = normalized_plan
            current_user.updated_at = now
    else:
        if normalized_plan in ACTIVE_PAID_PLANS and billing.status in ("active", "trialing") and billing.renews_at and billing.renews_at < now:
            billing.status = "cancelled"
            billing.cancelled_at = now
        if billing.plan != FREE_PLAN:
            billing.plan = FREE_PLAN
            billing.updated_at = now
        if normalize_plan(current_user.plan) != FREE_PLAN:
            current_user.plan = FREE_PLAN
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
    Creates a Stripe Checkout session for upgrading to a paid plan.
    Returns a checkout_url the frontend redirects to.
    """
    # ── 1. Validate price_id ──────────────────────────────────────
    plan_slug = _plan_from_price_id(body.price_id)

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
        subscription_data={
            "trial_period_days": 7,
            "metadata": {
                "user_id": str(current_user.id),
                "plan_slug": plan_slug,
            },
        },
        success_url=_frontend_url("/dashboard?session_id={CHECKOUT_SESSION_ID}"),
        cancel_url=_frontend_url("/"),
        metadata={
            "user_id": str(current_user.id),
            "plan_slug": plan_slug,
        },
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
        metadata = data.get("metadata") or {}
        user_id = metadata.get("user_id")
        plan_slug = normalize_plan(metadata.get("plan_slug"))
        subscription_id = data.get("subscription")
        customer_id = data.get("customer")

        if user_id and subscription_id:
            sub = await asyncio.to_thread(
                stripe.Subscription.retrieve,
                subscription_id,
                expand=["items.data.price"],
            )
            plan = _plan_from_subscription_data(sub, fallback_plan=plan_slug)
            await _activate_subscription(db, user_id, customer_id, subscription_id, sub, plan)

    # ── Subscription updated (renewal, plan change) ───────────────
    elif event["type"] == "customer.subscription.updated":
        subscription_id = data["id"]
        sub = await asyncio.to_thread(
            stripe.Subscription.retrieve,
            subscription_id,
            expand=["items.data.price"],
        )
        await _update_subscription(db, sub)

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


async def _activate_subscription(db, user_id, customer_id, subscription_id, sub, plan: str):
    period_end = datetime.utcfromtimestamp(sub["current_period_end"])
    trial_end = (
        datetime.utcfromtimestamp(sub["trial_end"])
        if sub.get("trial_end") else None
    )
    status = _normalize_subscription_status(sub.get("status"))

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
    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(plan=plan, updated_at=datetime.utcnow())
    )
    await db.commit()


async def _update_subscription(db, sub_data):
    subscription_id = sub_data["id"]
    status = _normalize_subscription_status(sub_data.get("status", "active"))
    period_end = datetime.utcfromtimestamp(sub_data["current_period_end"])

    result = await db.execute(
        select(Billing).where(Billing.stripe_subscription_id == subscription_id)
    )
    billing = result.scalar_one_or_none()
    fallback_plan = normalize_plan(billing.plan) if billing else FREE_PLAN
    plan = _plan_from_subscription_data(sub_data, fallback_plan=fallback_plan)

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
