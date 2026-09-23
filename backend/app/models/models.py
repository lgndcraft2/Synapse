import uuid
from datetime import datetime
from sqlalchemy import (
    String, Boolean, Integer, Text, ForeignKey, DateTime,
    CheckConstraint, Index, func, desc,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID, JSONB
from app.core.config import settings
from app.db.database import Base


class User(Base):
    __tablename__ = "users"

    id:           Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email:        Mapped[str]       = mapped_column(String, unique=True, nullable=False)
    name:         Mapped[str]       = mapped_column(String, nullable=True)
    avatar_url:   Mapped[str]       = mapped_column(String, nullable=True)
    # Google's `sub` claim — stable for the life of the account, unlike email.
    # Declared since the first commit but unused until first-party OAuth landed.
    google_id:    Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    plan:         Mapped[str]       = mapped_column(String, default="free")

    # NULL means the account has no password and signs in with Google only.
    # verify_password() still pays for a full Argon2 verify in that case, so
    # login cannot leak which kind of account this is.
    password_hash:       Mapped[str]      = mapped_column(String, nullable=True)
    email_verified:      Mapped[bool]     = mapped_column(Boolean, default=False, nullable=False, server_default="false")
    email_verified_at:   Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    # Access tokens issued before this instant are rejected by get_current_user.
    # Paired with revoking every refresh family, this is what makes "change your
    # password and everything signs out" true without a token blacklist.
    password_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login_at:       Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())
    updated_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())

    __table_args__ = (
        # Mirrors the constraint that already exists in the database but was
        # never declared here, so autogenerate stops trying to drop it.
        CheckConstraint(
            "plan IN ('free', 'lite', 'premium', 'institutional')",
            name="users_plan_check",
        ),
        # Email is the login identity, so uniqueness has to survive casing.
        # Writers normalise to lowercase; this index is what catches the writer
        # somebody forgets.
        Index("ix_users_email_lower", func.lower(email), unique=True),
    )

    @property
    def auth_provider(self) -> str:
        """
        How this account signs in — replaces Supabase's app_metadata.provider.

        Note "both" is reachable: a password account that later links Google.
        The UI must not assume two states.
        """
        if self.google_id and self.password_hash:
            return "both"
        if self.google_id:
            return "google"
        return "password"

    @property
    def is_observer(self) -> bool:
        """Whether this account may view the internal aggregate observer."""
        return self.email.lower() in settings.admin_emails

    profile:         Mapped["CognitiveProfile"]  = relationship("CognitiveProfile", back_populates="user", uselist=False)
    profile_history: Mapped[list["ProfileHistory"]] = relationship("ProfileHistory", back_populates="user")
    sessions:        Mapped[list["ReadingSession"]]  = relationship("ReadingSession", back_populates="user")
    feedback:        Mapped[list["FeedbackLog"]]     = relationship("FeedbackLog", back_populates="user")
    billing:         Mapped["Billing"]               = relationship("Billing", back_populates="user", uselist=False)


class CognitiveProfile(Base):
    __tablename__ = "cognitive_profiles"

    id:                   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:              Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    profile_type:         Mapped[str]       = mapped_column(String, default="load-reducer")
    preferred_format:     Mapped[str]       = mapped_column(String, default="bullet points")
    chunk_size:           Mapped[str]       = mapped_column(String, default="short")
    needs_examples_first: Mapped[bool]      = mapped_column(Boolean, default=True)
    simplify_vocab:       Mapped[bool]      = mapped_column(Boolean, default=False)
    max_nesting_depth:    Mapped[int]       = mapped_column(Integer, default=2)
    use_headers:          Mapped[bool]      = mapped_column(Boolean, default=True)
    notes:                Mapped[str]       = mapped_column(Text, default="")
    created_at:           Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at:           Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user: Mapped["User"] = relationship("User", back_populates="profile")


