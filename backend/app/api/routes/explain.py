"""
Explain: one endpoint for highlight-to-explain and circle-to-explain.

The contract lives in docs/explain-api.md. Two privacy rules shape this file:

  * The full-size crop goes to the model and nowhere else — not the database,
    not object storage, not a log line. Paid history keeps only a small
    client-made WebP thumbnail, which is purged after the retention window.
  * Every history query filters on the caller's user id. The one route that
    takes an id from the URL also filters on the owner, so another user's
    entry is indistinguishable from a missing one (404).
  * Uploaded document text (POST /explain/context) lives only in Redis, for
    an hour, under the caller's identity. It is never written to the database
    or logged; see app/services/explain_context.py.
"""

import asyncio
import base64
import binascii
import json
import logging
import uuid
from datetime import datetime
from time import perf_counter
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from redis.exceptions import RedisError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.reformat import _is_premium_active, _record_ai_usage, _validate_input_length
from app.core.config import settings
from app.core.dependencies import get_optional_user
from app.core.timeutils import as_aware, now as utc_now
from app.db.database import get_db
from app.models.models import ExplanationHistory, User
from app.schemas.schemas import (
    ExplainContextUploadRequest, ExplainContextUploadResponse,
    ExplainRequest, ExplainResponse, ExplainUsage,
    ExplanationHistoryDeleted, ExplanationHistoryOut, ExplanationHistoryPage,
)
from app.services import ai, explain_context, explain_storage
from app.services.explain_limits import (
    _caller_identity, check_explain_burst, refund_image_capture, reserve_image_capture,
)
from app.services.profile_context import (
    apply_session_difficulty, load_feedback_summary, load_profile,
)
from app.services.rate_limit import _active_paid_plan, check_rate_limit

logger = logging.getLogger("synapse.explain")

router = APIRouter(prefix="/explain", tags=["explain"])

_ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
_IMAGE_TEXT_LIMIT = 20_000      # DOM text sent alongside a circled image
_HISTORY_SOURCE_LIMIT = 2_000   # source text kept in history
_MAX_ANCHOR_BYTES = 4 * 1024
# Measured in characters of the compact JSON after the per-field caps, so
# non-Latin text is not penalised by its UTF-8 width.
_MAX_CONTEXT_CHARS = 24 * 1024
_CONTEXT_UNITS = 4              # reformat units for a text explain with page/document context

_DOCUMENT_TEXT_TYPES = {"text/plain", "text/csv", "text/markdown"}
_MAX_PDF_BYTES = 20 * 1024 * 1024
_MAX_DOCUMENT_CHARS = 2_000_000


def _invalid(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": "INVALID_REQUEST", "message": message},
    )


def _decode_base64(value: str, label: str, max_bytes: int) -> bytes:
    """Decode strict base64, rejecting data: URLs and oversized payloads."""
    # Cheap ceiling before decoding: 4 base64 chars carry 3 bytes.
    if len(value) > (max_bytes * 4) // 3 + 4:
        raise _invalid(f"{label} is too large.")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise _invalid(f"{label} must be raw base64 without a data: prefix.")
    if not data:
        raise _invalid(f"{label} is empty.")
    if len(data) > max_bytes:
        raise _invalid(f"{label} is too large.")
    return data


def _context_expired() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "code": "CONTEXT_EXPIRED",
            "message": "That document context has expired. Upload it again.",
        },
    )


def _context_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "CONTEXT_UNAVAILABLE",
            "message": "Document context is temporarily unavailable.",
        },
    )


# History "site" for local (file://) documents, which have no host. The
# extension uses the same name (LOCAL_FILES_HOST in extension/lib/geometry.js).
LOCAL_FILES_HOST = "local-files"


def _hostname_for(page_url: str | None) -> str | None:
    """Lowercased host of an http(s) URL, LOCAL_FILES_HOST for file:// URLs,
    or None when there isn't a usable one."""
    if not page_url:
        return None
    try:
        parsed = urlparse(page_url.strip())
        host = parsed.hostname
    except ValueError:
        return None
    if parsed.scheme == "file":
        return LOCAL_FILES_HOST
    if parsed.scheme not in ("http", "https") or not host:
        return None
    return host.lower()


