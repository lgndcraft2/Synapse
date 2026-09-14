from pydantic import BaseModel, EmailStr, Field
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
    max_nesting_depth: Optional[int] = Field(None, ge=1, le=3)
    use_headers: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=1000)


class CognitiveProfileSchema(BaseModel):
    profile_type: Literal["load-reducer", "comprehension-gap", "hyperfocus"] = "load-reducer"
    preferred_format: str = "bullet points"
    chunk_size: Literal["short", "medium", "long"] = "short"
    needs_examples_first: bool = True
    simplify_vocab: bool = False
    max_nesting_depth: int = Field(2, ge=1, le=3)
    use_headers: bool = True
    notes: str = Field("", max_length=1000)


# ── Reformat ─────────────────────────────────────────────────────

class ReformatRequest(BaseModel):
    page_text: str = Field(..., max_length=500000)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    session_difficulty: Literal["hard", "normal", "easy"] = "normal"
    mode: Literal["cards", "fullpage", "document"] = "cards"
    fingerprint: Optional[str] = Field(None, max_length=100)   # for anonymous/free users
    profile: Optional[CognitiveProfileSchema] = None


class ReformatResponse(BaseModel):
    html: str
    questions: Optional[list[str]] = None   # SQ4R questions
    model_used: str                          # "gemini-flash" or "claude-sonnet"


# ── Section Analysis ────────────────────────────────────────────

class AnalyseSectionsRequest(BaseModel):
    page_text: str = Field(..., max_length=500000)
    fingerprint: Optional[str] = Field(None, max_length=100)
    profile: Optional[CognitiveProfileSchema] = None


class SectionInfo(BaseModel):
    title: str
    content: str
    summary: str


class AnalyseSectionsResponse(BaseModel):
    sections: list[SectionInfo]


# ── Document Reformat ───────────────────────────────────────────

class DocumentReformatRequest(BaseModel):
    base64_data: str = Field(..., max_length=15000000) # ~11MB binary
    media_type: Literal["application/pdf", "text/plain", "text/csv", "text/markdown"]
    session_difficulty: Literal["hard", "normal", "easy"] = "normal"
    fingerprint: Optional[str] = Field(None, max_length=100)
    profile: Optional[CognitiveProfileSchema] = None


# ── Feedback ─────────────────────────────────────────────────────

class FeedbackEntry(BaseModel):
    session_id: Optional[uuid.UUID] = None
    reaction: Optional[Literal["clearer", "complex", "simple", "off-topic"]] = None
    note: Optional[str] = Field("", max_length=500)
    time_spent_seconds: Optional[int] = Field(None, ge=0, le=86400)
    read_progress: Optional[int] = Field(None, ge=0, le=100)
    session_difficulty: str = "normal"
    section_title: Optional[str] = Field(None, max_length=200)


class FeedbackBatch(BaseModel):
    """Extension sends the last N interactions in one batch."""
    entries: list[FeedbackEntry] = Field(..., max_items=50)
    fingerprint: Optional[str] = Field(None, max_length=100)


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
    # True once the user has cancelled but still has paid-for time remaining.
    # renews_at then means "access ends on", not "you will be charged on".
    cancel_at_period_end: bool = False
    trial_ends_at: Optional[datetime]
    renews_at: Optional[datetime]
    cancelled_at: Optional[datetime] = None
    stripe_customer_id: Optional[str]
    # Present only when there is a live Stripe subscription to act on, so the
    # UI knows whether cancel / resume / change-plan are available at all.
    stripe_subscription_id: Optional[str] = None

    class Config:
        from_attributes = True


class ChangePlanRequest(BaseModel):
    price_id: str


class InvoiceOut(BaseModel):
    """One past invoice, straight from Stripe."""
    id: str
    number: Optional[str] = None
    created: datetime
    amount_paid: int          # in the currency's smallest unit (cents)
    amount_due: int
    currency: str
    status: Optional[str]     # paid | open | void | uncollectible | draft
    description: Optional[str] = None
    hosted_invoice_url: Optional[str] = None
    invoice_pdf: Optional[str] = None


class PaymentMethodOut(BaseModel):
    """The card on file. Card data never touches our servers — Stripe returns
    only these display-safe fields."""
    brand: Optional[str] = None
    last4: Optional[str] = None
    exp_month: Optional[int] = None
    exp_year: Optional[int] = None


class UsageOut(BaseModel):
    """Quota consumed against the caller's current tier.

    Mirrors what app/services/rate_limit.py actually enforces, so the meter on
    the billing screen can never disagree with the 429 the API would return.
    """
    plan: str
    unlimited: bool
    # "monthly" (Thinker Lite), "daily" (free tier), or "none" when unlimited.
    limit_type: str
    used: int
    limit: Optional[int]
    remaining: Optional[int]
    resets_at: Optional[datetime]
    # The free tier also carries a hard lifetime cap alongside the daily one.
    lifetime_used: Optional[int] = None
    lifetime_limit: Optional[int] = None


class CheckoutRequest(BaseModel):
    price_id: str
    # Redirect URLs are server-owned (see billing.create_checkout) to prevent
    # open redirects; accepted here only for backward compatibility and ignored.
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class CheckoutResponse(BaseModel):
    checkout_url: str


class CheckoutConfirmRequest(BaseModel):
    session_id: str


# ── Dashboard stats ───────────────────────────────────────────────

class DashboardStats(BaseModel):
    cards_this_week: int
    cards_this_month: int
    pages_visited: int
    words_processed: int
    time_saved_minutes: int
    recent_sessions: list[SessionOut]
    feedback_breakdown: dict[str, int]


# ── Support ───────────────────────────────────────────────────────

SupportTopic = Literal[
    "billing", "extension", "account", "profile", "accessibility", "other"
]


class SupportTicketCreate(BaseModel):
    topic: SupportTopic
    subject: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=5000)
    # Required only for anonymous submissions — the route falls back to the
    # authenticated user's address when a token is present.
    email: Optional[EmailStr] = None
    # Plan / profile / extension / browser snapshot. The user can decline to
    # send it, in which case this stays null.
    diagnostics: Optional[dict] = None


class SupportTicketOut(BaseModel):
    id: uuid.UUID
    reference: str
    topic: str
    subject: str
    message: str
    email: str
    status: str
    reply: Optional[str] = None
    replied_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True
