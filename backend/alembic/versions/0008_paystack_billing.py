"""Move billing to Paystack: customer and subscription codes, plus the pending
checkout reference that makes activation idempotent.

The stripe_* columns are left in place so this is additive and reversible; a
later migration drops them once nothing reads them.

Revision ID: 0008_paystack_billing
Revises: 0007_viewer_opens
"""

from alembic import op


revision = "0008_paystack_billing"
down_revision = "0007_viewer_opens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE billing ADD COLUMN paystack_customer_code VARCHAR UNIQUE")
    op.execute("ALTER TABLE billing ADD COLUMN paystack_subscription_code VARCHAR UNIQUE")
    op.execute("ALTER TABLE billing ADD COLUMN checkout_reference VARCHAR")


def downgrade() -> None:
    op.execute("ALTER TABLE billing DROP COLUMN IF EXISTS checkout_reference")
    op.execute("ALTER TABLE billing DROP COLUMN IF EXISTS paystack_subscription_code")
    op.execute("ALTER TABLE billing DROP COLUMN IF EXISTS paystack_customer_code")