async def _require_user(request: Request, db: AsyncSession) -> User:
    """401 rather than HTTPBearer's 403 when no usable token is presented."""
    user = await get_optional_user(request, db)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to manage explanation history.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def _entry_out(row: ExplanationHistory) -> ExplanationHistoryOut:
    return ExplanationHistoryOut(
        id=row.id,
        hostname=row.hostname,
        url=row.url,
        page_title=row.page_title,
        kind=row.kind,
        source_text=row.source_text,
        anchor=row.anchor or {},
        result_html=row.result_html,
        thumbnail_url=await explain_storage.presigned_thumbnail_url(
            row.thumbnail_key, row.thumbnail_expires_at
        ),
        created_at=as_aware(row.created_at),
    )


@router.post("", response_model=ExplainResponse)
async def explain(
    request: Request,
    body: ExplainRequest,
    db: AsyncSession = Depends(get_db),
):
    # ── 1. Validate the request shape ─────────────────────────────
    # Everything here is checked before any quota is touched, so a malformed
    # request never costs the caller anything.
    text = body.text or ""
    image_bytes: bytes | None = None
    thumbnail_bytes: bytes | None = None

    if body.kind == "text":
        if body.image_base64 or body.image_media_type:
            raise _invalid("An image can only be sent with kind \"image\".")
        if body.thumbnail_base64:
            raise _invalid("A thumbnail can only be sent with kind \"image\".")
        if not text.strip():
            raise _invalid("There is no text to explain.")
    else:
        if not body.image_base64:
            raise _invalid("kind \"image\" requires image_base64.")
        if body.image_media_type not in _ALLOWED_IMAGE_TYPES:
            raise _invalid("image_media_type must be image/png, image/jpeg or image/webp.")
        image_bytes = _decode_base64(body.image_base64, "image_base64", settings.EXPLAIN_MAX_IMAGE_BYTES)
        if body.thumbnail_base64:
            thumbnail_bytes = _decode_base64(
                body.thumbnail_base64, "thumbnail_base64", settings.EXPLAIN_MAX_THUMBNAIL_BYTES
            )
            # Served back to browsers from our bucket as image/webp, so it must
            # actually be one.
            if not (thumbnail_bytes[:4] == b"RIFF" and thumbnail_bytes[8:12] == b"WEBP"):
                raise _invalid("thumbnail_base64 must be a WebP image.")
        text = text[:_IMAGE_TEXT_LIMIT]

    anchor = body.anchor or {}
    if len(json.dumps(anchor, separators=(",", ":"))) > _MAX_ANCHOR_BYTES:
        raise _invalid("anchor is too large.")

    # The schema has already trimmed and capped every context field; only the
    # total is a hard error.
    context = body.context.model_dump(exclude_none=True) if body.context else None
    if context and len(json.dumps(context, ensure_ascii=False, separators=(",", ":"))) > _MAX_CONTEXT_CHARS:
        raise _invalid("context is too large.")
    context_text = ai.format_explain_context(context)
    has_page_context = bool(body.context and body.context.page and body.context.page.has_content())

    # ── 2. Identify user, length check, document context ──────────
    user = await get_optional_user(request, db)
    if body.kind == "text":
        await _validate_input_length(db, user, text)

    # Resolved before any quota is touched: an expired id costs nothing, and
    # the extension re-uploads and retries. A Redis outage reads as expired,
    # so the re-upload answers 503 and the extension falls back to local
    # context only.
    document_text = ""
    if body.context_id:
        identity = _caller_identity(user, body.fingerprint, request)
        try:
            stored = await explain_context.load(identity, body.context_id)
        except RedisError as e:
            logger.warning("Document context lookup failed (%s).", e)
            stored = None
        if stored is None:
            raise _context_expired()
        document, _ = stored
        if document:
            document_text = await asyncio.to_thread(explain_context.select_passages, document, text)

    # ── 3. Quotas: burst for everyone, then text or image quota ───
    await check_explain_burst(user, body.fingerprint, request)
    image_usage = None
    if body.kind == "text":
        # Page or document context makes the call several times larger, so it
        # costs several reformats. All-or-nothing; see check_rate_limit.
        units = _CONTEXT_UNITS if (has_page_context or document_text) else 1
        await check_rate_limit(db, user, body.fingerprint, request, units=units)
    else:
        image_usage = await reserve_image_capture(db, user, body.fingerprint, request)

    # ── 4. Prompt context ─────────────────────────────────────────
    profile = await load_profile(db, user, body.profile)
    feedback_summary = await load_feedback_summary(db, user, body.recent_feedback)
    feedback_summary = apply_session_difficulty(profile, feedback_summary, body.session_difficulty)

    # ── 5. Call the model ─────────────────────────────────────────
    is_premium = await _is_premium_active(user, db)
    provider = "claude" if is_premium else "gemini"
    operation = f"explain_{body.kind}"
    # Older extensions don't send a source; a document context implies one.
    source = body.source or ("document" if body.context_id else "page")
    input_characters = len(text) + len(context_text) + len(document_text)
    ai_started = perf_counter()
    try:
        html = await ai.call_explain(
            text,
            body.image_base64 if image_bytes is not None else None,
            body.image_media_type if image_bytes is not None else None,
            profile,
            feedback_summary,
            use_claude=is_premium,
            context_text=context_text,
            document_text=document_text,
        )
    except Exception:
        # The traceback may name the provider endpoint; it stays server-side.
        logger.exception("explain (%s) provider call failed", body.kind)
        if image_usage is not None:
            await refund_image_capture(image_usage)
        _record_ai_usage(
            db, user=user, provider=provider, operation=operation, source=source,
            input_characters=input_characters, output_characters=0,
            duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=False,
        )
        # get_db rolls back on any exception, which would discard the failure
        # record (and the text quota already charged). Keep both.
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "AI_UNAVAILABLE",
                "message": "Explaining is temporarily unavailable. Please try again.",
            },
        )

    _record_ai_usage(
        db, user=user, provider=provider, operation=operation, source=source,
        input_characters=input_characters, output_characters=len(html),
        duration_ms=(perf_counter() - ai_started) * 1_000, succeeded=True,
    )

    # ── 6. Paid history ───────────────────────────────────────────
    history_entry = None
    hostname = _hostname_for(body.page_url)
    if user and hostname and await _active_paid_plan(db, user):
        created_at = utc_now()
        row = ExplanationHistory(
            id=uuid.uuid4(),
            user_id=user.id,
            hostname=hostname,
            url=body.page_url,
            page_title=body.page_title,
            kind=body.kind,
            source_text=text[:_HISTORY_SOURCE_LIMIT],
            anchor=anchor,
            result_html=html,
            created_at=created_at,
        )
        if thumbnail_bytes and explain_storage.is_configured():
            key = explain_storage.thumbnail_key_for(user.id, row.id)
            if await explain_storage.put_thumbnail(key, thumbnail_bytes):
                row.thumbnail_key = key
                row.thumbnail_expires_at = explain_storage.thumbnail_expiry(created_at)
        db.add(row)
        await db.flush()
        history_entry = await _entry_out(row)

    usage = None
    if image_usage is not None:
        usage = ExplainUsage(
            image_captures_used=image_usage.used,
            image_captures_limit=image_usage.limit,
            image_period=image_usage.period,
        )

    return ExplainResponse(
        html=html,
        kind=body.kind,
        model_used="claude-sonnet" if is_premium else "gemini-flash",
        history_entry=history_entry,
        usage=usage,
    )


