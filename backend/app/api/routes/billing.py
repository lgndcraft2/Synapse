from fastapi import APIRouter, Depends, HTTPException, Request, Header, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.db.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.core.timeutils import as_aware, is_past, now as utc_now
from app.models.models import User, Billing
from app.schemas.schemas import (
    CheckoutRequest,
    CheckoutResponse,
    CheckoutConfirmRequest,
    BillingOut,
    ChangePlanRequest,
    InvoiceOut,
    Page,
    PaymentMethodOut,
    UsageOut,
)
from app.services import paystack
from app.services.paystack import PaystackError
from datetime import datetime, timedelta, timezone
import calendar
import json
import logging
import uuid

logger = logging.getLogger("synapse.billing")

router = APIRouter(prefix="/billing", tags=["billing"])

# Tags the transactions this module creates, so the webhook and the payment
# history can tell a checkout from a plan-change charge or a renewal.
CHECKOUT_PURPOSE = "subscription_checkout"
PLAN_CHANGE_PURPOSE = "plan_change"

# Months per Paystack plan interval. Only monthly and annual plans are sold.
_INTERVAL_MONTHS = {"monthly": 1, "quarterly": 3, "biannually": 6, "annually": 12}


def _frontend_url(path: str = "") -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}"


def _reference(prefix: str) -> str:
    return f"syn-{prefix}-{uuid.uuid4().hex}"


def _add_months(dt: datetime, months: int) -> datetime:
    """Calendar month arithmetic, clamping the day (Jan 31 + 1 month = Feb 28/29)."""
    index = dt.month - 1 + months
    year, month = dt.year + index // 12, index % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _interval_months(plan: dict | None) -> int:
    return _INTERVAL_MONTHS.get((plan or {}).get("interval"), 1)


def _plan_for_subscription(plan_code: str | None, status: str, renews_at: datetime | None) -> str:
    """Resolve the plan tier a subscription grants, honoring status and expiry.

    The tier ("lite" or "premium") is derived from the subscription's plan code
    so that Thinker Lite and Deep Thinker map to distinct entitlements.
    """
    if status not in ("active", "trialing"):
        return "free"
    if is_past(renews_at):
        return "free"
    if not plan_code:
        # Fall back to premium if the shape is unexpected — never silently downgrade a payer.
        return "premium"
    return settings.price_plan_map.get(plan_code, "premium")


def _billing_period_for_plan(plan_code: str | None) -> str:
    """Unknown plans fall back to "monthly", which matches the Billing model's default."""
    return settings.price_period_map.get(plan_code or "", "monthly")


def _sync_from_subscription(billing: Billing, sub: dict) -> None:
    """Copy the authoritative Paystack subscription state onto the billing row.

    Paystack has no trial state of its own: a trial is a subscription whose
    first charge is in the future, so "trialing" comes from trial_ends_at.
    """
    raw = sub.get("status")
    # A non-renewing subscription may report no next payment date; the date we
    # already hold is still when the paid-for access ends.
    renews_at = paystack.parse_time(sub.get("next_payment_date")) or billing.renews_at
    in_trial = billing.trial_ends_at is not None and not is_past(billing.trial_ends_at)

    if raw in ("active", "non-renewing"):
        status = "trialing" if in_trial else "active"
        cancel_at_period_end = raw == "non-renewing"
    elif raw in ("cancelled", "completed", "complete") and renews_at and not is_past(renews_at):
        # Disabled, but the period already paid for (or the trial) is not over:
        # keep access until then, exactly as a scheduled cancellation would.
        status = "trialing" if in_trial else "active"
        cancel_at_period_end = True
    elif raw == "attention":
        status, cancel_at_period_end = "past_due", False
    elif raw in ("cancelled", "completed", "complete"):
        status, cancel_at_period_end = "cancelled", False
    else:
        status, cancel_at_period_end = "past_due", False

    plan_code = (sub.get("plan") or {}).get("plan_code")
    billing.status = status
    billing.plan = _plan_for_subscription(plan_code, status, renews_at)
    billing.billing_period = _billing_period_for_plan(plan_code)
    billing.cancel_at_period_end = cancel_at_period_end
    billing.renews_at = renews_at
    billing.updated_at = datetime.utcnow()


