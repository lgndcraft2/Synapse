"""
First-party Google OAuth.

Previously this whole dance happened on Supabase's servers, which is why the
`state` parameter could not be owned here: nothing in this codebase built the
authorize URL, and Google's callback never touched our domain. Both are true
now, so the CSRF binding is ours to hold.

The mechanism, end to end:

  1. `/start` generates a random `state`, a `nonce` and a PKCE verifier, packs
     them into one signed cookie, and redirects to Google.
  2. Google bounces the user back to `/callback` with `state` in the query.
  3. `/callback` compares the query `state` to the cookie copy in constant
     time, and deletes the cookie on every exit path — success, failure, or
     user cancellation.

A request that arrives without the cookie cannot have started here, which is
exactly the forged-callback case CSRF protection exists to stop.
"""

import logging
from urllib.parse import urlencode

import httpx
from fastapi import Response

from app.core.config import settings
from app.core.security import (
    new_opaque_token,
    pkce_pair,
    sign_state_blob,
    tokens_equal,
    unsign_state_blob,
)

logger = logging.getLogger("synapse.auth")

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# The cookie is scoped to the callback path so it rides along on exactly one
# request in the entire application and is invisible everywhere else.
COOKIE_NAME = "syn_oauth"
COOKIE_PATH = "/api/v1/auth/google"
COOKIE_TTL_SECONDS = 600


class OAuthError(Exception):
    """A callback that cannot be completed. `code` becomes ?error= on the SPA."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def safe_next_path(raw: str | None) -> str:
    """
    Only same-origin relative paths survive.

    Mirrors getNextPath() in the SPA (webpage/src/AuthPage.tsx). `//evil.com`
    is the case worth naming: it is a protocol-relative *absolute* URL that
    passes a naive startswith("/") check and turns this into an open redirect.
    """
    if raw and raw.startswith("/") and not raw.startswith("//"):
        return raw
    return "/dashboard"


def build_authorize_url(next_path: str | None) -> tuple[str, str]:
    """
    Return (redirect_url, signed_cookie_value) for the start of the flow.

    Everything the callback needs to verify itself lives in the cookie. Nothing
    is stored server-side on purpose: the cookie *is* the proof that the
    browser finishing the flow is the one that began it, and a server-side copy
    that did not require the cookie would give that property away.
    """
    if not settings.google_oauth_configured:
        raise OAuthError("oauth_unconfigured", "Google sign-in is not configured.")

    state = new_opaque_token()
    nonce = new_opaque_token()
    verifier, challenge = pkce_pair()

    cookie_value = sign_state_blob(
        {
            "state": state,
            "nonce": nonce,
            "verifier": verifier,
            "next": safe_next_path(next_path),
        },
        COOKIE_TTL_SECONDS,
    )

    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # We only ever want an id_token, never offline access to the user's
        # Google data, so do not ask for a Google refresh token.
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}", cookie_value


def set_state_cookie(response: Response, value: str) -> None:
    """
    Attach the transaction cookie.

    SameSite must be Lax. Strict looks stronger and is in fact fatal here: the
    return from accounts.google.com is a cross-site top-level navigation, and
    Strict withholds the cookie on exactly that, producing a 100% failure rate
    that presents as "state mismatch". Lax still blocks the cross-site POST and
    sub-resource loads that CSRF actually needs.
    """
    response.set_cookie(
        COOKIE_NAME,
        value,
        max_age=COOKIE_TTL_SECONDS,
        httponly=True,
        secure=settings.cookies_secure,
        samesite="lax",
        path=COOKIE_PATH,
    )


def clear_state_cookie(response: Response) -> None:
    """
    Single use, enforced on every exit path.

    Must be called on the same Response object being returned, which is why
    this cannot live in a dependency. Path has to match the one used when
    setting, or the browser keeps the original cookie.
    """
    response.delete_cookie(
        COOKIE_NAME,
        path=COOKIE_PATH,
        httponly=True,
        secure=settings.cookies_secure,
        samesite="lax",
    )


def verify_state(cookie_value: str | None, query_state: str | None) -> dict:
    """
    The check this whole module exists for.

    Returns the unpacked transaction on success; raises OAuthError otherwise.
    """
    if not cookie_value:
        # No cookie means this callback did not originate from our /start.
        raise OAuthError("oauth_state", "Missing OAuth transaction cookie.")

    tx = unsign_state_blob(cookie_value)
    if tx is None:
        # Tampered or past its 10-minute expiry.
        raise OAuthError("oauth_state", "Invalid or expired OAuth transaction.")

    if not query_state or not tx.get("state"):
        raise OAuthError("oauth_state", "Missing state parameter.")

    # Constant time: a byte-by-byte comparison that short-circuits would leak
    # the expected value to an attacker who can retry.
    if not tokens_equal(tx["state"], query_state):
        raise OAuthError("oauth_state", "State parameter mismatch.")

    return tx


async def exchange_code(code: str, verifier: str) -> dict:
    """Trade the authorization code for Google's token response."""
    payload = {
        "code": code,
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(TOKEN_URL, data=payload)

    if resp.status_code != 200:
        # Google puts the reason in the body; the status alone is useless for
        # diagnosing a redirect_uri mismatch, which is the usual cause.
        logger.error(
            "Google token exchange failed (%s): %s", resp.status_code, resp.text[:500]
        )
        raise OAuthError("oauth_exchange", "Could not complete Google sign-in.")

    data = resp.json()
    if not data.get("id_token"):
        raise OAuthError("oauth_exchange", "Google did not return an identity token.")
    return data


async def verify_id_token(raw_id_token: str, expected_nonce: str) -> dict:
    """
    Validate Google's id_token and return its claims.

    google-auth does the signature, issuer, audience and expiry checks against
    Google's published keys. The nonce check is ours: it binds this identity
    token to the specific authorize request we started, which is what stops a
    token obtained elsewhere being replayed into our callback.
    """
    import asyncio

    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    def _verify() -> dict:
        return google_id_token.verify_oauth2_token(
            raw_id_token,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID,
            # Small tolerance: Google's clock and ours are not identical, and a
            # freshly issued token can otherwise appear to be from the future.
            clock_skew_in_seconds=10,
        )

    try:
        # verify_oauth2_token fetches Google's certs over the network, so it
        # blocks. Off the event loop it goes.
        claims = await asyncio.to_thread(_verify)
    except Exception as exc:
        logger.error("Google id_token verification failed: %s", exc)
        raise OAuthError("oauth_identity", "Could not verify your Google identity.")

    if not tokens_equal(str(claims.get("nonce") or ""), expected_nonce):
        logger.warning("Google id_token nonce mismatch")
        raise OAuthError("oauth_identity", "Could not verify your Google identity.")

    if not claims.get("email"):
        raise OAuthError("oauth_identity", "Google did not return an email address.")

    # An unverified Google address that happens to match a local account is a
    # straight account-takeover path, so it is refused outright rather than
    # merely declining to link.
    if claims.get("email_verified") is not True:
        raise OAuthError(
            "oauth_unverified",
            "Your Google account's email address is not verified.",
        )

    return claims
