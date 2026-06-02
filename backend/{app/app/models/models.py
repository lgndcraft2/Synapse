import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, Integer, Text, ForeignKey, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base


class User(Base):
    __tablename__ = "users"

    id:           Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email:        Mapped[str]       = mapped_column(String, unique=True, nullable=False)
    name:         Mapped[str]       = mapped_column(String, nullable=True)
    avatar_url:   Mapped[str]       = mapped_column(String, nullable=True)
    google_id:    Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    supabase_uid: Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    plan:         Mapped[str]       = mapped_column(String, default="free")
    created_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

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
    previous_state: Mapped[dict]      = mapped_column(JSON, nullable=False)
    new_state:      Mapped[dict]      = mapped_column(JSON, nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="profile_history")


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


class Billing(Base):
    __tablename__ = "billing"

    id:                     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:                Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    stripe_customer_id:     Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    stripe_subscription_id: Mapped[str]       = mapped_column(String, unique=True, nullable=True)
    plan:                   Mapped[str]       = mapped_column(String, default="free")
    billing_period:         Mapped[str]       = mapped_column(String, default="monthly")
    status:                 Mapped[str]       = mapped_column(String, default="active")
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
