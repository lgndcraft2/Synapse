"""initial schema

Creates the full Synapse schema on a fresh database, including the
first-party auth tables (refresh_tokens, email_tokens) and the columns that
replaced Supabase Auth on users.

Generated from the SQLAlchemy metadata rather than from a pg_dump of the old
Supabase database, because no dump was available at the time this was written.
The models were first corrected to match what the live database actually had —
JSONB rather than JSON, server-side now() defaults, and the three CHECK
constraints that existed only in the database — so this should be equivalent.

Before trusting it against anything that matters, diff it with a real dump:

    npx supabase db dump --db-url "$SUPABASE_DIRECT_URL" --schema public

Revision ID: 0001_initial_schema
Revises:
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TABLE users (
	id UUID NOT NULL, 
	email VARCHAR NOT NULL, 
	name VARCHAR, 
	avatar_url VARCHAR, 
	google_id VARCHAR, 
	plan VARCHAR NOT NULL, 
	password_hash VARCHAR, 
	email_verified BOOLEAN DEFAULT 'false' NOT NULL, 
	email_verified_at TIMESTAMP WITH TIME ZONE, 
	password_changed_at TIMESTAMP WITH TIME ZONE, 
	last_login_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT users_plan_check CHECK (plan IN ('free', 'lite', 'premium', 'institutional')), 
	UNIQUE (email), 
	UNIQUE (google_id)
)
    """)

    op.execute("""
CREATE UNIQUE INDEX ix_users_email_lower ON users (lower(email))
    """)

    op.execute("""
CREATE TABLE billing (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	stripe_customer_id VARCHAR, 
	stripe_subscription_id VARCHAR, 
	plan VARCHAR NOT NULL, 
	billing_period VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	cancel_at_period_end BOOLEAN DEFAULT 'false' NOT NULL, 
	trial_ends_at TIMESTAMP WITH TIME ZONE, 
	renews_at TIMESTAMP WITH TIME ZONE, 
	cancelled_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (stripe_customer_id), 
	UNIQUE (stripe_subscription_id)
)
    """)

    op.execute("""
CREATE TABLE cognitive_profiles (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	profile_type VARCHAR NOT NULL, 
	preferred_format VARCHAR NOT NULL, 
	chunk_size VARCHAR NOT NULL, 
	needs_examples_first BOOLEAN NOT NULL, 
	simplify_vocab BOOLEAN NOT NULL, 
	max_nesting_depth INTEGER NOT NULL, 
	use_headers BOOLEAN NOT NULL, 
	notes TEXT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
)
    """)

    op.execute("""
CREATE TABLE email_tokens (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	purpose VARCHAR NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	used_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('email_verify', 'password_reset')), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (token_hash)
)
    """)

    op.execute("""
CREATE INDEX ix_email_tokens_user_id ON email_tokens (user_id)
    """)

    op.execute("""
CREATE TABLE profile_history (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	changed_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	change_summary TEXT NOT NULL, 
	previous_state JSONB NOT NULL, 
	new_state JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
)
    """)

    op.execute("""
CREATE INDEX ix_profile_history_user_changed ON profile_history (user_id, changed_at DESC)
    """)

    op.execute("""
CREATE TABLE reading_sessions (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	page_url TEXT, 
	page_title TEXT, 
	session_difficulty VARCHAR NOT NULL, 
	cards_generated INTEGER NOT NULL, 
	mode VARCHAR NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
)
    """)

    op.execute("""
CREATE INDEX ix_reading_sessions_user_created ON reading_sessions (user_id, created_at DESC)
    """)

    op.execute("""
CREATE TABLE refresh_tokens (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	family_id UUID NOT NULL, 
	parent_id UUID, 
	token_hash VARCHAR(64) NOT NULL, 
	client VARCHAR DEFAULT 'web' NOT NULL, 
	user_agent VARCHAR, 
	ip VARCHAR, 
	issued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	family_expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	used_at TIMESTAMP WITH TIME ZONE, 
	revoked_at TIMESTAMP WITH TIME ZONE, 
	revoked_reason VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT refresh_tokens_client_check CHECK (client IN ('web', 'extension')), 
	CONSTRAINT refresh_tokens_reason_check CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'logout_all', 'reuse_detected', 'password_change', 'account_deleted', 'expired')), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(parent_id) REFERENCES refresh_tokens (id) ON DELETE SET NULL, 
	UNIQUE (token_hash)
)
    """)

    op.execute("""
CREATE INDEX ix_refresh_tokens_expires_at ON refresh_tokens (expires_at)
    """)

    op.execute("""
CREATE INDEX ix_refresh_tokens_family_id ON refresh_tokens (family_id)
    """)

    op.execute("""
CREATE INDEX ix_refresh_tokens_user_id ON refresh_tokens (user_id)
    """)

    op.execute("""
CREATE TABLE support_tickets (
	id UUID NOT NULL, 
	reference VARCHAR NOT NULL, 
	user_id UUID, 
	email VARCHAR NOT NULL, 
	topic VARCHAR NOT NULL, 
	subject TEXT NOT NULL, 
	message TEXT NOT NULL, 
	diagnostics JSONB, 
	status VARCHAR NOT NULL, 
	reply TEXT, 
	replied_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT support_tickets_status_check CHECK (status IN ('open', 'answered', 'closed')), 
	UNIQUE (reference), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
)
    """)

    op.execute("""
CREATE INDEX ix_support_tickets_created_at ON support_tickets (created_at DESC)
    """)

    op.execute("""
CREATE INDEX ix_support_tickets_user_id ON support_tickets (user_id)
    """)

    op.execute("""
CREATE TABLE usage_tracking (
	id UUID NOT NULL, 
	fingerprint VARCHAR NOT NULL, 
	user_id UUID, 
	lifetime_requests INTEGER NOT NULL, 
	first_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	flagged_for_abuse BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (fingerprint), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
)
    """)

    op.execute("""
CREATE INDEX ix_usage_tracking_user_id ON usage_tracking (user_id)
    """)

    op.execute("""
CREATE TABLE feedback_log (
	id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	session_id UUID, 
	reaction VARCHAR, 
	note TEXT NOT NULL, 
	time_spent_seconds INTEGER, 
	read_progress INTEGER, 
	session_difficulty VARCHAR NOT NULL, 
	section_title TEXT, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(session_id) REFERENCES reading_sessions (id) ON DELETE SET NULL
)
    """)

    op.execute("""
CREATE INDEX ix_feedback_log_session_id ON feedback_log (session_id)
    """)

    op.execute("""
CREATE INDEX ix_feedback_log_user_id ON feedback_log (user_id)
    """)

def downgrade() -> None:
    # CASCADE because the auth tables reference users and each other; dropping
    # in reverse dependency order alone is not enough for the self-reference
    # on refresh_tokens.parent_id.
    op.execute("DROP TABLE IF EXISTS feedback_log CASCADE")
    op.execute("DROP TABLE IF EXISTS usage_tracking CASCADE")
    op.execute("DROP TABLE IF EXISTS support_tickets CASCADE")
    op.execute("DROP TABLE IF EXISTS refresh_tokens CASCADE")
    op.execute("DROP TABLE IF EXISTS reading_sessions CASCADE")
    op.execute("DROP TABLE IF EXISTS profile_history CASCADE")
    op.execute("DROP TABLE IF EXISTS email_tokens CASCADE")
    op.execute("DROP TABLE IF EXISTS cognitive_profiles CASCADE")
    op.execute("DROP TABLE IF EXISTS billing CASCADE")
    op.execute("DROP TABLE IF EXISTS users CASCADE")