class ProfileHistory(Base):
    __tablename__ = "profile_history"

    id:             Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:        Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    changed_at:     Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    change_summary: Mapped[str]       = mapped_column(Text, nullable=False)
    previous_state: Mapped[dict]      = mapped_column(JSONB, nullable=False)
    new_state:      Mapped[dict]      = mapped_column(JSONB, nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="profile_history")

    __table_args__ = (
        # The paged history endpoint filters by user and sorts newest-first.
        # Postgres does not index foreign keys automatically, so without this
        # every page is a sequential scan plus a sort.
        Index("ix_profile_history_user_changed", "user_id", desc("changed_at")),
    )


class ReadingSession(Base):
    __tablename__ = "reading_sessions"

    id:                 Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:            Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    page_url:           Mapped[str]       = mapped_column(Text, nullable=True)
    page_title:         Mapped[str]       = mapped_column(Text, nullable=True)
    session_difficulty: Mapped[str]       = mapped_column(String, default="normal")
    cards_generated:    Mapped[int]       = mapped_column(Integer, default=0)
    mode:               Mapped[str]       = mapped_column(String, default="cards")
    created_at:         Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user:     Mapped["User"]           = relationship("User", back_populates="sessions")
    feedback: Mapped[list["FeedbackLog"]] = relationship("FeedbackLog", back_populates="session")

    __table_args__ = (
        # Serves both shapes this table is queried in: the paged session list
        # (user + newest-first) and the dashboard's date-range aggregates.
        Index("ix_reading_sessions_user_created", "user_id", desc("created_at")),
    )


class FeedbackLog(Base):
    __tablename__ = "feedback_log"

    id:                  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:             Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    session_id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("reading_sessions.id", ondelete="SET NULL"), nullable=True)
    reaction:            Mapped[str]       = mapped_column(String, nullable=True)
    note:                Mapped[str]       = mapped_column(Text, default="")
    time_spent_seconds:  Mapped[int]       = mapped_column(Integer, nullable=True)
    read_progress:       Mapped[int]       = mapped_column(Integer, nullable=True)
    session_difficulty:  Mapped[str]       = mapped_column(String, default="normal")
    section_title:       Mapped[str]       = mapped_column(Text, nullable=True)
    created_at:          Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user:    Mapped["User"]           = relationship("User", back_populates="feedback")
    session: Mapped["ReadingSession"] = relationship("ReadingSession", back_populates="feedback")

    __table_args__ = (
        # The dashboard's reaction breakdown groups this table by user.
        Index("ix_feedback_log_user_id", "user_id"),
        # ON DELETE SET NULL has to find the children when a session goes, and
        # an unindexed FK makes that a full scan per delete.
        Index("ix_feedback_log_session_id", "session_id"),
    )


class Billing(Base):
    __tablename__ = "billing"

    id:                     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:                Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    stripe_customer_id:     Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    stripe_subscription_id: Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    plan:                   Mapped[str]       = mapped_column(String, default="free")
    billing_period:         Mapped[str]       = mapped_column(String, default="monthly")
    status:                 Mapped[str]       = mapped_column(String, default="active")
    # Mirrors Stripe's subscription.cancel_at_period_end. Lets the UI say
    # "cancels on X" rather than "renews on X" without querying Stripe.
    cancel_at_period_end:   Mapped[bool]      = mapped_column(Boolean, default=False, nullable=False, server_default="false")
    trial_ends_at:          Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    renews_at:              Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at:           Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    created_at:             Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at:             Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user: Mapped["User"] = relationship("User", back_populates="billing")


class UsageTracking(Base):
    __tablename__ = "usage_tracking"

    id:                Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    fingerprint:       Mapped[str]       = mapped_column(String, unique=True, nullable=False)
    user_id:           Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    lifetime_requests: Mapped[int]       = mapped_column(Integer, default=0)
    first_seen:        Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    last_seen:         Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    flagged_for_abuse: Mapped[bool]      = mapped_column(Boolean, default=False)

    __table_args__ = (
        # Account deletion nulls these rows by design (abuse counters outlive
        # the account), which needs the FK indexed to avoid a scan per delete.
        Index("ix_usage_tracking_user_id", "user_id"),
    )