@router.post("/context", response_model=ExplainContextUploadResponse)
async def upload_context(
    request: Request,
    body: ExplainContextUploadRequest,
    db: AsyncSession = Depends(get_db),
):
    """Keep a document's text for an hour so later explains can use it.

    Costs no quota (explains are charged instead) but shares the explain burst
    cap. The text lives only in Redis; see app/services/explain_context.py.
    """
    # ── 1. Validate ───────────────────────────────────────────────
    has_pdf = bool(body.document_base64)
    has_text = bool(body.document_text)
    if has_pdf == has_text:
        raise _invalid("Send exactly one of document_base64 or document_text.")
    media_type = body.media_type.strip().lower()
    pdf_bytes: bytes | None = None
    if has_pdf:
        if media_type != "application/pdf":
            raise _invalid("document_base64 is for media_type application/pdf.")
        pdf_bytes = _decode_base64(body.document_base64, "document_base64", _MAX_PDF_BYTES)
        if b"%PDF-" not in pdf_bytes[:1024]:
            raise _invalid("document_base64 is not a PDF.")
        digest = explain_context.content_hash("pdf", pdf_bytes)
    else:
        if media_type not in _DOCUMENT_TEXT_TYPES:
            raise _invalid("document_text must be text/plain, text/csv or text/markdown.")
        if len(body.document_text) > _MAX_DOCUMENT_CHARS:
            raise _invalid(f"document_text is over {_MAX_DOCUMENT_CHARS:,} characters.")
        digest = explain_context.content_hash("text", body.document_text.encode("utf-8"))

    # ── 2. Burst cap ──────────────────────────────────────────────
    user = await get_optional_user(request, db)
    await check_explain_burst(user, body.fingerprint, request)

    # ── 3. Same document again: reuse it and refresh its TTL ──────
    identity = _caller_identity(user, body.fingerprint, request)
    context_id = explain_context.context_id_for(identity, digest)
    try:
        existing = await explain_context.load(identity, context_id)
    except RedisError as e:
        logger.warning("Document context store unavailable (%s).", e)
        raise _context_unavailable()
    if existing is not None:
        stored_text, truncated = existing
        return ExplainContextUploadResponse(
            context_id=context_id, chars=len(stored_text), truncated=truncated,
            expires_in=explain_context.CONTEXT_TTL_SECONDS,
        )

    # ── 4. Extract, compress, store ───────────────────────────────
    if pdf_bytes is not None:
        try:
            text, truncated = await asyncio.to_thread(explain_context.extract_pdf_text, pdf_bytes)
        except explain_context.PdfUnreadable:
            raise _invalid("document_base64 is not a readable PDF.")
        except ImportError:
            logger.error("pypdf is not installed; PDF document context is unavailable.")
            raise _context_unavailable()
    else:
        text = explain_context.normalise_text(body.document_text)
        truncated = len(text) > explain_context.STORE_CHAR_LIMIT

    value, text, truncated = explain_context.encode_value(text, truncated)
    try:
        await explain_context.store(identity, context_id, value)
    except RedisError as e:
        logger.warning("Document context store unavailable (%s).", e)
        raise _context_unavailable()

    return ExplainContextUploadResponse(
        context_id=context_id, chars=len(text), truncated=truncated,
        expires_in=explain_context.CONTEXT_TTL_SECONDS,
    )


