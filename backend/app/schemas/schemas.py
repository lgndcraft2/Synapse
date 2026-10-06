from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from typing import Generic, Optional, Literal, TypeVar
from datetime import datetime
import uuid

from app.core.avatars import AVATAR_IDS


# ── Pagination ────────────────────────────────────────────────────

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """One page of a list endpoint.

    `total` is None for sources that cannot count cheaply — Stripe's list API
    is cursor-paginated and reports no total — so clients must treat it as
    optional and fall back to "Page N" instead of "Page N of M".
    `next_cursor` is likewise only set by cursor-paginated sources.
    """
    data: list[T]
    total: Optional[int] = None
    has_more: bool = False
    next_cursor: Optional[str] = None


# ── Auth ─────────────────────────────────────────────────────────

class TokenResponse(BaseModel):
    """What every successful authentication returns.

    `user` is inlined so the client never needs a follow-up /auth/me round
    trip, and so the token and the rendered account can never disagree.
    `expires_at` is absolute unix seconds because that is what the browser
    extension stores and compares against; `expires_in` is included for
    clients that would rather not trust their own clock.
    """
    access_token: str
    token_type: str = "bearer"
    refresh_token: str
    expires_at: int
    expires_in: int
    user: "UserOut"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: Optional[str]
    avatar_url: Optional[str]
    plan: str
    created_at: datetime
    # Replaces Supabase's app_metadata.provider. Note "both" is reachable —
    # a password account that later links Google — so clients must not treat
    # this as a two-state flag.
    auth_provider: Literal["password", "google", "both"] = "password"
    email_verified: bool = False
    is_observer: bool = False

    class Config:
        from_attributes = True


# ── Auth request bodies ──────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    # 10 is a deliberate step up from the 6 Supabase enforced. The ceiling
    # exists because Argon2 hashes whatever it is given, and a megabyte of
    # "password" is a free denial-of-service otherwise.
    password: str = Field(min_length=10, max_length=128)
    name: Optional[str] = Field(default=None, max_length=80)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=512)


class LogoutRequest(BaseModel):
    refresh_token: Optional[str] = Field(default=None, max_length=512)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=10, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


