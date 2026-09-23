"""
First-party authentication.

Replaces the Supabase-backed /auth/sync arrangement, where this service held
no credentials and only mirrored GoTrue's view of the world into our tables.
Everything now originates here: password hashing, token issuance, the Google
OAuth handshake, and the email flows that back verification and reset.

Three properties worth stating up front, because each is easy to break with a
well-meaning edit:

  * Login never reveals whether an address has an account. Same error, same
    status, same work done — see security.verify_password.
  * /password/forgot always answers 202, for the same reason.
  * The Google callback clears its transaction cookie on every exit path,
    including failures, so a state value is usable exactly once.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import RedirectResponse
from redis.exceptions import RedisError
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.core.request_utils import client_ip
from app.core.timeutils import is_past
from app.core.security import (
    hash_opaque_token,
    hash_password,
    new_opaque_token,
    password_needs_rehash,
    verify_password,
)
from app.db.database import get_db
from app.models.models import Billing, EmailToken, User
from app.schemas.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    OAuthExchangeRequest,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    UpdateMeRequest,
    UserOut,
    VerifyEmailRequest,
)
from app.services import auth_limits, auth_tokens, email as email_service
from app.services import oauth_google as goauth
from app.services.auth_tokens import RefreshError
from app.services.provisioning import (
    find_by_email,
    link_google_account,
    normalize_email,
    provision_user,
)
from app.services.rate_limit import redis_client

logger = logging.getLogger("synapse.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

PURPOSE_VERIFY = "email_verify"
PURPOSE_RESET = "password_reset"

# The Google handoff parks a minted session here for the few seconds between
# the callback redirect and the SPA collecting it.
OAUTH_HANDOFF_PREFIX = "oauth:handoff:"
OAUTH_HANDOFF_TTL = 120


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _token_response(access: str, refresh: str, expires_at: int, user: User) -> TokenResponse:
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_at=expires_at,
        expires_in=settings.ACCESS_TOKEN_TTL_SECONDS,
        user=UserOut.model_validate(user),
    )


# ── Email tokens ──────────────────────────────────────────────────

async def _issue_email_token(
    db: AsyncSession, user: User, purpose: str, ttl_seconds: int
) -> str:
    """
    Mint a single-use emailed token and return the raw value.

    Issuing invalidates any outstanding token for the same purpose. Without
    that, every "resend" leaves another live link in another inbox.
    """
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == purpose,
            EmailToken.used_at.is_(None),
        )
        .values(used_at=_now())
    )

    raw = new_opaque_token()
    db.add(
        EmailToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=hash_opaque_token(raw),
            expires_at=_now() + timedelta(seconds=ttl_seconds),
        )
    )
    await db.flush()
    return raw


async def _consume_email_token(
    db: AsyncSession, raw: str, purpose: str
) -> User:
    """
    Redeem a token, or raise 400.

    Rows are marked used rather than deleted so an already-spent link can be
    distinguished from one that never existed — the difference between a
    useful message and a baffled support ticket.
    """
    row = await db.scalar(
        select(EmailToken)
        .where(
            EmailToken.token_hash == hash_opaque_token(raw),
            EmailToken.purpose == purpose,
        )
        .with_for_update()
    )
    invalid = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="This link is invalid or has already been used.",
    )
    if row is None or row.used_at is not None:
        raise invalid
    if is_past(row.expires_at):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This link has expired. Please request a new one.",
        )

    user = await db.scalar(select(User).where(User.id == row.user_id))
    if user is None:
        raise invalid

    row.used_at = _now()
    await db.flush()
    return user


async def _queue_verification_email(
    user: User,
    db: AsyncSession,
    background: BackgroundTasks,
) -> None:
    """Persist a verification token, then send the email after the response.

    Resend can take up to its request timeout to accept a message. Account
    creation must not make the person wait on that remote service: the token
    is safely committed with the account, and only the network send is queued.
    """
    raw = await _issue_email_token(
        db, user, PURPOSE_VERIFY, settings.EMAIL_VERIFY_TTL_SECONDS
    )
    url = f"{settings.FRONTEND_URL.rstrip('/')}/auth?tab=verify&token={raw}"
    if not email_service.is_configured():
        # Without mail the account can never sign in, so this is not the
        # best-effort case that ticket mail is.
        logger.error(
            "RESEND_API_KEY unset — cannot deliver verification email to %s. "
            "This account cannot complete signup.",
            user.email,
        )
        return
    # Pass plain values, never the ORM user or request-scoped session. Those
    # have both been released by the time the background task runs.
    background.add_task(email_service.send_verification_email, user.email, url)


# ── Registration and login ────────────────────────────────────────

@router.post("/register", status_code=status.HTTP_202_ACCEPTED)
async def register(
    payload: RegisterRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Create an account and send a verification link.

    Deliberately returns no session: sign-in requires a verified address, so
    that free AI usage cannot be farmed with throwaway addresses.

    The response is identical whether or not the address was already taken.
    Reporting "already registered" here would hand over a membership oracle
    that the careful work in login and /password/forgot is trying to deny.
    """
    await auth_limits.enforce("register_ip", auth_limits.hash_identifier(client_ip(request)))

    email = normalize_email(payload.email)
    existing = await find_by_email(db, email)

    generic = {
        "status": "pending_verification",
        "message": "Check your email for a link to confirm your address.",
    }

    if existing is not None:
        if not existing.email_verified:
            # Most likely the same person signing up twice — resend rather
            # than stranding them.
            await _queue_verification_email(existing, db, background)
        return generic

    pw_hash = await hash_password(payload.password)
    user = await provision_user(
        db,
        email=email,
        name=(payload.name or "").strip() or email.split("@")[0],
        password_hash=pw_hash,
        email_verified=False,
    )
    await _queue_verification_email(user, db, background)
    logger.info("Registered account %s pending verification", user.id)
    return generic


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    ip_key = auth_limits.hash_identifier(client_ip(request))
    email_key = auth_limits.hash_identifier(payload.email)
    await auth_limits.enforce("login_ip", ip_key)
    await auth_limits.enforce("login_email", email_key)

    user = await find_by_email(db, payload.email)

    # verify_password burns the same Argon2 work when the user is missing or
    # has no password (Google-only), so neither timing nor status distinguishes
    # the three failure modes.
    ok = await verify_password(payload.password, user.password_hash if user else None)
    if not user or not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password.",
        )

    if not user.email_verified:
        # A distinct code so the SPA can offer "resend" instead of implying the
        # password was wrong.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "email_not_verified",
                "message": "Confirm your email address before signing in.",
            },
        )

    # Transparently upgrade a hash written under weaker Argon2 parameters.
    # Login is the only moment the plaintext is available to rehash with, so
    # skipping it means old hashes never improve.
    if password_needs_rehash(user.password_hash):
        user.password_hash = await hash_password(payload.password)
        logger.info("Rehashed password for %s under current parameters", user.id)

    access, refresh, exp = await auth_tokens.issue_pair(
        db, user, client=auth_tokens.WEB, request=request
    )
    user.last_login_at = _now()
    await db.flush()

    await auth_limits.clear("login_email", email_key)
    return _token_response(access, refresh, exp, user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    payload: RefreshRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Rotate a refresh token. See services/auth_tokens.rotate for the rules."""
    try:
        access, new_refresh, exp, user = await auth_tokens.rotate(
            db, payload.refresh_token, request=request
        )
    except RefreshError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": exc.code, "message": exc.message},
        )
    return _token_response(access, new_refresh, exp, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: LogoutRequest, db: AsyncSession = Depends(get_db)):
    """
    End one session.

    Unauthenticated and forgiving on purpose: a client holding a token we have
    never seen should still end up logged out rather than stuck.
    """
    if payload.refresh_token:
        await auth_tokens.revoke_one(db, payload.refresh_token, "logout")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await auth_tokens.revoke_all_for_user(db, current_user.id, "logout_all")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Email verification ────────────────────────────────────────────

@router.post("/verify-email/confirm", response_model=TokenResponse)
async def confirm_email(
    payload: VerifyEmailRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Redeem a verification link and sign the user straight in.

    Clicking the link proves control of the address, which is the same thing
    login would establish, so making them type the password again adds
    friction without adding assurance.
    """
    user = await _consume_email_token(db, payload.token, PURPOSE_VERIFY)

    if not user.email_verified:
        user.email_verified = True
        user.email_verified_at = _now()
        user.updated_at = _now()
        await db.flush()

    access, refresh_token, exp = await auth_tokens.issue_pair(
        db, user, client=auth_tokens.WEB, request=request
    )
    user.last_login_at = _now()
    await db.flush()
    return _token_response(access, refresh_token, exp, user)


@router.post("/verify-email/resend", status_code=status.HTTP_202_ACCEPTED)
async def resend_verification(
    payload: ForgotPasswordRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Always 202 — same enumeration reasoning as /password/forgot."""
    await auth_limits.enforce(
        "forgot_ip", auth_limits.hash_identifier(client_ip(request))
    )
    await auth_limits.enforce(
        "verify_user", auth_limits.hash_identifier(payload.email)
    )

    user = await find_by_email(db, payload.email)
    if user is not None and not user.email_verified:
        await _queue_verification_email(user, db, background)
    return {"status": "sent"}


# ── Password reset ────────────────────────────────────────────────

@router.post("/password/forgot", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Always 202, whatever happens.

    Status, body and timing must not differ between a known and an unknown
    address, or this endpoint becomes a way to enumerate the user base. Mail
    goes out on the same path either way; only its recipient differs.
    """
    await auth_limits.enforce("forgot_ip", auth_limits.hash_identifier(client_ip(request)))
    await auth_limits.enforce("forgot_email", auth_limits.hash_identifier(payload.email))

    user = await find_by_email(db, payload.email)
    if user is not None and user.password_hash is not None:
        raw = await _issue_email_token(
            db, user, PURPOSE_RESET, settings.PASSWORD_RESET_TTL_SECONDS
        )
        url = f"{settings.FRONTEND_URL.rstrip('/')}/auth?tab=new-password&token={raw}"
        if email_service.is_configured():
            background.add_task(email_service.send_password_reset_email, user.email, url)
        else:
            logger.error(
                "RESEND_API_KEY unset — password reset for %s cannot be delivered.",
                user.email,
            )

    return {"status": "sent"}


@router.post("/password/reset", response_model=TokenResponse)
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user = await _consume_email_token(db, payload.token, PURPOSE_RESET)

    user.password_hash = await hash_password(payload.password)
    user.password_changed_at = _now()
    user.updated_at = _now()
    if not user.email_verified:
        # Reaching the reset link proves the address works.
        user.email_verified = True
        user.email_verified_at = _now()
    await db.flush()

    # Whoever prompted this reset may be the reason for it. Everything else
    # signs out.
    await auth_tokens.revoke_all_for_user(db, user.id, "password_change")

    access, refresh_token, exp = await auth_tokens.issue_pair(
        db, user, client=auth_tokens.WEB, request=request
    )
    return _token_response(access, refresh_token, exp, user)


@router.post("/password/change", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    payload: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ok = await verify_password(payload.current_password, current_user.password_hash)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your current password is incorrect.",
        )

    current_user.password_hash = await hash_password(payload.new_password)
    current_user.password_changed_at = _now()
    current_user.updated_at = _now()
    await db.flush()
    await auth_tokens.revoke_all_for_user(db, current_user.id, "password_change")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Account ───────────────────────────────────────────────────────

@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me", response_model=UserOut)
async def update_me(
    payload: UpdateMeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Rename yourself.

    Previously impossible without a detour through Supabase: users.name was
    written only by /auth/sync reading the session's user_metadata, so the
    dashboard updated Supabase and then asked us to re-read it.
    """
    current_user.name = payload.name.strip()
    current_user.updated_at = _now()
    await db.flush()
    return current_user


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Permanently delete the caller's account.

    Ordering is load-bearing and unchanged from the original: cancel billing
    first, so deletion can never strand a paying subscription with no way left
    to stop the charges.
    """
    import stripe

    stripe.api_key = settings.STRIPE_SECRET_KEY

    result = await db.execute(select(Billing).where(Billing.user_id == current_user.id))
    billing = result.scalar_one_or_none()
    if billing and billing.stripe_subscription_id:
        try:
            await asyncio.to_thread(
                stripe.Subscription.delete, billing.stripe_subscription_id
            )
        except stripe.error.StripeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "We could not cancel your subscription, so your account was not "
                    f"deleted. Please cancel it first. ({e.user_message or 'Stripe error'})"
                ),
            )

    user_id = current_user.id

    # Core DELETE on purpose. db.delete(user) would make the ORM de-associate
    # children by nulling their user_id first, which the NOT NULL constraints
    # reject, because the relationships do not set passive_deletes. Issuing the
    # statement directly lets the database apply the cascade it already
    # declares — which now also covers refresh_tokens and email_tokens.
    await db.execute(delete(User).where(User.id == user_id))
    await db.flush()
    logger.info("Deleted account %s", user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Google OAuth ──────────────────────────────────────────────────

def _frontend(path: str) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}"


@router.get("/google/start")
async def google_start(
    request: Request,
    next: str | None = Query(default=None),
):
    """
    Begin the Google handshake.

    Must be reached by a top-level navigation, not fetch(): the browser has to
    accept a Set-Cookie and then follow a cross-origin redirect, and Google
    will not serve its authorize page to XHR.
    """
    await auth_limits.enforce("google_ip", auth_limits.hash_identifier(client_ip(request)))

    try:
        redirect_url, cookie_value = goauth.build_authorize_url(next)
    except goauth.OAuthError as exc:
        logger.error("Google sign-in unavailable: %s", exc)
        return RedirectResponse(_frontend(f"/auth?error={exc.code}"), status_code=303)

    response = RedirectResponse(redirect_url, status_code=307)
    goauth.set_state_cookie(response, cookie_value)
    return response


@router.get("/google/callback")
async def google_callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
):
    """
    Finish the Google handshake.

    The transaction cookie is cleared on *every* return path, so a state value
    can be spent exactly once whether the flow succeeded, failed, or the user
    pressed Deny. That is why the clearing happens in a finally block against
    the response object rather than in a dependency.
    """
    response: Response | None = None
    try:
        if error:
            # User declined at Google's consent screen. Not a failure worth
            # alarming them about.
            response = RedirectResponse(_frontend("/auth?error=oauth_denied"), 303)
            return response

        cookie_value = request.cookies.get(goauth.COOKIE_NAME)
        tx = goauth.verify_state(cookie_value, state)

        if not code:
            raise goauth.OAuthError("oauth_state", "Missing authorization code.")

        token_data = await goauth.exchange_code(code, tx["verifier"])
        claims = await goauth.verify_id_token(token_data["id_token"], tx["nonce"])

        google_sub = claims["sub"]
        email = normalize_email(claims["email"])

        user = await db.scalar(select(User).where(User.google_id == google_sub))
        if user is None:
            existing = await find_by_email(db, email)
            if existing is not None:
                # Safe to link: verify_id_token already refused anything Google
                # does not report as a verified address.
                user = await link_google_account(
                    db, existing, google_sub, claims.get("picture")
                )
            else:
                user = await provision_user(
                    db,
                    email=email,
                    name=claims.get("name") or email.split("@")[0],
                    avatar_url=claims.get("picture"),
                    google_id=google_sub,
                    email_verified=True,
                )

        access, refresh_token, exp = await auth_tokens.issue_pair(
            db, user, client=auth_tokens.WEB, request=request
        )
        user.last_login_at = _now()
        await db.flush()

        handoff = new_opaque_token()
        payload = json.dumps(
            {
                "access_token": access,
                "refresh_token": refresh_token,
                "expires_at": exp,
                "user_id": str(user.id),
            }
        )
        try:
            await redis_client.setex(
                f"{OAUTH_HANDOFF_PREFIX}{handoff}", OAUTH_HANDOFF_TTL, payload
            )
        except RedisError as exc:
            # Unlike rate limiting, this fails closed: with no handoff store
            # there is no way to deliver the session at all, and putting the
            # tokens in the URL instead would leak them to access logs and the
            # Referer header.
            logger.error("Redis unavailable during OAuth handoff: %s", exc)
            raise goauth.OAuthError("oauth_unavailable", "Sign-in is temporarily unavailable.")

        await db.commit()

        target = _frontend(f"/auth/callback?code={handoff}")
        response = RedirectResponse(target, status_code=303)
        return response

    except goauth.OAuthError as exc:
        logger.warning("Google callback rejected: %s", exc.code)
        response = RedirectResponse(_frontend(f"/auth?error={exc.code}"), 303)
        return response
    except Exception:
        logger.exception("Unexpected failure in Google callback")
        response = RedirectResponse(_frontend("/auth?error=oauth_failed"), 303)
        return response
    finally:
        # Single use, unconditionally.
        if response is not None:
            goauth.clear_state_cookie(response)


@router.post("/google/exchange", response_model=TokenResponse)
async def google_exchange(
    payload: OAuthExchangeRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Trade the one-time handoff code for the session.

    GETDEL makes it single-use atomically, so two tabs racing on the same
    redirect cannot both claim it.
    """
    key = f"{OAUTH_HANDOFF_PREFIX}{payload.code}"
    try:
        raw = await redis_client.getdel(key)
    except RedisError as exc:
        logger.error("Redis unavailable during OAuth exchange: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sign-in is temporarily unavailable. Please try again.",
        )

    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This sign-in link has expired. Please try again.",
        )

    data = json.loads(raw)
    user = await db.scalar(select(User).where(User.id == uuid.UUID(data["user_id"])))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This sign-in link is no longer valid.",
        )

    return _token_response(
        data["access_token"], data["refresh_token"], data["expires_at"], user
    )
