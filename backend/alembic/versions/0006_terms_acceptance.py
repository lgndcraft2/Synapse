"""Record which Terms of Service version each user accepted, and when.

Revision ID: 0006_terms_acceptance
Revises: 0005_reexplain
"""

from alembic import op


revision = "0006_terms_acceptance"
down_revision = "0005_reexplain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN terms_version VARCHAR")
    op.execute("ALTER TABLE users ADD COLUMN terms_accepted_at TIMESTAMPTZ")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS terms_accepted_at")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS terms_version")
