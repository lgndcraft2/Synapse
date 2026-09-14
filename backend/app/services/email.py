"""Transactional email via Resend's HTTP API.

Uses httpx, which is already a dependency (app/core/jwt_verify.py fetches JWKS
with it), so this adds no new packages.

Every function here is best-effort and never raises: mail is always a step
*after* the thing it describes has already been persisted, so a mail failure
must never turn a saved ticket into an error the user sees. Failures are
logged loudly instead.

With RESEND_API_KEY unset the module is a no-op, so local development and CI
work without credentials.
"""

import logging
from html import escape

import httpx

from app.core.config import settings

logger = logging.getLogger("synapse.email")

_RESEND_URL = "https://api.resend.com/emails"
_TIMEOUT = 10.0


def is_configured() -> bool:
    return bool(settings.RESEND_API_KEY)


async def send_email(
    to: str,
    subject: str,
    text: str,
    html: str | None = None,
    reply_to: str | None = None,
) -> bool:
    """Send one email. Returns True if Resend accepted it, False otherwise."""
    if not is_configured():
        logger.info("Email not configured (RESEND_API_KEY unset) — skipping send to %s", to)
        return False

    payload: dict = {
        "from": settings.MAIL_FROM,
        "to": [to],
        "subject": subject,
        "text": text,
    }
    if html:
        payload["html"] = html
    if reply_to:
        # Lets the team hit Reply and land in the customer's inbox.
        payload["reply_to"] = reply_to

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                _RESEND_URL,
                json=payload,
                headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
            )
        if resp.status_code >= 400:
            logger.error(
                "Resend rejected mail to %s (%s): %s", to, resp.status_code, resp.text[:300]
            )
            return False
        # Log the provider's message id — without it a successful send is
        # indistinguishable from one that never ran, which is exactly the
        # question you have when mail doesn't arrive.
        message_id = ""
        try:
            message_id = resp.json().get("id", "")
        except Exception:
            pass
        logger.info("Sent mail to %s (resend id=%s)", to, message_id or "unknown")
        return True
    except Exception as e:
        logger.error("Could not send mail to %s: %s", to, e)
        return False


def _wrap(title: str, body_html: str) -> str:
    """Minimal branded HTML. Inline styles and no external assets — email
    clients strip <style> blocks and block remote CSS."""
    return f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
            background:#fcf9f8;color:#1b1c1c;padding:24px;line-height:1.6">
  <div style="max-width:560px;margin:0 auto;background:#f6f3f2;
              border:1px solid #3d3d38;border-radius:12px;padding:28px">
    <div style="color:#004635;font-weight:700;font-size:18px;margin-bottom:18px">Synapse</div>
    <h1 style="margin:0 0 16px;font-size:20px;color:#1b1c1c">{escape(title)}</h1>
    {body_html}
  </div>
</div>"""


async def send_ticket_to_support(
    *,
    reference: str,
    topic_label: str,
    subject: str,
    message: str,
    from_email: str,
    diagnostics: dict | None,
) -> bool:
    """Notify the team. Reply-To is the customer, so Reply just works."""
    lines = [
        f"Ticket:  {reference}",
        f"Topic:   {topic_label}",
        f"From:    {from_email}",
        "",
        message,
    ]
    diag_html = ""
    if diagnostics:
        lines += ["", "--- diagnostics ---"]
        rows = []
        for key, value in diagnostics.items():
            label = key.replace("_", " ")
            lines.append(f"{label}: {value}")
            rows.append(
                f'<tr><td style="padding:4px 12px 4px 0;color:#5e5f5b;white-space:nowrap">'
                f"{escape(label)}</td>"
                f'<td style="padding:4px 0;color:#1b1c1c;word-break:break-word">'
                f"{escape(str(value))}</td></tr>"
            )
        diag_html = (
            '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #3d3d38">'
            '<div style="font-size:12px;font-weight:600;text-transform:uppercase;'
            'letter-spacing:0.08em;color:#5e5f5b;margin-bottom:8px">Diagnostics</div>'
            f'<table style="font-size:13px;border-collapse:collapse">{"".join(rows)}</table></div>'
        )
    else:
        diag_html = (
            '<p style="margin-top:20px;padding-top:16px;border-top:1px solid #3d3d38;'
            'font-size:13px;color:#5e5f5b">The customer chose not to attach their setup details.</p>'
        )

    html = _wrap(
        subject,
        f'<p style="margin:0 0 6px;font-size:13px;color:#5e5f5b">'
        f"{escape(reference)} · {escape(topic_label)} · "
        f'<a href="mailto:{escape(from_email)}" style="color:#004635">{escape(from_email)}</a></p>'
        f'<div style="margin-top:16px;white-space:pre-wrap">{escape(message)}</div>'
        f"{diag_html}",
    )

    return await send_email(
        to=settings.SUPPORT_EMAIL,
        subject=f"[{topic_label}] {reference} — {subject}",
        text="\n".join(lines),
        html=html,
        reply_to=from_email,
    )


async def send_ticket_confirmation(
    *,
    to: str,
    reference: str,
    subject: str,
    message: str,
) -> bool:
    """Tell the customer we have it, and give them the reference to quote."""
    text = (
        f"Thanks — we've got your message.\n\n"
        f"Your reference is {reference}. Quote it if you need to follow up.\n\n"
        f"What you sent:\n{subject}\n\n{message}\n\n"
        f"You can see this ticket and its status at {settings.FRONTEND_URL.rstrip('/')}/support\n"
        f"— The Synapse team"
    )
    html = _wrap(
        "We've got your message",
        f'<p style="margin:0">Your reference is '
        f'<strong style="color:#004635">{escape(reference)}</strong> — quote it if you need to '
        f"follow up.</p>"
        f'<div style="margin-top:20px;padding:16px;background:#f0eded;border-radius:8px">'
        f'<div style="font-size:12px;font-weight:600;text-transform:uppercase;'
        f'letter-spacing:0.08em;color:#5e5f5b;margin-bottom:8px">What you sent</div>'
        f'<div style="font-weight:600;margin-bottom:8px">{escape(subject)}</div>'
        f'<div style="white-space:pre-wrap;font-size:14px">{escape(message)}</div></div>'
        f'<p style="margin-top:20px"><a href="{settings.FRONTEND_URL.rstrip("/")}/support" '
        f'style="color:#004635;font-weight:600">View your tickets</a></p>',
    )
    # Reply-To is set explicitly rather than left to fall back to the From
    # address. MAIL_FROM only has to be a domain Resend can *send* from; it
    # need not be a mailbox that can receive. Without this, a customer hitting
    # Reply on their confirmation would bounce whenever the two differ.
    return await send_email(
        to=to,
        subject=f"We've got your message ({reference})",
        text=text,
        html=html,
        reply_to=settings.SUPPORT_EMAIL,
    )