class SupportTicket(Base):
    """A ticket filed from the /support page.

    Anonymous submissions are allowed (user_id is nullable) so that somebody
    whose sign-in is broken can still reach support; `email` is what makes the
    ticket answerable either way.
    """
    __tablename__ = "support_tickets"

    id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reference:   Mapped[str]       = mapped_column(String, unique=True, nullable=False)
    user_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    email:       Mapped[str]       = mapped_column(String, nullable=False)
    topic:       Mapped[str]       = mapped_column(String, nullable=False)
    subject:     Mapped[str]       = mapped_column(Text, nullable=False)
    message:     Mapped[str]       = mapped_column(Text, nullable=False)
    # Plan, profile, extension and browser at submission time — optional, the
    # user can decline to attach it.
    #
    # none_as_null=True matters: SQLAlchemy's JSON type otherwise persists
    # Python None as the JSON value 'null', so a declined attachment would
    # still satisfy "diagnostics IS NOT NULL" and read as present.
    diagnostics: Mapped[dict]      = mapped_column(JSONB(none_as_null=True), nullable=True)
    status:      Mapped[str]       = mapped_column(String, default="open", nullable=False)
    reply:       Mapped[str]       = mapped_column(Text, nullable=True)
    replied_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())
    updated_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "status IN ('open', 'answered', 'closed')",
            name="support_tickets_status_check",
        ),
        # These two existed in migrations/0003_add_support_tickets.sql but were
        # never declared on the model. Generating the new baseline from the ORM
        # therefore dropped them — exactly the drift a pg_dump baseline would
        # have caught.
        Index("ix_support_tickets_user_id", "user_id"),
        Index("ix_support_tickets_created_at", desc("created_at")),
    )


class RefreshToken(Base):
    """
    One row per issued refresh token.

    Tokens rotate on every use: presenting one marks it used and returns a
    successor in the same `family_id`. Presenting an already-used token means
    two parties hold the same secret, so the whole family is revoked — the
    thief and the victim are both logged out, which is the correct outcome
    when we cannot tell which is which.

    `client` keeps the dashboard and the browser extension in *separate*
    families. Without that split, the two refreshing independently would look
    exactly like the theft case and sign users out constantly.
    """
    __tablename__ = "refresh_tokens"

    id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    family_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    parent_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("refresh_tokens.id", ondelete="SET NULL"), nullable=True)

    # SHA-256 hex of the raw token. Never store the raw value: a database leak
    # would otherwise be a fleet-wide session hijack.
    token_hash: Mapped[str]       = mapped_column(String(64), unique=True, nullable=False)
    client:     Mapped[str]       = mapped_column(String, nullable=False, default="web", server_default="web")

    user_agent: Mapped[str]       = mapped_column(String, nullable=True)
    ip:         Mapped[str]       = mapped_column(String, nullable=True)

    issued_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())
    # Sliding: each rotation extends this.
    expires_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    # Absolute ceiling, copied unchanged down the family. Without it a token
    # that is used regularly never dies.
    family_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    used_at:    Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_reason: Mapped[str]   = mapped_column(String, nullable=True)

    __table_args__ = (
        CheckConstraint("client IN ('web', 'extension')", name="refresh_tokens_client_check"),
        CheckConstraint(
            "revoked_reason IS NULL OR revoked_reason IN "
            "('logout', 'logout_all', 'reuse_detected', 'password_change', "
            "'account_deleted', 'expired')",
            name="refresh_tokens_reason_check",
        ),
    )


class EmailToken(Base):
    """
    Single-use tokens emailed to the user: address verification and password
    reset. One table because the lifecycle is identical; `purpose` discriminates.

    Single use is enforced by `used_at`, not by deletion, so an expired or
    already-spent link can be told apart from one that never existed — the
    difference between a useful error message and a confused support ticket.
    """
    __tablename__ = "email_tokens"

    id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    purpose:    Mapped[str]       = mapped_column(String, nullable=False)
    token_hash: Mapped[str]       = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False)
    used_at:    Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "purpose IN ('email_verify', 'password_reset')",
            name="email_tokens_purpose_check",
        ),
    )
