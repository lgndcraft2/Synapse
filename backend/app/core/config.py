from pydantic import field_validator
from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str
    # Alembic only. DDL and advisory locks are unreliable over a transaction-mode
    # pooler, so migrations may need the direct endpoint even when the app uses
    # the pooled one. Blank falls back to DATABASE_URL.
    MIGRATION_DATABASE_URL: str = ""

    # ── First-party auth ──────────────────────────────────────────
    # Tokens are signed with APP_SECRET_KEY (declared further down). Access
    # tokens are short-lived and stateless; refresh tokens are opaque, stored
    # hashed, and rotate on every use.
    ACCESS_TOKEN_TTL_SECONDS: int = 15 * 60
    REFRESH_TOKEN_TTL_SECONDS: int = 30 * 24 * 3600
    # Absolute ceiling on a rotation family. Without it a sliding refresh token
    # never dies.
    REFRESH_FAMILY_TTL_SECONDS: int = 180 * 24 * 3600
    JWT_ISSUER: str = "synapse"
    JWT_AUDIENCE: str = "synapse-api"

    EMAIL_VERIFY_TTL_SECONDS: int = 24 * 3600
    PASSWORD_RESET_TTL_SECONDS: int = 3600

    # Google OAuth (first-party). GOOGLE_REDIRECT_URI must match the value
    # registered in the Cloud Console byte-for-byte, including scheme and path.
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = ""

    # How many proxies sit in front of the app. request.client.host is the edge's
    # address behind Render, which would collapse every user into one rate-limit
    # bucket; 0 means "trust request.client.host directly" (local dev).
    TRUSTED_PROXY_COUNT: int = 0

    # Redis. Accepts either Upstash REST credentials (https:// URL + REST
    # token) or a native redis:// / rediss:// connection string.
    UPSTASH_REDIS_URL: str
    UPSTASH_REDIS_TOKEN: str

    # Comma-separated email addresses permitted to view the internal observer
    # panel. Keeping this outside the database means granting access does not
    # require a schema migration or expose an admin role to regular clients.
    ADMIN_EMAILS: str = ""

    # AI — free tier Gemini pool
    GEMINI_KEY_1: str
    GEMINI_KEY_2: str
    GEMINI_KEY_3: str
    GEMINI_KEY_4: str = ""
    GEMINI_KEY_5: str = ""

    # AI — premium Claude
    ANTHROPIC_API_KEY: str

    # Observer cost estimates. Set these to the contracted USD price per one
    # million tokens for the exact models in use. They default to zero so the
    # dashboard never presents a guessed price as a financial fact.
    GEMINI_INPUT_USD_PER_MILLION: float = 0.0
    GEMINI_OUTPUT_USD_PER_MILLION: float = 0.0
    CLAUDE_INPUT_USD_PER_MILLION: float = 0.0
    CLAUDE_OUTPUT_USD_PER_MILLION: float = 0.0

    # Stripe — paid tier price IDs (must match the frontend VITE_STRIPE_* values)
    STRIPE_SECRET_KEY: str
    STRIPE_WEBHOOK_SECRET: str
    STRIPE_THINKER_LITE_PRICE_ID: str = ""   # Thinker Lite ($4/mo) → "lite" plan
    STRIPE_DEEP_THINKER_PRICE_ID: str = ""   # Deep Thinker ($8/mo) → "premium" plan
    # Annual equivalents. Leave blank until the prices exist in Stripe — the
    # frontend hides the monthly/annual toggle unless both are configured.
    STRIPE_THINKER_LITE_ANNUAL_PRICE_ID: str = ""   # Thinker Lite ($40/yr) → "lite"
    STRIPE_DEEP_THINKER_ANNUAL_PRICE_ID: str = ""   # Deep Thinker ($80/yr) → "premium"
    # List prices, for the observer's estimated MRR only. Billing never reads these.
    LITE_MONTHLY_USD: float = 4.0
    LITE_ANNUAL_USD: float = 40.0
    PREMIUM_MONTHLY_USD: float = 8.0
    PREMIUM_ANNUAL_USD: float = 80.0
    # Deprecated aliases — kept so existing deployments keep working. Both map to premium.
    STRIPE_PREMIUM_PRICE_ID: str = ""
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: str = ""

    # App
    APP_ENV: str = "development"
    APP_SECRET_KEY: str
    FRONTEND_URL: str = "http://localhost:3000"
    # Where support tickets are delivered, and the address shown on /support.
    # Must match the frontend's VITE_SUPPORT_EMAIL.
    SUPPORT_EMAIL: str = "help@support.usesynapse.cv"
    # Transactional email (Resend). Leave RESEND_API_KEY blank to disable
    # sending entirely — tickets are still saved, they just aren't emailed.
    # MAIL_FROM must be on a domain verified in Resend, or sends are rejected.
    RESEND_API_KEY: str = ""
    MAIL_FROM: str = "Synapse Support <help@support.usesynapse.cv>"
    ALLOWED_ORIGINS: str = "http://localhost:3000"
    CHROME_EXTENSION_ID: str = ""
    ALLOWED_ORIGIN_REGEX: str = ""

    # Rate limits
    FREE_DAILY_LIMIT: int = 100
    FREE_LIFETIME_LIMIT: int = 500
    LITE_MONTHLY_LIMIT: int = 300   # Thinker Lite: "up to 300 reformats per month"

    # Input length limits (characters)
    FREE_TEXT_LIMIT: int = 50000
    TRIAL_TEXT_LIMIT: int = 100000
    PREMIUM_TEXT_LIMIT: int = 500000

    # ── Explain (highlight / circle) ──────────────────────────────
    # Text explains share the reformat quota above. Circled screenshots are
    # costlier, so they get their own counter. Premium and institutional are
    # unlimited, but everyone is held to the per-minute burst cap.
    FREE_IMAGE_DAILY_LIMIT: int = 5      # free and anonymous, per UTC day
    LITE_IMAGE_MONTHLY_LIMIT: int = 100  # Thinker Lite, per calendar month
    EXPLAIN_BURST_PER_MINUTE: int = 10
    # Re-explains (simpler / more detail / a specific request) that cost nothing,
    # per user (or anonymous IP+fingerprint) per UTC day. After these, a
    # re-explain is charged exactly like a normal explain.
    EXPLAIN_FREE_REEXPLAINS_PER_DAY: int = 10
    # Decoded byte ceilings. The crop goes to the model and is never stored;
    # the thumbnail is what paid history keeps.
    EXPLAIN_MAX_IMAGE_BYTES: int = 4 * 1024 * 1024
    EXPLAIN_MAX_THUMBNAIL_BYTES: int = 200 * 1024
    EXPLAIN_THUMBNAIL_RETENTION_DAYS: int = 30

    # Version of the Terms of Service and Privacy Policy a user agrees to,
    # recorded on the account at signup. Bump it to the new effective date
    # whenever either document changes materially: every signed-in user whose
    # recorded version differs is then asked to accept again. Must match
    # EFFECTIVE_DATE in webpage/src/Terms.tsx and Privacy.tsx (as YYYY-MM-DD).
    TERMS_VERSION: str = "2026-10-09"

    # S3-compatible object storage for history thumbnails. Leave any of the
    # required values blank and thumbnails are simply not stored; explaining
    # and text history keep working. REGION is optional for most providers.
    EXPLAIN_STORAGE_ENDPOINT: str = ""
    EXPLAIN_STORAGE_BUCKET: str = ""
    EXPLAIN_STORAGE_ACCESS_KEY_ID: str = ""
    EXPLAIN_STORAGE_SECRET_ACCESS_KEY: str = ""
    EXPLAIN_STORAGE_REGION: str = ""

    @field_validator("APP_SECRET_KEY")
    @classmethod
    def _secret_key_is_strong(cls, v: str) -> str:
        """
        Fail at boot rather than at audit.

        This key signs every access token. It was declared but read by no code
        until first-party auth landed, so whatever value a deployment is
        carrying has never been load-bearing and must not be trusted now.
        """
        if len(v) < 32:
            raise ValueError(
                "APP_SECRET_KEY must be at least 32 characters. Generate one with "
                "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"`."
            )
        return v

    @property
    def google_oauth_configured(self) -> bool:
        return bool(
            self.GOOGLE_CLIENT_ID
            and self.GOOGLE_CLIENT_SECRET
            and self.GOOGLE_REDIRECT_URI
        )

    @property
    def explain_storage_configured(self) -> bool:
        return bool(
            self.EXPLAIN_STORAGE_ENDPOINT
            and self.EXPLAIN_STORAGE_BUCKET
            and self.EXPLAIN_STORAGE_ACCESS_KEY_ID
            and self.EXPLAIN_STORAGE_SECRET_ACCESS_KEY
        )

    @property
    def migration_database_url(self) -> str:
        return self.MIGRATION_DATABASE_URL or self.DATABASE_URL

    @property
    def cookies_secure(self) -> bool:
        """Secure cookies everywhere except local development over plain http."""
        return self.APP_ENV != "development"

    @property
    def gemini_keys(self) -> List[str]:
        """Return all non-empty Gemini keys as a list."""
        keys = [
            self.GEMINI_KEY_1,
            self.GEMINI_KEY_2,
            self.GEMINI_KEY_3,
            self.GEMINI_KEY_4,
            self.GEMINI_KEY_5,
        ]
        return [k for k in keys if k]

    @property
    def price_plan_map(self) -> dict:
        """Maps each configured Stripe price ID to the internal plan tier it grants."""
        mapping: dict = {}
        if self.STRIPE_THINKER_LITE_PRICE_ID:
            mapping[self.STRIPE_THINKER_LITE_PRICE_ID] = "lite"
        if self.STRIPE_DEEP_THINKER_PRICE_ID:
            mapping[self.STRIPE_DEEP_THINKER_PRICE_ID] = "premium"
        if self.STRIPE_THINKER_LITE_ANNUAL_PRICE_ID:
            mapping[self.STRIPE_THINKER_LITE_ANNUAL_PRICE_ID] = "lite"
        if self.STRIPE_DEEP_THINKER_ANNUAL_PRICE_ID:
            mapping[self.STRIPE_DEEP_THINKER_ANNUAL_PRICE_ID] = "premium"
        # Backward-compatible aliases — both grant Deep Thinker / premium.
        if self.STRIPE_PREMIUM_PRICE_ID:
            mapping.setdefault(self.STRIPE_PREMIUM_PRICE_ID, "premium")
        if self.STRIPE_PREMIUM_ANNUAL_PRICE_ID:
            mapping.setdefault(self.STRIPE_PREMIUM_ANNUAL_PRICE_ID, "premium")
        return mapping

    @property
    def price_period_map(self) -> dict:
        """Maps each configured Stripe price ID to its billing cadence.

        Anything not listed here is treated as monthly, which matches the
        default on the Billing model.
        """
        mapping: dict = {}
        for price_id in (
            self.STRIPE_THINKER_LITE_ANNUAL_PRICE_ID,
            self.STRIPE_DEEP_THINKER_ANNUAL_PRICE_ID,
            self.STRIPE_PREMIUM_ANNUAL_PRICE_ID,
        ):
            if price_id:
                mapping[price_id] = "annual"
        for price_id in (
            self.STRIPE_THINKER_LITE_PRICE_ID,
            self.STRIPE_DEEP_THINKER_PRICE_ID,
            self.STRIPE_PREMIUM_PRICE_ID,
        ):
            if price_id:
                mapping.setdefault(price_id, "monthly")
        return mapping

    @property
    def allowed_price_ids(self) -> List[str]:
        """Price IDs a client is allowed to start a checkout for."""
        return list(self.price_plan_map.keys())

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    @property
    def admin_emails(self) -> set[str]:
        return {
            email.strip().lower()
            for email in self.ADMIN_EMAILS.split(",")
            if email.strip()
        }

    @property
    def allowed_origin_regex(self) -> str | None:
        if self.ALLOWED_ORIGIN_REGEX:
            return self.ALLOWED_ORIGIN_REGEX
        if self.CHROME_EXTENSION_ID:
            return rf"^chrome-extension://{self.CHROME_EXTENSION_ID}$"
        if self.APP_ENV == "development":
            return r"chrome-extension://.*"
        return None

    class Config:
        env_file = ".env"
        case_sensitive = True
        # Unknown keys are ignored rather than fatal. Removing the four
        # SUPABASE_* settings would otherwise refuse to boot any deployment
        # whose .env or dashboard still carries them, turning a cleanup into an
        # outage. The cost is that a typo'd setting name is silently ignored.
        extra = "ignore"


settings = Settings()
