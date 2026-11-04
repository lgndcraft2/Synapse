"""Per-site usage counters for the dashboard's "most used on" list.

Revision ID: 0009_site_activity
Revises: 0008_paystack_billing
"""

from alembic import op


revision = "0009_site_activity"
down_revision = "0008_paystack_billing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE TABLE site_activity ("
        "user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
        "hostname VARCHAR NOT NULL, "
        "explains INTEGER NOT NULL DEFAULT 0, "
        "responds INTEGER NOT NULL DEFAULT 0, "
        "reformats INTEGER NOT NULL DEFAULT 0, "
        "last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
        "PRIMARY KEY (user_id, hostname))"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS site_activity")