class UpdateMeRequest(BaseModel):
    """Update a display name and/or choose a first-party avatar.

    Only an allow-listed avatar id is accepted.  The client never sends an
    image URL or file, so users cannot use this endpoint to host arbitrary
    images or make other clients load a tracking URL.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    avatar_id: Optional[str] = Field(default=None, min_length=1, max_length=32)

    @field_validator("avatar_id")
    @classmethod
    def avatar_must_be_from_catalogue(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in AVATAR_IDS:
            raise ValueError("Choose an avatar from the available collection.")
        return value

    @model_validator(mode="after")
    def requires_a_change(self):
        if self.name is None and self.avatar_id is None:
            raise ValueError("Provide a display name or avatar selection.")
        return self


class OAuthExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=512)


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


# ── Feedback entry ───────────────────────────────────────────────
# Defined ahead of the request models: anonymous callers send their local
# feedback log inline as `recent_feedback`, since they have no server log.

class FeedbackEntry(BaseModel):
    session_id: Optional[uuid.UUID] = None
    reaction: Optional[Literal["clearer", "complex", "simple", "off-topic"]] = None
    note: Optional[str] = Field("", max_length=500)
    time_spent_seconds: Optional[int] = Field(None, ge=0, le=86400)
    read_progress: Optional[int] = Field(None, ge=0, le=100)
    session_difficulty: str = "normal"
    section_title: Optional[str] = Field(None, max_length=200)


# ── Reformat ─────────────────────────────────────────────────────

class ReformatRequest(BaseModel):
    page_text: str = Field(..., max_length=500000)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    session_difficulty: Literal["hard", "normal", "easy"] = "normal"
    mode: Literal["cards", "fullpage", "document"] = "cards"
    fingerprint: Optional[str] = Field(None, max_length=100)   # for anonymous/free users
    profile: Optional[CognitiveProfileSchema] = None
    # Anonymous callers only; ignored when signed in (the server log wins).
    recent_feedback: Optional[list[FeedbackEntry]] = Field(None, max_length=20)


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
    # Anonymous callers only; ignored when signed in (the server log wins).
    recent_feedback: Optional[list[FeedbackEntry]] = Field(None, max_length=20)


# ── Explain ──────────────────────────────────────────────────────

def _cap_text(value: Optional[str], limit: int) -> Optional[str]:
    """Trim and truncate a context string; blank becomes None."""
    if value is None:
        return None
    value = value.strip()[:limit].strip()
    return value or None


def _cap_list(values: Optional[list[str]], max_items: int, item_limit: int) -> list[str]:
    """Trim and truncate each item, drop blanks, keep the first `max_items`."""
    capped = [_cap_text(v, item_limit) for v in (values or [])]
    return [v for v in capped if v][:max_items]


class ExplainContextForm(BaseModel):
    """The form an explained control sits in: its heading and field names."""
    heading: Optional[str] = None
    fields: list[str] = Field(default_factory=list)

    @field_validator("heading")
    @classmethod
    def _cap_heading(cls, v):
        return _cap_text(v, 300)

    @field_validator("fields", mode="before")
    @classmethod
    def _none_fields(cls, v):
        return v or []

    @field_validator("fields")
    @classmethod
    def _cap_fields(cls, v):
        return _cap_list(v, 20, 300)


class ExplainContextElement(BaseModel):
    """Accessible description of the button, link or input that was explained."""
    tag: Optional[str] = None
    role: Optional[str] = None
    name: Optional[str] = None
    aria_label: Optional[str] = None
    title: Optional[str] = None
    label: Optional[str] = None
    href: Optional[str] = None
    form: Optional[ExplainContextForm] = None
    container: Optional[str] = None

    @field_validator("tag", "role", "name", "aria_label", "title", "label", "href", "container")
    @classmethod
    def _cap_strings(cls, v):
        return _cap_text(v, 300)


class ExplainLocalContext(BaseModel):
    heading_path: list[str] = Field(default_factory=list)
    surrounding_text: Optional[str] = None
    element: Optional[ExplainContextElement] = None

    @field_validator("heading_path", mode="before")
    @classmethod
    def _none_path(cls, v):
        return v or []

    @field_validator("heading_path")
    @classmethod
    def _cap_path(cls, v):
        return _cap_list(v, 8, 200)

    @field_validator("surrounding_text")
    @classmethod
    def _cap_surrounding(cls, v):
        return _cap_text(v, 2_000)


class ExplainPageContext(BaseModel):
    # title / site_name / description have no cap in the contract; these keep
    # them proportionate to the other fields.
    title: Optional[str] = None
    site_name: Optional[str] = None
    description: Optional[str] = None
    outline: list[str] = Field(default_factory=list)
    main_text: Optional[str] = None

    @field_validator("title")
    @classmethod
    def _cap_title(cls, v):
        return _cap_text(v, 300)

    @field_validator("site_name")
    @classmethod
    def _cap_site(cls, v):
        return _cap_text(v, 200)

    @field_validator("description")
    @classmethod
    def _cap_description(cls, v):
        return _cap_text(v, 1_000)

    @field_validator("outline", mode="before")
    @classmethod
    def _none_outline(cls, v):
        return v or []

    @field_validator("outline")
    @classmethod
    def _cap_outline(cls, v):
        return _cap_list(v, 40, 200)

    @field_validator("main_text")
    @classmethod
    def _cap_main(cls, v):
        return _cap_text(v, 8_000)

    def has_content(self) -> bool:
        return bool(self.title or self.site_name or self.description or self.outline or self.main_text)


class ExplainContext(BaseModel):
    """Where the selection sits. Every string is trimmed and capped here, so
    over-long fields are truncated rather than rejected; only the serialized
    total (24 KB, checked in the route) is a hard error."""
    local: Optional[ExplainLocalContext] = None
    page: Optional[ExplainPageContext] = None


class ExplainRequest(BaseModel):
    """A highlighted passage (`kind="text"`) or a circled area (`"image"`).

    Only shapes and hard ceilings are checked here. The cross-field rules
    (kind vs image, decoded sizes, media type) are checked in the route so they
    can answer 400 INVALID_REQUEST, which the extension branches on, rather
    than a generic 422.
    """
    kind: Literal["text", "image"]
    text: Optional[str] = Field(None, max_length=500000)
    # Raw base64, no data: prefix. The real 4 MB decoded cap is enforced in the
    # route; this ceiling only keeps absurd bodies out of the validator.
    image_base64: Optional[str] = Field(None, max_length=8_000_000)
    image_media_type: Optional[str] = Field(None, max_length=50)
    thumbnail_base64: Optional[str] = Field(None, max_length=400_000)
    anchor: Optional[dict] = None
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    session_difficulty: Literal["hard", "normal", "easy"] = "normal"
    fingerprint: Optional[str] = Field(None, max_length=100)
    profile: Optional[CognitiveProfileSchema] = None
    # Anonymous callers only; ignored when signed in (the server log wins).
    recent_feedback: Optional[list[FeedbackEntry]] = Field(None, max_length=20)
    context: Optional[ExplainContext] = None
    # From POST /explain/context. Format is checked in the route so that a
    # malformed id answers 400 CONTEXT_EXPIRED like any other unusable one.
    context_id: Optional[str] = Field(None, max_length=200)


class ExplainContextUploadRequest(BaseModel):
    """A document to keep as context for later explains.

    Exactly one of `document_base64` (PDF) or `document_text` is required. The
    real limits (20 MB decoded, 2,000,000 chars) are enforced in the route so
    they answer 400 INVALID_REQUEST; these ceilings only keep absurd bodies out
    of the validator.
    """
    media_type: str = Field(..., max_length=100)
    document_base64: Optional[str] = Field(None, max_length=30_000_000)
    document_text: Optional[str] = Field(None, max_length=4_000_000)
    source_url: Optional[str] = Field(None, max_length=2000)
    fingerprint: Optional[str] = Field(None, max_length=100)


class ExplainContextUploadResponse(BaseModel):
    context_id: str
    chars: int
    truncated: bool
    expires_in: int


class ExplainUsage(BaseModel):
    """Image-capture quota after this request. Limit and period are null for
    unlimited plans; `image_captures_used` is null if the counter was
    unavailable and the request was allowed uncounted."""
    image_captures_used: Optional[int]
    image_captures_limit: Optional[int]
    image_period: Optional[Literal["day", "month"]]


class ExplanationHistoryOut(BaseModel):
    id: uuid.UUID
    hostname: str
    url: Optional[str]
    page_title: Optional[str]
    kind: Literal["text", "image"]
    source_text: Optional[str]
    anchor: dict
    result_html: str
    thumbnail_url: Optional[str] = None
    created_at: datetime


class ExplainResponse(BaseModel):
    html: str
    kind: Literal["text", "image"]
    model_used: str
    history_entry: Optional[ExplanationHistoryOut] = None
    usage: Optional[ExplainUsage] = None


class ExplanationHistoryPage(BaseModel):
    entries: list[ExplanationHistoryOut]
    next_before: Optional[datetime] = None


class ExplanationHistoryDeleted(BaseModel):
    deleted: int


# ── Feedback ─────────────────────────────────────────────────────

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
