from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings

# Pool settings are Postgres-specific; SQLite's StaticPool rejects them
# outright, which matters because the test suite runs the real app against an
# in-memory SQLite database.
_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

_engine_kwargs: dict = {
    "echo": (settings.APP_ENV == "development"),
}

if not _is_sqlite:
    _engine_kwargs.update(
        pool_pre_ping=True,
        # Deliberately modest. The previous 10 + 20 allowed 30 connections per
        # worker process, which several workers will happily use to exhaust a
        # managed Postgres instance's connection limit.
        pool_size=5,
        max_overflow=5,
        # Managed providers (Neon among them) drop idle connections; recycling
        # first avoids handing the app a socket the server has already closed.
        pool_recycle=300,
    )

    # asyncpg caches prepared statements per connection. A transaction-mode
    # pooler hands out a different backend each time, so the cache goes stale
    # and queries fail intermittently with InvalidSQLStatementNameError —
    # miserable to diagnose. Prefer a direct endpoint; if you must use a pooled
    # one, disabling the cache is what makes it survivable.
    if "pgbouncer" in settings.DATABASE_URL or "-pooler" in settings.DATABASE_URL:
        _engine_kwargs["connect_args"] = {"statement_cache_size": 0}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
