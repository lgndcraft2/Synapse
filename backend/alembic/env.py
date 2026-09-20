"""
Alembic environment.

Two things here are not boilerplate and should not be simplified away:

  * The URL comes from app.core.config, not alembic.ini, so there is a single
    source of truth. It prefers MIGRATION_DATABASE_URL, because DDL and
    advisory locks are unreliable through a transaction-mode connection pooler
    and the application may legitimately be pointed at one.
  * An advisory lock wraps the migration run. The container entrypoint calls
    `alembic upgrade head` on boot, so a multi-instance deploy starts several
    of these at once; without the lock they race and one crashes the rollout.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool, text
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import settings
from app.db.database import Base

# Importing the models is what populates Base.metadata. Without it
# --autogenerate sees an empty schema and cheerfully proposes dropping
# every table.
import app.models.models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# asyncpg does not understand the '%' escaping ConfigParser applies, and
# passwords routinely contain characters that trip it, so the URL is injected
# rather than templated through the ini file.
config.set_main_option("sqlalchemy.url", settings.migration_database_url)

# Arbitrary but fixed: any two processes must derive the same lock id.
_LOCK_ID = 8_274_591_033


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting. `alembic upgrade head --sql`."""
    context.configure(
        url=settings.migration_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Without these two, `alembic check` reports clean while real drift
        # (a widened column, a changed default) sits in the database.
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        # Serialises concurrent `upgrade head` calls from parallel instances.
        # Released automatically when the session ends.
        connection.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _LOCK_ID})
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
