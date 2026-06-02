from pydantic import BaseModel, EmailStr
from typing import Optional, Literal
from datetime import datetime
import uuid


# ── Auth ─────────────────────────────────────────────────────────

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: Optional[str]
    avatar_url: Optional[str]
    plan: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Cognitive Profile ─────────────────────────────────────────────

class ProfileOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    profile_type: str
    preferred_format: str
    chunk_size: str
    needs_examples_first: bool
    simplify_vocab: bool
    max_nesting_depth: int
    use_headers: bool
    notes: str
    updated_at: datetime

    class Config:
        from_attributes = True


class ProfileUpdate(BaseModel):
    profile_type: Optional[Literal["load-reducer", "comprehension-gap", "hyperfocus"]] = None
    preferred_format: Optional[Literal["bullet points", "short paragraphs", "numbered steps", "plain flowing prose"]] = None
    chunk_size: Optional[Literal["short", "medium", "long"]] = None
    needs_examples_first: Optional[bool] = None
    simplify_vocab: Optional[bool] = None
    max_nesting_depth: Optional[int] = None
    use_headers: Optional[bool] = None
    notes: Optional[str] = None


# ── Reformat ─────────────────────────────────────────────────────

class ReformatRequest(BaseModel):
    page_text: str
    page_url: Optional[str] = None
    page_title: Optional[str] = None
    session_difficulty: Literal["hard", "normal", "easy"] = "normal"
    mode: Literal["cards", "fullpage", "document"] = "cards"
    fingerprint: Optional[str] = None   # for anonymous/free users


class ReformatResponse(BaseModel):
    html: str
    questions: Optional[list[str]] = None   # SQ4R questions
    model_used: str                          # "gemini-flash" or "claude-sonnet"


# ── Feedback ─────────────────────────────────────────────────────

class FeedbackEntry(BaseModel):
    session_id: Optional[uuid.UUID] = None
    reaction: Optional[Literal["clearer", "complex", "simple", "off-topic"]] = None
    note: Optional[str] = ""
    time_spent_seconds: Optional[int] = None
    read_progress: Optional[int] = None
    session_difficulty: str = "normal"
    section_title: Optional[str] = None


class FeedbackBatch(BaseModel):
    """Extension sends the last N interactions in one batch."""
    entries: list[FeedbackEntry]
    fingerprint: Optional[str] = None


# ── Sessions ─────────────────────────────────────────────────────

class SessionOut(BaseModel):
    id: uuid.UUID
    page_url: Optional[str]
    page_title: Optional[str]
    session_difficulty: str
    cards_generated: int
    mode: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Billing ──────────────────────────────────────────────────────

class BillingOut(BaseModel):
    plan: str
    status: str
    billing_period: Optional[str]
    trial_ends_at: Optional[datetime]
    renews_at: Optional[datetime]
    stripe_customer_id: Optional[str]

    class Config:
        from_attributes = True


class CheckoutRequest(BaseModel):
    price_id: str
    success_url: str
    cancel_url: str


class CheckoutResponse(BaseModel):
    checkout_url: str


# ── Dashboard stats ───────────────────────────────────────────────

class DashboardStats(BaseModel):
    cards_this_week: int
    cards_this_month: int
    pages_visited: int
    words_processed: int
    time_saved_minutes: int
    recent_sessions: list[SessionOut]
    feedback_breakdown: dict[str, int]
