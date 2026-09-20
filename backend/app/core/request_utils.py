"""
Resolving the real client IP behind a proxy.

`request.client.host` is the address of whatever opened the TCP connection. In
local development that is the user. Behind Render's edge (or any CDN) it is the
proxy, which means every user in the world collapses into a single address.

That was merely inaccurate while the only consumer was reformat quotas. It
becomes dangerous the moment an IP is the brute-force guard on login: one
bucket for everyone means ~20 failed logins anywhere locks out the entire user
base.

The opposite mistake is just as bad. Blindly trusting the leftmost
X-Forwarded-For entry lets any caller spoof an arbitrary IP by setting the
header, which silently disables the limiter for anyone who bothers.

The only safe reading is positional: if exactly N trusted proxies sit in front
of the app, each appends one entry, so the client is the Nth from the right.
"""

from fastapi import Request

from app.core.config import settings


def client_ip(request: Request) -> str:
    """
    Best-effort real client IP, honouring TRUSTED_PROXY_COUNT.

    Returns "unknown" when it cannot be determined — callers should treat that
    as a single shared bucket rather than skipping the limit, so a
    misconfiguration fails noisy-but-safe instead of silently open.
    """
    direct = request.client.host if request.client else None
    trusted = settings.TRUSTED_PROXY_COUNT

    if trusted <= 0:
        return direct or "unknown"

    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded:
        # Header absent but proxies were expected — the deployment is
        # misconfigured, or someone reached the app directly. Fall back to the
        # socket address rather than inventing one.
        return direct or "unknown"

    # "client, proxy1, proxy2" — each trusted hop appended itself on the right.
    # With N trusted hops, entries beyond the Nth from the right are attacker
    # controlled and must be ignored.
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    if not hops:
        return direct or "unknown"

    index = len(hops) - trusted
    if index < 0:
        # Fewer entries than expected hops: the chain is shorter than
        # configured, so the leftmost is the closest thing to the client we
        # can defend.
        return hops[0]
    return hops[index]
