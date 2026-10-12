"""Count documents opened in the PDF viewer, and flag reformats that were cut
off or sent clipped.

Revision ID: 0007_viewer_opens
Revises: 0006_terms_acceptance
"""

from alembic import op


revision = "0007_viewer_opens"
down_revision = "0006_terms_acceptance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE TABLE viewer_opens ("
        "id UUID PRIMARY KEY, "
        "user_id UUID REFERENCES users(id) ON DELETE SET NULL, "
        "created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    )
    op.execute("CREATE INDEX ix_viewer_opens_created ON viewer_opens (created_at DESC)")
    op.execute("CREATE INDEX ix_viewer_opens_user_created ON viewer_opens (user_id, created_at DESC)")
    # Nullable: only reformats set them, and older rows can't know.
    op.execute("ALTER TABLE ai_usage_events ADD COLUMN cut_off BOOLEAN")
    op.execute("ALTER TABLE ai_usage_events ADD COLUMN input_clipped BOOLEAN")


def downgrade() -> None:
    op.execute("ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS input_clipped")
    op.execute("ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS cut_off")
    op.execute("DROP TABLE IF EXISTS viewer_opens")
