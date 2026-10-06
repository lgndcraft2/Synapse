"""Add per-site explanation history for paid accounts.

Revision ID: 0003_explanation_history
Revises: 0002_observer_audit_and_ai_usage
"""

from alembic import op


revision = "0003_explanation_history"
down_revision = "0002_observer_audit_and_ai_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TABLE explanation_history (
    id UUID NOT NULL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    hostname VARCHAR NOT NULL,
    url TEXT,
    page_title TEXT,
    kind VARCHAR NOT NULL,
    source_text TEXT,
    anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_html TEXT NOT NULL,
    thumbnail_key VARCHAR,
    thumbnail_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT explanation_history_kind_check CHECK (kind IN ('text', 'image'))
)
    """)
    op.execute(
        "CREATE INDEX ix_explanation_history_user_host_created "
        "ON explanation_history (user_id, hostname, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX ix_explanation_history_thumbnail_expires "
        "ON explanation_history (thumbnail_expires_at) WHERE thumbnail_key IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS explanation_history")