@router.get("/history", response_model=ExplanationHistoryPage)
async def list_history(
    request: Request,
    domain: str = Query(..., min_length=1, max_length=253),
    limit: int = Query(50, ge=1, le=100),
    before: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """The caller's saved explanations for one hostname, newest first."""
    user = await _require_user(request, db)
    if not await _active_paid_plan(db, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "HISTORY_REQUIRES_PAID",
                "message": "Synced explanation history is part of the paid plans.",
            },
        )

    query = select(ExplanationHistory).where(
        ExplanationHistory.user_id == user.id,
        ExplanationHistory.hostname == domain.strip().lower(),
    )
    if before is not None:
        query = query.where(ExplanationHistory.created_at < as_aware(before))
    rows = (await db.execute(
        query.order_by(ExplanationHistory.created_at.desc()).limit(limit + 1)
    )).scalars().all()

    has_more = len(rows) > limit
    rows = rows[:limit]
    entries = [await _entry_out(row) for row in rows]
    return ExplanationHistoryPage(
        entries=entries,
        next_before=entries[-1].created_at if has_more else None,
    )


@router.delete("/history/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_history_entry(
    entry_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Delete one of the caller's own entries. Allowed on any plan."""
    user = await _require_user(request, db)
    row = await db.scalar(
        select(ExplanationHistory).where(
            ExplanationHistory.id == entry_id,
            ExplanationHistory.user_id == user.id,
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found.")

    await explain_storage.delete_thumbnail(row.thumbnail_key)
    await db.execute(
        delete(ExplanationHistory).where(
            ExplanationHistory.id == entry_id,
            ExplanationHistory.user_id == user.id,
        )
    )
    await db.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/history", response_model=ExplanationHistoryDeleted)
async def delete_history(
    request: Request,
    domain: str | None = Query(None, max_length=253),
    all_entries: bool = Query(False, alias="all"),
    db: AsyncSession = Depends(get_db),
):
    """Delete the caller's entries for one hostname, or all of them. Any plan."""
    user = await _require_user(request, db)
    domain = (domain or "").strip().lower() or None
    if (domain is None) == (not all_entries):
        raise _invalid("Pass exactly one of domain or all=true.")

    conditions = [ExplanationHistory.user_id == user.id]
    if domain is not None:
        conditions.append(ExplanationHistory.hostname == domain)

    keys = (await db.execute(
        select(ExplanationHistory.thumbnail_key).where(
            *conditions, ExplanationHistory.thumbnail_key.isnot(None)
        )
    )).scalars().all()
    await explain_storage.delete_thumbnails(list(keys))

    result = await db.execute(delete(ExplanationHistory).where(*conditions))
    await db.flush()
    return ExplanationHistoryDeleted(deleted=result.rowcount or 0)
