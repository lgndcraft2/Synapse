"""Add privacy-safe AI usage and observer action audit records.

Revision ID: 0002_observer_audit_and_ai_usage
Revises: 0001_initial_schema
"""

from alembic import op


revision = "0002_observer_audit_and_ai_usage"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TABLE ai_usage_events (
    id UUID NOT NULL PRIMARY KEY,
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    provider VARCHAR NOT NULL,
    operation VARCHAR NOT NULL DEFAULT 'reformat',
    input_characters INTEGER NOT NULL DEFAULT 0,
    output_characters INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    succeeded BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ai_usage_events_provider_check CHECK (provider IN ('gemini', 'claude'))
)
    """)
    op.execute("CREATE INDEX ix_ai_usage_events_created_provider ON ai_usage_events (created_at DESC, provider)")
    op.execute("CREATE INDEX ix_ai_usage_events_user_created ON ai_usage_events (user_id, created_at DESC)")
    op.execute("""
CREATE TABLE admin_audit_log (
    id UUID NOT NULL PRIMARY KEY,
    actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    target_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    action VARCHAR NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
)
    """)
    op.execute("CREATE INDEX ix_admin_audit_log_created ON admin_audit_log (created_at DESC)")
    op.execute("CREATE INDEX ix_admin_audit_log_target_created ON admin_audit_log (target_user_id, created_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS admin_audit_log")
    op.execute("DROP TABLE IF EXISTS ai_usage_events")
