from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str

    # Supabase
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_JWT_SECRET: str

    # Redis
    UPSTASH_REDIS_URL: str
    UPSTASH_REDIS_TOKEN: str

    # AI — free tier Gemini pool
    GEMINI_KEY_1: str
    GEMINI_KEY_2: str
    GEMINI_KEY_3: str
    GEMINI_KEY_4: str = ""
    GEMINI_KEY_5: str = ""

    # AI — premium Claude
    ANTHROPIC_API_KEY: str

    # AI — YarnGPT (optional; reserved for future TTS integration)
    YARNGPT_API_KEY: str = ""

    # Stripe — paid tier price IDs (must match the frontend VITE_STRIPE_* values)
    STRIPE_SECRET_KEY: str
    STRIPE_WEBHOOK_SECRET: str
    STRIPE_THINKER_LITE_PRICE_ID: str = ""   # Thinker Lite ($4/mo) → "lite" plan
    STRIPE_DEEP_THINKER_PRICE_ID: str = ""   # Deep Thinker ($8/mo) → "premium" plan
    # Deprecated aliases — kept so existing deployments keep working. Both map to premium.
    STRIPE_PREMIUM_PRICE_ID: str = ""
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: str = ""

    # App
    APP_ENV: str = "development"
    APP_SECRET_KEY: str
    FRONTEND_URL: str = "http://localhost:3000"
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
        # Backward-compatible aliases — both grant Deep Thinker / premium.
        if self.STRIPE_PREMIUM_PRICE_ID:
            mapping.setdefault(self.STRIPE_PREMIUM_PRICE_ID, "premium")
        if self.STRIPE_PREMIUM_ANNUAL_PRICE_ID:
            mapping.setdefault(self.STRIPE_PREMIUM_ANNUAL_PRICE_ID, "premium")
        return mapping

    @property
    def allowed_price_ids(self) -> List[str]:
        """Price IDs a client is allowed to start a checkout for."""
        return list(self.price_plan_map.keys())

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

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


settings = Settings()
