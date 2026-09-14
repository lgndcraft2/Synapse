"""Customer support tickets filed from the /support page.

A ticket is persisted first, then emailed — to the support address (with
Reply-To set to the customer) and as a confirmation to the customer. The row
is the durable record and is what the internal support console will read, so
mail is strictly best-effort on top of it.
"""
import logging
import secrets
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from jose import JWTError
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.core.jwt_verify import verify_supabase_jwt
from app.db.database import get_db
from app.models.models import SupportTicket, User
from app.schemas.schemas import SupportTicketCreate, SupportTicketOut
from app.services.email import send_ticket_confirmation, send_ticket_to_support
from app.services.rate_limit import redis_client

logger = logging.getLogger("synapse.support")

router = APIRouter(prefix="/support", tags=["support"])

# Mirrors TOPICS in webpage/src/lib/faq.ts so the email subject reads the same
# as the dropdown the user picked from.
TOPIC_LABELS = {
    "billing": "Billing and payments",
    "extension": "The extension is not working",
    "account": "Account and sign-in",
    "profile": "My cognitive profile",
    "accessibility": "Accessibility",
    "other": "Something else",
}

# A public endpoint is spam bait, and it now sends mail to an address the
# caller supplies, so anonymous submissions are capped per IP. Generous enough
# that a person with a genuine problem is never blocked.
ANON_HOURLY_LIMIT = 5
AUTHED_HOURLY_LIMIT = 20


async def _get_optional_user(request: Request, db: AsyncSession) -> User | None:
    """Resolve the caller when a valid token is present, else None.

    Auth is optional here on purpose: support must stay reachable by someone
    whose sign-in is exactly what is broken.

    Uses verify_supabase_jwt rather than decoding with the shared secret
    directly. This project's Supabase issues asymmetric (ES256/RS256) tokens
    verified against its JWKS — an HS256-only decode rejects every one of them
    and would quietly treat every signed-in user as anonymous.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.split(" ", 1)[1]
    try:
        payload = await verify_supabase_jwt(token)
        uid = payload.get("sub")
        if not uid:
            return None
        result = await db.execute(select(User).where(User.supabase_uid == uid))
        return result.scalar_one_or_none()
    except JWTError:
        return None


def _reference() -> str:
    """Short, unambiguous, quotable-over-the-phone ticket code."""
    # Crockford-ish alphabet: no I, L, O, U — they get misread as 1, 0 and each other.
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    return "SY-" + "".join(secrets.choice(alphabet) for _ in range(6))


async def _enforce_submission_limit(request: Request, user: User | None) -> None:
    """Cap submissions per hour. Fails OPEN when Redis is unreachable.

    A support form that stops working during an outage is the worst possible
    time for it to stop working, so a Redis error must never block a ticket.
    """
    if user:
        key = f"support:user:{user.id}"
        limit = AUTHED_HOURLY_LIMIT
    else:
        client_ip = request.client.host if request.client else "unknown"
        key = f"support:ip:{client_ip}"
        limit = ANON_HOURLY_LIMIT

    try:
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, 3600)
        if count > limit:
            raise HTTPException(
                status_code=429,
                detail=(
                    "You've sent several tickets in a short time. Please reply to your "
                    f"existing ticket, or email {settings.SUPPORT_EMAIL} directly."
                ),
                headers={"Retry-After": "3600"},
            )
    except RedisError as e:
        logger.warning("Support rate limiter degraded — Redis unavailable (%s). Allowing.", e)


@router.post("/tickets", response_model=SupportTicketOut, status_code=201)
async def create_ticket(
    request: Request,
    body: SupportTicketCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Files a support ticket.

    Auth is optional on purpose. Signed-in callers get their user_id and email
    attached automatically; anonymous callers must supply an email so the
    ticket is answerable at all.

    The row is written first and the two emails are queued as background tasks,
    so a slow or failing mail provider delays nothing and loses nothing.
    """
    user = await _get_optional_user(request, db)
    await _enforce_submission_limit(request, user)

    email = (user.email if user else None) or (str(body.email) if body.email else None)
    if not email:
        raise HTTPException(
            status_code=400,
            detail="An email address is required so we can reply to you.",
        )

    # UNIQUE on reference makes a collision a hard error rather than a silent
    # merge, so retry a couple of times before giving up.
    for _ in range(5):
        reference = _reference()
        exists = await db.execute(
            select(SupportTicket.id).where(SupportTicket.reference == reference)
        )
        if exists.scalar_one_or_none() is None:
            break
    else:
        raise HTTPException(status_code=500, detail="Could not allocate a ticket reference.")

    ticket = SupportTicket(
        id=uuid.uuid4(),
        reference=reference,
        user_id=user.id if user else None,
        email=email,
        topic=body.topic,
        subject=body.subject.strip(),
        message=body.message.strip(),
        diagnostics=body.diagnostics,
        status="open",
    )
    db.add(ticket)
    await db.flush()

    logger.info(
        "Support ticket %s filed (topic=%s, user=%s)",
        reference, body.topic, user.id if user else "anonymous",
    )

    # Queue the mail with plain values, never the ORM object — the session is
    # closed by the time background tasks run.
    topic_label = TOPIC_LABELS.get(body.topic, body.topic)
    background.add_task(
        send_ticket_to_support,
        reference=reference,
        topic_label=topic_label,
        subject=ticket.subject,
        message=ticket.message,
        from_email=email,
        diagnostics=body.diagnostics,
    )
    background.add_task(
        send_ticket_confirmation,
        to=email,
        reference=reference,
        subject=ticket.subject,
        message=ticket.message,
    )

    return ticket


@router.get("/tickets", response_model=list[SupportTicketOut])
async def list_my_tickets(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The caller's own tickets, newest first."""
    result = await db.execute(
        select(SupportTicket)
        .where(SupportTicket.user_id == current_user.id)
        .order_by(SupportTicket.created_at.desc())
        .limit(50)
    )
    return list(result.scalars().all())
