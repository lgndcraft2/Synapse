"""Re-explain: stacked versions on history entries, and the re-explain path
behind a "clearer" rating.

Revision ID: 0005_reexplain
Revises: 0004_ai_usage_source
"""

from alembic import op


revision = "0005_reexplain"
down_revision = "0004_ai_usage_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE explanation_history "
        "ADD COLUMN versions JSONB NOT NULL DEFAULT '[]'::jsonb"
    )
    op.execute("ALTER TABLE feedback_log ADD COLUMN reexplain_path VARCHAR")


def downgrade() -> None:
    op.execute("ALTER TABLE feedback_log DROP COLUMN IF EXISTS reexplain_path")
    op.execute("ALTER TABLE explanation_history DROP COLUMN IF EXISTS versions")
