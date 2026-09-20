"""
Prepare a throwaway database for the Playwright run.

Creates the schema and one already-verified account, so the end-to-end suite
can sign in without a live mailbox. Verification itself is covered by the
pytest suite; what Playwright is here to exercise is the browser-and-extension
contract, which starts *after* a session exists.

SQLite rather than Postgres so the suite runs anywhere. The Alembic migration
emits Postgres DDL, so the schema is created from the ORM metadata with the
same type shims conftest uses.

    python -m tests.seed_e2e <sqlite-file-path>

Prints the seeded credentials as JSON.
"""

import asyncio
import json
import os
import sys

os.environ.setdefault("APP_SECRET_KEY", "e2e-secret-key-long-enough-for-validation")
os.environ.setdefault("APP_ENV", "development")

from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.ext.compiler import compiles


@compiles(UUID, "sqlite")
def _uuid_sqlite(type_, compiler, **kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


# Not a .test/.invalid/.localhost domain: those are RFC 2606 special-use
# names and email-validator (behind pydantic EmailStr) refuses them, so
# login would 422 before it ever reached the password check.
E2E_EMAIL = "synapse-e2e@example.com"
E2E_PASSWORD = "playwright-e2e-password"


async def main(db_path: str) -> None:
    url = f"sqlite+aiosqlite:///{db_path}"
    os.environ["DATABASE_URL"] = url

    from app.db.database import Base
    from app.core.security import hash_password
    from app.services.provisioning import provision_user
    import app.models.models  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        user = await provision_user(
            session,
            email=E2E_EMAIL,
            name="E2E Tester",
            password_hash=await hash_password(E2E_PASSWORD),
            email_verified=True,
        )
        await session.commit()
        user_id = str(user.id)

    await engine.dispose()
    print(json.dumps({"email": E2E_EMAIL, "password": E2E_PASSWORD, "user_id": user_id}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m tests.seed_e2e <sqlite-file-path>")
    asyncio.run(main(sys.argv[1]))
