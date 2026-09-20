"""
Test harness for the auth suite.

Runs the real FastAPI app over an in-memory SQLite database, driven through
httpx's ASGI transport — so routes, dependencies, schemas and SQLAlchemy are
all exercised for real, without needing a Postgres server.

**What this harness cannot prove.** SQLite ignores `SELECT ... FOR UPDATE`, so
the tests below verify the *logic* of refresh rotation and reuse detection but
not the row locking that makes it safe under genuine concurrency. That needs a
real Postgres; see tests/README.md.
"""

import os
import uuid

# Must be set before app.core.config is imported anywhere.
os.environ.setdefault("APP_SECRET_KEY", "test-secret-key-that-is-long-enough-32+")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault("FRONTEND_URL", "http://localhost:3000")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault(
    "GOOGLE_REDIRECT_URI", "http://localhost:8000/api/v1/auth/google/callback"
)

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles


# ── Postgres types on SQLite ──────────────────────────────────────
# The models are written for Postgres. Teaching SQLite to render these two
# types is cheaper, and far less misleading, than maintaining a parallel set of
# models that could drift from the real ones.

@compiles(UUID, "sqlite")
def _uuid_sqlite(type_, compiler, **kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def db_engine():
    from app.db.database import Base
    import app.models.models  # noqa: F401  — registers the tables

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def session_factory(db_engine):
    return async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)


class FakeRedis:
    """
    Enough of redis-py's async surface for the auth paths.

    Real Redis is not required to prove any of the properties under test, and
    reaching for the configured Upstash instance would make the suite depend on
    the network and pollute a live database.
    """

    def __init__(self):
        self.store: dict[str, str] = {}
        self.expiry: dict[str, int] = {}

    async def incr(self, key):
        value = int(self.store.get(key, 0)) + 1
        self.store[key] = str(value)
        return value

    async def expire(self, key, seconds):
        self.expiry[key] = seconds
        return True

    async def ttl(self, key):
        return self.expiry.get(key, -1)

    async def delete(self, key):
        self.store.pop(key, None)
        return 1

    async def setex(self, key, ttl, value):
        self.store[key] = value
        self.expiry[key] = ttl
        return True

    async def get(self, key):
        return self.store.get(key)

    async def getdel(self, key):
        return self.store.pop(key, None)


@pytest_asyncio.fixture
async def fake_redis(monkeypatch):
    fake = FakeRedis()
    import app.services.rate_limit as rl
    import app.services.auth_limits as al
    import app.api.routes.auth as auth_routes

    monkeypatch.setattr(rl, "redis_client", fake)
    monkeypatch.setattr(al, "redis_client", fake)
    monkeypatch.setattr(auth_routes, "redis_client", fake)
    # The per-process fallback survives between tests otherwise, so a limit
    # tripped in one test would leak into the next.
    al._fallback.clear()
    return fake


@pytest_asyncio.fixture
async def client(session_factory, fake_redis, monkeypatch):
    """The real app, with its database dependency pointed at SQLite."""
    from app.db.database import get_db
    from app.main import app

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db

    # Nothing should reach Resend during tests.
    import app.services.email as email_service
    monkeypatch.setattr(email_service, "is_configured", lambda: True)

    sent: list[dict] = []

    async def fake_verification(to, url):
        sent.append({"type": "verify", "to": to, "url": url})
        return True

    async def fake_reset(to, url):
        sent.append({"type": "reset", "to": to, "url": url})
        return True

    monkeypatch.setattr(email_service, "send_verification_email", fake_verification)
    monkeypatch.setattr(email_service, "send_password_reset_email", fake_reset)

    import app.api.routes.auth as auth_routes
    monkeypatch.setattr(auth_routes.email_service, "is_configured", lambda: True)
    monkeypatch.setattr(auth_routes.email_service, "send_verification_email", fake_verification)
    monkeypatch.setattr(auth_routes.email_service, "send_password_reset_email", fake_reset)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        ac.sent_emails = sent  # type: ignore[attr-defined]
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def verified_user(client, session_factory):
    """
    A registered, verified account plus its credentials.

    Verification is applied directly rather than by clicking the emailed link,
    because most tests care about what happens *after* a usable account exists.
    """
    from sqlalchemy import select
    from app.models.models import User

    email = f"user-{uuid.uuid4().hex[:8]}@example.com"
    password = "correct horse battery staple"

    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "Test User"},
    )
    assert resp.status_code == 202, resp.text

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == email))
        user.email_verified = True
        await session.commit()

    return {"email": email, "password": password}