async def _set_user_plan(db, user_id, plan: str) -> None:
    await db.execute(
        update(User).where(User.id == user_id).values(plan=plan, updated_at=datetime.utcnow())
    )


async def _refund_quietly(reference: str, amount: int | None = None, note: str | None = None) -> None:
    """Refunds that follow a completed action must not undo it when they fail.
    They are logged so they can be finished by hand from the Paystack dashboard."""
    try:
        await paystack.refund(reference, amount=amount, merchant_note=note)
    except PaystackError as exc:
        logger.error("Refund of %s (amount=%s) failed: %s", reference, amount, exc.message)


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
    if billing.plan in ("premium", "lite") and renews_at and renews_at < now and billing.paystack_subscription_code:
        # Before downgrading, ask Paystack: a renewal whose webhook is late
        # has already moved next_payment_date forward.
        try:
            _sync_from_subscription(billing, await paystack.fetch_subscription(billing.paystack_subscription_code))
            current_user.plan = billing.plan
            current_user.updated_at = now
            renews_at = as_aware(billing.renews_at)
        except PaystackError as exc:
            logger.warning("Expiry check could not reach Paystack for %s: %s", current_user.id, exc.message)
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
    Starts a Paystack checkout for a paid plan.
    Returns a checkout_url the frontend redirects to.

    With a trial, the customer pays only a small card check, which is refunded
    once the subscription exists; the subscription itself starts charging when
    the trial ends. Without one, the first period is charged here.
    """
    # ── 1. Validate plan code ─────────────────────────────────────
    if body.price_id not in settings.allowed_price_ids:
        raise HTTPException(
            status_code=400,
            detail="Invalid or unauthorized price ID."
        )

    # ── 2. Get or create billing row and Paystack customer ────────
    result = await db.execute(
        select(Billing).where(Billing.user_id == current_user.id)
    )
    billing = result.scalar_one_or_none()

    if billing and billing.paystack_subscription_code and billing.status in ("active", "trialing"):
        # A second checkout would start a second subscription alongside the
        # first and bill both. Moving between plans goes through change-plan.
        raise HTTPException(
            status_code=400,
            detail="You already have a subscription. Change or resume it from your subscription page.",
        )

    if not billing:
        from sqlalchemy.exc import IntegrityError
        try:
            async with db.begin_nested():
                billing = Billing(user_id=current_user.id, plan="free")
                db.add(billing)
                await db.flush()
        except IntegrityError:
            # Concurrent creation - refetch
            billing = None
        if not billing:
            result = await db.execute(
                select(Billing).where(Billing.user_id == current_user.id)
            )
            billing = result.scalar_one_or_none()
            if not billing:
                raise HTTPException(status_code=500, detail="Billing sync error.")

    try:
        if not billing.paystack_customer_code:
            customer = await paystack.create_customer(
                current_user.email, current_user.name, str(current_user.id)
            )
            billing.paystack_customer_code = customer["customer_code"]

        if settings.TRIAL_DAYS > 0:
            charge, amount = "card_check", settings.PAYSTACK_CARD_CHECK_AMOUNT
        else:
            charge, amount = "first_period", int((await paystack.fetch_plan(body.price_id))["amount"])

        reference = _reference("checkout")
        txn = await paystack.initialize_transaction(
            email=current_user.email,
            amount=str(amount),
            currency=settings.PAYSTACK_CURRENCY,
            reference=reference,
            # Subscriptions renew against a saved card, so only cards are offered.
            channels=["card"],
            # Redirects are server-owned to avoid open redirects. Paystack
            # appends ?trxref=...&reference=... to the callback.
            callback_url=_frontend_url("/billing/success"),
            metadata=json.dumps({
                "user_id": str(current_user.id),
                "purpose": CHECKOUT_PURPOSE,
                "plan_code": body.price_id,
                "charge": charge,
                "cancel_action": _frontend_url("/billing/cancelled"),
            }),
        )
    except PaystackError as exc:
        logger.error("Checkout start failed for %s: %s", current_user.id, exc.message)
        raise HTTPException(status_code=502, detail="We couldn't start checkout. Please try again in a moment.")

    billing.checkout_reference = reference
    billing.updated_at = datetime.utcnow()
    await db.flush()

    return CheckoutResponse(checkout_url=txn["authorization_url"])


async def _complete_checkout(db, reference: str, expected_user_id=None) -> Billing | None:
    """Turn a paid checkout into a subscription. Safe to call more than once.

    Both the post-payment redirect and the charge.success webhook land here,
    in either order. The billing row is locked and the pending
    checkout_reference is cleared on success, so only the first caller creates
    a subscription; later callers see no pending reference and return as-is.
    """
    try:
        txn = await paystack.verify_transaction(reference)
    except PaystackError as exc:
        logger.warning("Could not verify checkout %s: %s", reference, exc.message)
        raise HTTPException(status_code=400, detail="We couldn't find that payment.")

    meta = paystack.metadata_of(txn)
    if meta.get("purpose") != CHECKOUT_PURPOSE:
        raise HTTPException(status_code=400, detail="That payment isn't a subscription checkout.")
    user_id = meta.get("user_id")
    # Ownership guard: the checkout must have been started by this user.
    if expected_user_id is not None and str(user_id) != str(expected_user_id):
        raise HTTPException(status_code=403, detail="This checkout session does not belong to you.")

    try:
        user_uuid = uuid.UUID(str(user_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="That payment isn't a subscription checkout.")

    result = await db.execute(
        select(Billing).where(Billing.user_id == user_uuid).with_for_update()
    )
    billing = result.scalar_one_or_none()
    if not billing or billing.checkout_reference != reference:
        # Already activated by the other path (or superseded by a newer
        # checkout). Checked before the payment status, because an activated
        # card check has since been refunded and now reads "reversed".
        return billing
    if txn.get("status") != "success":
        raise HTTPException(status_code=400, detail="That payment wasn't completed.")

    is_card_check = meta.get("charge") == "card_check"
    plan_code = meta.get("plan_code")
    auth = txn.get("authorization") or {}

    async def _abandon(detail: str):
        if is_card_check:
            await _refund_quietly(reference, note="Card check for a checkout that did not complete")
        else:
            await _refund_quietly(reference, note="Checkout could not create the subscription")
        billing.checkout_reference = None
        await db.commit()
        raise HTTPException(status_code=400, detail=detail)

    if plan_code not in settings.allowed_price_ids:
        await _abandon("That plan is no longer available. You have not been charged.")
    if not auth.get("reusable") or not auth.get("authorization_code"):
        await _abandon("This card can't be used for a subscription. Please try a different card.")

    customer_code = (txn.get("customer") or {}).get("customer_code") or billing.paystack_customer_code
    now = utc_now()
    if is_card_check:
        start = now + timedelta(days=settings.TRIAL_DAYS)
        trial_ends_at = start
    else:
        # The first period was paid at checkout; renewals start one interval on.
        start = _add_months(now, 12 if _billing_period_for_plan(plan_code) == "annual" else 1)
        trial_ends_at = None

    try:
        sub = await paystack.create_subscription(customer_code, plan_code, auth["authorization_code"], start)
    except PaystackError as exc:
        logger.error("Subscription create failed after checkout %s: %s", reference, exc.message)
        await _abandon("We couldn't set up your subscription. Any charge has been refunded.")

    status = "trialing" if trial_ends_at else "active"
    billing.paystack_customer_code = customer_code
    billing.paystack_subscription_code = sub["subscription_code"]
    billing.checkout_reference = None
    billing.status = status
    billing.plan = _plan_for_subscription(plan_code, status, start)
    billing.billing_period = _billing_period_for_plan(plan_code)
    # A fresh checkout supersedes any earlier scheduled cancellation.
    billing.cancel_at_period_end = False
    billing.cancelled_at = None
    billing.renews_at = start
    billing.trial_ends_at = trial_ends_at
    billing.updated_at = datetime.utcnow()
    await _set_user_plan(db, billing.user_id, billing.plan)
    await db.commit()

    if is_card_check:
        await _refund_quietly(reference, note="Card check for a free trial")
    return billing


@router.post("/confirm", response_model=BillingOut)
async def confirm_checkout(
    body: CheckoutConfirmRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Activation from the post-payment redirect. Verifies the Paystack
    transaction and creates the subscription immediately, so the dashboard
    reflects the upgrade even if the webhook is delayed or (in local dev) can't
    reach us.
    """
    await _complete_checkout(db, body.reference, expected_user_id=current_user.id)

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
    Returns a link to Paystack's hosted page for updating the card on the
    subscription. Paystack has no general customer portal; cancelling and plan
    changes happen on our own subscription screen.
    """
    result = await db.execute(
        select(Billing).where(Billing.user_id == current_user.id)
    )
    billing = result.scalar_one_or_none()

    if not billing or not billing.paystack_subscription_code:
        raise HTTPException(status_code=400, detail="You don't have a subscription to update a card on.")

    try:
        link = await paystack.manage_link(billing.paystack_subscription_code)
    except PaystackError as exc:
        logger.error("Manage link failed for %s: %s", current_user.id, exc.message)
        raise HTTPException(status_code=502, detail="We couldn't open the card page. Please try again.")

    return {"portal_url": link}


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
    if not billing.paystack_subscription_code:
        raise HTTPException(
            status_code=400,
            detail="You do not have an active subscription to manage.",
        )
    return billing, billing.paystack_subscription_code


@router.post("/cancel", response_model=BillingOut)
async def cancel_subscription(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Schedules cancellation at the end of the current billing period.

    Disabling a Paystack subscription makes it "non-renewing": the user keeps
    the access they have already paid for, and the plan drops to free when
    Paystack fires subscription.disable on the next payment date. This is
    reversible via POST /billing/resume until that moment.
    """
    billing, code = await _live_subscription(db, current_user)

    if billing.cancel_at_period_end:
        # Already scheduled — return current state rather than erroring, so a
        # double-submit from the UI is harmless.
        return billing

    try:
        sub = await paystack.fetch_subscription(code)
        await paystack.disable_subscription(code, sub["email_token"])
        sub = await paystack.fetch_subscription(code)
    except PaystackError as exc:
        logger.error("Cancel failed for %s: %s", current_user.id, exc.message)
        raise HTTPException(status_code=400, detail="We couldn't cancel your subscription. Please try again.")

    _sync_from_subscription(billing, sub)
    # Whatever Paystack reports, a cancel the user asked for is scheduled.
    billing.cancel_at_period_end = True
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

    Only valid while the period has not yet ended — once Paystack has disabled
    the subscription for good the user must check out again.
    """
    billing, code = await _live_subscription(db, current_user)

    if not billing.cancel_at_period_end:
        return billing
    if is_past(billing.renews_at):
        raise HTTPException(
            status_code=400,
            detail="This subscription has already ended. Please choose a plan to subscribe again.",
        )

    try:
        sub = await paystack.fetch_subscription(code)
        await paystack.enable_subscription(code, sub["email_token"])
        sub = await paystack.fetch_subscription(code)
    except PaystackError as exc:
        logger.error("Resume failed for %s: %s", current_user.id, exc.message)
        raise HTTPException(status_code=400, detail="We couldn't resume your subscription. Please try again.")

    _sync_from_subscription(billing, sub)
    billing.cancelled_at = None
    await db.flush()
    return billing


def _prorate(old_plan: dict, new_plan: dict, period_end: datetime | None, trialing: bool) -> tuple[int, datetime]:
    """What a plan change costs now, and when the new subscription first renews.

    Returns (net, start). A positive net is charged now, a negative one is
    refunded. It mirrors proration: the unused part of the current period is
    credited against the new plan.

    - In a trial, nothing has been paid yet. The trial ends and the new plan's
      first period is charged in full now.
    - Same interval: only the price difference for the time left is settled,
      and the billing date stays where it is.
    - Different interval (monthly <-> annual): the unused part of the old
      period is credited against a full new period, which starts now.
    """
    now = utc_now()
    new_amount = int(new_plan["amount"])
    new_months = _interval_months(new_plan)
    if trialing or period_end is None:
        return new_amount, _add_months(now, new_months)

    old_amount = int(old_plan["amount"])
    old_months = _interval_months(old_plan)
    period_end = as_aware(period_end)
    period_start = _add_months(period_end, -old_months)
    length = (period_end - period_start).total_seconds()
    remaining = min(max((period_end - now).total_seconds(), 0.0), length)
    fraction = remaining / length if length > 0 else 0.0

    if new_months == old_months:
        return round((new_amount - old_amount) * fraction), period_end
    return new_amount - round(old_amount * fraction), _add_months(now, new_months)


async def _refund_overpayment(customer_code: str, amount: int) -> None:
    """Refund a downgrade's credit against the customer's latest payment that can cover it."""
    try:
        customer = await paystack.fetch_customer(customer_code)
        page = await paystack.list_transactions(customer["id"], 20, 1)
    except PaystackError as exc:
        logger.error("Could not find a payment to refund %s for %s: %s", amount, customer_code, exc.message)
        return
    for txn in page.get("data") or []:
        if txn.get("status") == "success" and int(txn.get("amount") or 0) >= amount \
                and paystack.metadata_of(txn).get("charge") != "card_check":
            await _refund_quietly(str(txn["id"]), amount=amount, note="Prorated credit for a plan change")
            return
    logger.error("No payment large enough to refund %s for %s", amount, customer_code)


@router.post("/change-plan", response_model=BillingOut)
async def change_plan(
    body: ChangePlanRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Moves an existing subscription to a different plan, prorated.

    Paystack cannot change the plan on a subscription, so this settles the
    prorated difference on the saved card (an upgrade is charged, a downgrade
    is refunded), starts a subscription on the new plan, and then disables the
    old one.
    """
    if body.price_id not in settings.allowed_price_ids:
        raise HTTPException(status_code=400, detail="Invalid or unauthorized price ID.")

    billing, old_code = await _live_subscription(db, current_user)
    if billing.status not in ("active", "trialing"):
        raise HTTPException(status_code=400, detail="Your subscription isn't active, so its plan can't be changed.")

    try:
        sub = await paystack.fetch_subscription(old_code)
        old_plan = sub.get("plan") or {}
        if old_plan.get("plan_code") == body.price_id:
            raise HTTPException(status_code=400, detail="You are already on this plan.")
        new_plan = await paystack.fetch_plan(body.price_id)
    except PaystackError as exc:
        logger.error("Plan change lookup failed for %s: %s", current_user.id, exc.message)
        raise HTTPException(status_code=400, detail="We couldn't change your plan. Please try again.")

    auth_code = (sub.get("authorization") or {}).get("authorization_code")
    email = (sub.get("customer") or {}).get("email") or current_user.email
    customer_code = (sub.get("customer") or {}).get("customer_code") or billing.paystack_customer_code
    if not auth_code:
        raise HTTPException(status_code=400, detail="There's no saved card on your subscription. Please update your card first.")

    # A plan change is a deliberate purchase decision — don't silently keep an
    # unfinished trial running on the new plan.
    trialing = billing.status == "trialing"
    period_end = paystack.parse_time(sub.get("next_payment_date")) or billing.renews_at
    net, start = _prorate(old_plan, new_plan, period_end, trialing)

    charge_ref = None
    if net >= settings.PAYSTACK_MIN_CHARGE_AMOUNT:
        charge_ref = _reference("change")
        try:
            charge = await paystack.charge_authorization(
                email=email,
                amount=str(net),
                authorization_code=auth_code,
                currency=settings.PAYSTACK_CURRENCY,
                reference=charge_ref,
                metadata=json.dumps({
                    "user_id": str(current_user.id),
                    "purpose": PLAN_CHANGE_PURPOSE,
                    "plan_code": body.price_id,
                }),
            )
        except PaystackError as exc:
            logger.warning("Plan change charge failed for %s: %s", current_user.id, exc.message)
            raise HTTPException(status_code=402, detail="Your card was declined, so your plan was not changed.")
        if charge.get("status") != "success":
            raise HTTPException(status_code=402, detail="Your card was declined, so your plan was not changed.")

    try:
        new_sub = await paystack.create_subscription(customer_code, body.price_id, auth_code, start)
    except PaystackError as exc:
        logger.error("Plan change subscription create failed for %s: %s", current_user.id, exc.message)
        if charge_ref:
            await _refund_quietly(charge_ref, note="Plan change could not be completed")
        raise HTTPException(status_code=400, detail="We couldn't change your plan. Any charge has been refunded.")

    # Point the row at the new subscription and commit *before* disabling the
    # old one, so the old one's disable webhooks no longer match this user.
    billing.paystack_subscription_code = new_sub["subscription_code"]
    if trialing:
        billing.trial_ends_at = None
    billing.status = "active"
    billing.plan = _plan_for_subscription(body.price_id, "active", start)
    billing.billing_period = _billing_period_for_plan(body.price_id)
    billing.cancel_at_period_end = False
    billing.cancelled_at = None
    billing.renews_at = start
    billing.updated_at = datetime.utcnow()
    # The tier changed, so the denormalised copy on the user must follow.
    current_user.plan = billing.plan
    current_user.updated_at = datetime.utcnow()
    await db.commit()

    try:
        await paystack.disable_subscription(old_code, sub["email_token"])
    except PaystackError as exc:
        # The user is on the new plan either way; the old subscription must be
        # disabled by hand or it will bill again on its next payment date.
        logger.error("Old subscription %s not disabled after plan change: %s", old_code, exc.message)

    if net < 0:
        await _refund_overpayment(customer_code, -net)

    return billing


