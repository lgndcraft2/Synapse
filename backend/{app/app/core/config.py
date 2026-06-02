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

    # Stripe
    STRIPE_SECRET_KEY: str
    STRIPE_WEBHOOK_SECRET: str
    STRIPE_PREMIUM_PRICE_ID: str
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: str

    # App
    APP_ENV: str = "development"
    APP_SECRET_KEY: str
    FRONTEND_URL: str = "http://localhost:3000"
    ALLOWED_ORIGINS: str = "http://localhost:3000"

    # Rate limits
    FREE_DAILY_LIMIT: int = 100
    FREE_LIFETIME_LIMIT: int = 500

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
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
