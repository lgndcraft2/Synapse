"""
S3-compatible storage for explanation-history thumbnails.

Optional by design. When EXPLAIN_STORAGE_* is not configured every function
here is a no-op (or returns None), so the API, history and the test suite all
work without object storage — and without boto3 installed, which is imported
lazily for the same reason.

boto3 is synchronous, so each call runs in a worker thread. Callers treat any
failure as "no thumbnail": a storage outage must never fail an explain.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.timeutils import as_aware, now as utc_now

logger = logging.getLogger("synapse.explain_storage")

_PRESIGN_SECONDS = 10 * 60
_PURGE_BATCH = 200

_client = None


def is_configured() -> bool:
    return settings.explain_storage_configured


def _s3():
    """Build the boto3 client on first use."""
    global _client
    if _client is None:
        import boto3  # lazy: optional dependency
        from botocore.config import Config

        _client = boto3.client(
            "s3",
            endpoint_url=settings.EXPLAIN_STORAGE_ENDPOINT,
            aws_access_key_id=settings.EXPLAIN_STORAGE_ACCESS_KEY_ID,
            aws_secret_access_key=settings.EXPLAIN_STORAGE_SECRET_ACCESS_KEY,
            region_name=settings.EXPLAIN_STORAGE_REGION or None,
            config=Config(
                signature_version="s3v4",
                connect_timeout=5,
                read_timeout=10,
                retries={"max_attempts": 2},
            ),
        )
    return _client


def thumbnail_key_for(user_id: uuid.UUID, entry_id: uuid.UUID) -> str:
    # Prefixed by user so an account's objects can be found (or expired by a
    # bucket lifecycle rule) without the database.
    return f"explain-thumbnails/{user_id}/{entry_id}.webp"


def thumbnail_expiry(created_at: datetime | None = None) -> datetime:
    return (created_at or utc_now()) + timedelta(days=settings.EXPLAIN_THUMBNAIL_RETENTION_DAYS)


async def put_thumbnail(key: str, data: bytes) -> bool:
    """Store a WebP thumbnail. Returns False (and logs) on any failure."""
    if not is_configured():
        return False
    try:
        await asyncio.to_thread(
            _s3().put_object,
            Bucket=settings.EXPLAIN_STORAGE_BUCKET,
            Key=key,
            Body=data,
            ContentType="image/webp",
            CacheControl="private, max-age=600",
        )
        return True
    except Exception:
        logger.exception("Thumbnail upload failed")
        return False


async def delete_thumbnail(key: str | None) -> bool:
    """Delete a thumbnail object. Returns False (and logs) on any failure."""
    if not key or not is_configured():
        return False
    try:
        await asyncio.to_thread(
            _s3().delete_object,
            Bucket=settings.EXPLAIN_STORAGE_BUCKET,
            Key=key,
        )
        return True
    except Exception:
        logger.exception("Thumbnail delete failed")
        return False


async def delete_thumbnails(keys: list[str]) -> None:
    """Best-effort delete of several thumbnails."""
    keys = [k for k in keys if k]
    if keys and is_configured():
        await asyncio.gather(*(delete_thumbnail(k) for k in keys))


async def presigned_thumbnail_url(key: str | None, expires_at: datetime | None) -> str | None:
    """Short-lived GET URL, or None if absent, expired, unconfigured or failing."""
    if not key or not is_configured():
        return None
    if expires_at is not None and as_aware(expires_at) <= utc_now():
        return None
    try:
        return await asyncio.to_thread(
            _s3().generate_presigned_url,
            "get_object",
            Params={"Bucket": settings.EXPLAIN_STORAGE_BUCKET, "Key": key},
            ExpiresIn=_PRESIGN_SECONDS,
        )
    except Exception:
        logger.exception("Thumbnail presign failed")
        return None


# ── Retention purge ───────────────────────────────────────────────

async def purge_expired_thumbnails(db: AsyncSession) -> int:
    """Delete thumbnails past retention and clear their keys. Returns the count.

    The explanation text stays. An object that fails to delete keeps its key,
    so the next run retries it instead of orphaning it in the bucket.
    """
    from app.models.models import ExplanationHistory

    if not is_configured():
        return 0

    purged = 0
    while True:
        rows = (await db.execute(
            select(ExplanationHistory.id, ExplanationHistory.thumbnail_key)
            .where(
                ExplanationHistory.thumbnail_key.isnot(None),
                ExplanationHistory.thumbnail_expires_at < utc_now(),
            )
            .limit(_PURGE_BATCH)
        )).all()
        if not rows:
            break

        results = await asyncio.gather(*(delete_thumbnail(key) for _, key in rows))
        cleared = [row_id for (row_id, _), ok in zip(rows, results) if ok]
        if cleared:
            await db.execute(
                update(ExplanationHistory)
                .where(ExplanationHistory.id.in_(cleared))
                .values(thumbnail_key=None, thumbnail_expires_at=None)
            )
            await db.commit()
            purged += len(cleared)
        if len(cleared) < len(rows):
            # Storage is failing; stop rather than spin on the same rows.
            break

    return purged


_PURGE_INTERVAL_SECONDS = 6 * 60 * 60
_PURGE_FIRST_RUN_DELAY_SECONDS = 5 * 60


async def run_purge_loop() -> None:
    """Purge expired thumbnails every few hours. Never raises except on cancel."""
    from app.db.database import AsyncSessionLocal

    await asyncio.sleep(_PURGE_FIRST_RUN_DELAY_SECONDS)
    while True:
        try:
            async with AsyncSessionLocal() as session:
                purged = await purge_expired_thumbnails(session)
            if purged:
                logger.info("Purged %d expired explanation thumbnails.", purged)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Thumbnail purge run failed; will retry next interval.")
        await asyncio.sleep(_PURGE_INTERVAL_SECONDS)