@router.get("/invoices", response_model=Page[InvoiceOut])
async def list_invoices(
    response: Response,
    limit: int = 10,
    starting_after: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One page of past payments. Empty page when they have never paid.

    Paystack pages by number; the page number travels as the opaque cursor so
    the client contract stays cursor-based. Card checks and failed or
    abandoned attempts are filtered out, so `total` is None.
    """
    # Receipts are per-user and must never be served from a shared or back-button
    # cache — a second account on the same browser would see the first one's history.
    response.headers["Cache-Control"] = "no-store, private"

    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    # The customer is the only thing scoping this query. Without the guard, a
    # list with no customer filter would return the whole integration's
    # transactions — every other user's history included.
    if not billing or not billing.paystack_customer_code:
        return Page[InvoiceOut](data=[])
    customer_code = billing.paystack_customer_code

    try:
        page_number = max(1, int(starting_after)) if starting_after else 1
    except ValueError:
        page_number = 1

    try:
        customer = await paystack.fetch_customer(customer_code)
        envelope = await paystack.list_transactions(customer["id"], max(1, min(limit, 100)), page_number)
    except PaystackError:
        raise HTTPException(status_code=400, detail="Could not load billing history.")

    raw = envelope.get("data") or []
    meta = envelope.get("meta") or {}
    labels = {"success": "paid", "reversed": "refunded", "failed": "failed"}

    rows = []
    for txn in raw:
        # Belt and braces: re-assert ownership on every row rather than trusting
        # the filter we sent, so a bad param or an API change can never surface
        # another customer's payment.
        if (txn.get("customer") or {}).get("customer_code") != customer_code:
            continue
        # Abandoned and pending attempts are not real charges, and a card
        # check is refunded at once; both would confuse a receipts list.
        if txn.get("status") not in labels or paystack.metadata_of(txn).get("charge") == "card_check":
            continue
        meta_txn = paystack.metadata_of(txn)
        plan = txn.get("plan")
        if meta_txn.get("purpose") == PLAN_CHANGE_PURPOSE:
            description = "Plan change"
        else:
            description = plan.get("name") if isinstance(plan, dict) else None
        amount = int(txn.get("amount") or 0)
        created = paystack.parse_time(txn.get("paid_at") or txn.get("created_at")) or utc_now()
        rows.append(InvoiceOut(
            id=str(txn["id"]),
            number=txn.get("reference"),
            created=created,
            amount_paid=amount if txn["status"] in ("success", "reversed") else 0,
            amount_due=amount,
            currency=(txn.get("currency") or settings.PAYSTACK_CURRENCY).upper(),
            status=labels[txn["status"]],
            description=description,
            hosted_invoice_url=None,
            invoice_pdf=None,
        ))

    # Both of these come from the *unfiltered* Paystack page. The filtering
    # above can shorten a page, so a short page does not mean the end.
    page_count = int(meta.get("pageCount") or 0)
    has_more = page_number < page_count
    return Page[InvoiceOut](
        data=rows,
        has_more=has_more,
        next_cursor=str(page_number + 1) if has_more else None,
    )


@router.get("/payment-method", response_model=PaymentMethodOut)
async def get_payment_method(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    The card on file, for display only.

    Returns empty fields rather than 404 when there is no card, so the UI can
    render a neutral "no payment method" state without treating it as an error.
    Updating a card always happens on Paystack's hosted page — raw card details
    must never reach this server.
    """
    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if not billing or not (billing.paystack_subscription_code or billing.paystack_customer_code):
        return PaymentMethodOut()

    try:
        auth = None
        if billing.paystack_subscription_code:
            sub = await paystack.fetch_subscription(billing.paystack_subscription_code)
            auth = sub.get("authorization")
        # Without a subscription, fall back to the newest reusable card saved
        # on the customer.
        if not auth and billing.paystack_customer_code:
            customer = await paystack.fetch_customer(billing.paystack_customer_code)
            cards = [a for a in customer.get("authorizations") or [] if a.get("reusable") and a.get("channel") == "card"]
            auth = cards[0] if cards else None
    except PaystackError:
        return PaymentMethodOut()

    if not auth or not auth.get("last4"):
        return PaymentMethodOut()

    def _int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return PaymentMethodOut(
        brand=(auth.get("brand") or "").lower() or None,
        last4=auth.get("last4"),
        exp_month=_int(auth.get("exp_month")),
        exp_year=_int(auth.get("exp_year")),
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


# ── PAYSTACK WEBHOOKS ─────────────────────────────────────────────
webhook_router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _subscription_code_of(kind: str, data: dict) -> str | None:
    """subscription.* events carry the subscription itself; invoice.* nest it."""
    if kind.startswith("subscription."):
        return data.get("subscription_code")
    return (data.get("subscription") or {}).get("subscription_code")


@webhook_router.post("/paystack")
async def paystack_webhook(
    request: Request,
    x_paystack_signature: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    """
    Handles Paystack webhook events to keep our billing table in sync.

    Events handled:
    - charge.success                 → finish a checkout (create the subscription)
    - subscription.create / not_renew,
      invoice.update                 → renewals, trial end, cancel from Paystack's page
    - subscription.disable           → the subscription has ended
    - invoice.payment_failed         → mark as past_due

    Anything else (including our own plan-change charges and the old
    subscription's events after a plan change) matches nothing and is ignored.
    A Paystack outage returns 502 so Paystack retries; business rejections
    return 200, since retrying them cannot change the answer.
    """
    payload = await request.body()
    if not paystack.verify_signature(payload, x_paystack_signature):
        raise HTTPException(status_code=400, detail="Invalid webhook signature or payload.")

    try:
        event = json.loads(payload)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid webhook signature or payload.")

    kind = event.get("event") or ""
    data = event.get("data") or {}

    try:
        # ── Checkout paid ─────────────────────────────────────────
        if kind == "charge.success":
            if paystack.metadata_of(data).get("purpose") == CHECKOUT_PURPOSE and data.get("reference"):
                try:
                    await _complete_checkout(db, data["reference"])
                except HTTPException as exc:
                    logger.info("Checkout %s not activated from webhook: %s", data["reference"], exc.detail)

        # ── Subscription changed (renewal, trial end, not renewing) ──
        elif kind in ("subscription.create", "subscription.not_renew", "invoice.update"):
            code = _subscription_code_of(kind, data)
            if code:
                await _refresh_subscription(db, code)

        # ── Subscription ended ───────────────────────────────────
        elif kind == "subscription.disable":
            code = _subscription_code_of(kind, data)
            if code:
                await _end_subscription(db, code)

        # ── Payment failed ───────────────────────────────────────
        elif kind == "invoice.payment_failed":
            code = _subscription_code_of(kind, data)
            if code:
                await _mark_past_due(db, code)
    except PaystackError as exc:
        logger.error("Webhook %s could not reach Paystack: %s", kind, exc.message)
        raise HTTPException(status_code=502, detail="Upstream unavailable; retry later.")

    return {"received": True}


async def _billing_for_subscription(db, code: str) -> Billing | None:
    result = await db.execute(
        select(Billing).where(Billing.paystack_subscription_code == code).with_for_update()
    )
    return result.scalar_one_or_none()


async def _refresh_subscription(db, code: str) -> None:
    billing = await _billing_for_subscription(db, code)
    if not billing:
        return
    sub = await paystack.fetch_subscription(code)
    _sync_from_subscription(billing, sub)
    await _set_user_plan(db, billing.user_id, billing.plan)
    await db.commit()


async def _end_subscription(db, code: str) -> None:
    billing = await _billing_for_subscription(db, code)
    if not billing:
        return
    if billing.renews_at is not None and not is_past(billing.renews_at - timedelta(hours=1)):
        # Disabled ahead of its date: the paid-for period (or trial) still
        # stands. Treat it as a scheduled cancellation; the expiry checks
        # downgrade the plan once renews_at passes.
        billing.cancel_at_period_end = True
        billing.cancelled_at = billing.cancelled_at or datetime.utcnow()
        billing.updated_at = datetime.utcnow()
        await db.commit()
        return

    # Downgrade to free
    billing.plan = "free"
    billing.status = "cancelled"
    # The subscription is gone, so there is nothing left pending, and nothing
    # left for cancel / resume / change-plan to act on.
    billing.cancel_at_period_end = False
    billing.paystack_subscription_code = None
    billing.cancelled_at = datetime.utcnow()
    billing.updated_at = datetime.utcnow()
    await _set_user_plan(db, billing.user_id, "free")
    await db.commit()


async def _mark_past_due(db, code: str) -> None:
    billing = await _billing_for_subscription(db, code)
    if not billing:
        return
    billing.plan = "free"
    billing.status = "past_due"
    billing.updated_at = datetime.utcnow()
    await _set_user_plan(db, billing.user_id, "free")
    await db.commit()
