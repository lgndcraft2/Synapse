-- ================================================================
-- SYNAPSE DATABASE SCHEMA
-- PostgreSQL (Supabase)
-- ================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ────────────────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT UNIQUE NOT NULL,
    name            TEXT,
    avatar_url      TEXT,
    google_id       TEXT UNIQUE,           -- from Google OAuth
    supabase_uid    TEXT UNIQUE,           -- from Supabase Auth
    plan            TEXT NOT NULL DEFAULT 'free'
                    CHECK (plan IN ('free', 'premium', 'institutional')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── COGNITIVE PROFILES ───────────────────────────────────────────
CREATE TABLE cognitive_profiles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_type        TEXT NOT NULL DEFAULT 'load-reducer'
                        CHECK (profile_type IN ('load-reducer', 'comprehension-gap', 'hyperfocus')),
    preferred_format    TEXT NOT NULL DEFAULT 'bullet points',
    chunk_size          TEXT NOT NULL DEFAULT 'short'
                        CHECK (chunk_size IN ('short', 'medium', 'long')),
    needs_examples_first BOOLEAN NOT NULL DEFAULT TRUE,
    simplify_vocab      BOOLEAN NOT NULL DEFAULT FALSE,
    max_nesting_depth   INTEGER NOT NULL DEFAULT 2 CHECK (max_nesting_depth BETWEEN 1 AND 3),
    use_headers         BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)    -- one active profile per user
);

-- ── PROFILE HISTORY ──────────────────────────────────────────────
-- Every time Synapse auto-updates a profile, we log what changed
CREATE TABLE profile_history (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_summary  TEXT NOT NULL,         -- human-readable: "Shortened chunks due to low read depth"
    previous_state  JSONB NOT NULL,        -- full snapshot of profile before change
    new_state       JSONB NOT NULL         -- full snapshot after change
);

-- ── READING SESSIONS ─────────────────────────────────────────────
CREATE TABLE reading_sessions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_url            TEXT,
    page_title          TEXT,
    session_difficulty  TEXT DEFAULT 'normal'
                        CHECK (session_difficulty IN ('hard', 'normal', 'easy')),
    cards_generated     INTEGER NOT NULL DEFAULT 0,
    mode                TEXT DEFAULT 'cards'
                        CHECK (mode IN ('cards', 'fullpage', 'document')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── FEEDBACK LOG ─────────────────────────────────────────────────
CREATE TABLE feedback_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id          UUID REFERENCES reading_sessions(id) ON DELETE SET NULL,
    reaction            TEXT CHECK (reaction IN ('clearer', 'complex', 'simple', 'off-topic')),
    note                TEXT DEFAULT '',
    time_spent_seconds  INTEGER,
    read_progress       INTEGER CHECK (read_progress BETWEEN 0 AND 100),
    session_difficulty  TEXT DEFAULT 'normal',
    section_title       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── BILLING ──────────────────────────────────────────────────────
CREATE TABLE billing (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id      TEXT UNIQUE,
    stripe_subscription_id  TEXT UNIQUE,
    plan                    TEXT NOT NULL DEFAULT 'free'
                            CHECK (plan IN ('free', 'premium', 'institutional')),
    billing_period          TEXT DEFAULT 'monthly'
                            CHECK (billing_period IN ('monthly', 'annual')),
    status                  TEXT DEFAULT 'active'
                            CHECK (status IN ('active', 'cancelled', 'past_due', 'trialing')),
    trial_ends_at           TIMESTAMPTZ,
    renews_at               TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)
);

-- ── RATE LIMITING (fallback — primary is Redis) ───────────────────
-- Used for lifetime limit tracking and abuse detection
CREATE TABLE usage_tracking (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fingerprint         TEXT NOT NULL,     -- SHA-256 hash of device signals
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    lifetime_requests   INTEGER NOT NULL DEFAULT 0,
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    flagged_for_abuse   BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (fingerprint)
);

-- ── INDEXES ──────────────────────────────────────────────────────
CREATE INDEX idx_feedback_user_id ON feedback_log(user_id);
CREATE INDEX idx_feedback_created_at ON feedback_log(created_at DESC);
CREATE INDEX idx_sessions_user_id ON reading_sessions(user_id);
CREATE INDEX idx_sessions_created_at ON reading_sessions(created_at DESC);
CREATE INDEX idx_profile_history_user_id ON profile_history(user_id);
CREATE INDEX idx_usage_fingerprint ON usage_tracking(fingerprint);

-- ── AUTO-UPDATE updated_at ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON cognitive_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER billing_updated_at
    BEFORE UPDATE ON billing
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
