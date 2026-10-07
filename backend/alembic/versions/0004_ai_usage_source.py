"""Record which surface an AI call came from (web page, PDF viewer, document).

Revision ID: 0004_ai_usage_source
Revises: 0003_explanation_history
"""

from alembic import op


revision = "0004_ai_usage_source"
down_revision = "0003_explanation_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable: events recorded before this migration have no known source.
    op.execute("ALTER TABLE ai_usage_events ADD COLUMN source VARCHAR")
    op.execute(
        "ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_events_source_check "
        "CHECK (source IS NULL OR source IN ('page', 'pdf', 'document'))"
    )
    op.execute(
        "CREATE INDEX ix_ai_usage_events_operation_created "
        "ON ai_usage_events (operation, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_ai_usage_events_operation_created")
    op.execute("ALTER TABLE ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_source_check")
    op.execute("ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS source")
