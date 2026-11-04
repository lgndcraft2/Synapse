"""Per-site usage counters behind the dashboard's "most used on" list.

One row per user and hostname: three counters and a last-used time. No paths,
titles or dates of individual visits, so this can't be read back as a browsing
history. The extension leaves sensitive sites (mail, banking, messaging) out by
not setting `site_stats`, and rows go with the account (ON DELETE CASCADE).
"""

import logging
from urllib.parse import urlparse

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timeutils import now as utc_now
from app.models.models import SiteActivity, User

logger = logging.getLogger("synapse.site_activity")

# History "site" for local (file://) documents, which have no host. The
# extension uses the same name (LOCAL_FILES_HOST in extension/lib/geometry.js).
LOCAL_FILES_HOST = "local-files"

_FEATURE_COLUMNS = {"explain": "explains", "respond": "responds", "reformat": "reformats"}


def hostname_for(page_url: str | None) -> str | None:
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


async def record_site_use(db: AsyncSession, user: User, page_url: str | None, feature: str) -> None:
    """Add one to `feature` for this user and site.

    A statistic must never cost the reader their result, so a failure is
    logged and dropped. The savepoint keeps it from poisoning the request's
    transaction.
    """
    hostname = hostname_for(page_url)
    if not hostname:
        return
    column = _FEATURE_COLUMNS[feature]
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    used_at = utc_now()
    statement = insert(SiteActivity).values(
        user_id=user.id, hostname=hostname, last_used_at=used_at, **{column: 1},
    )
    statement = statement.on_conflict_do_update(
        index_elements=["user_id", "hostname"],
        set_={column: getattr(SiteActivity, column) + 1, "last_used_at": used_at},
    )
    try:
        async with db.begin_nested():
            await db.execute(statement)
    except Exception:
        logger.exception("Could not record site activity")
