# Synapse Backend

## Stack
- **FastAPI** — backend framework
- **PostgreSQL** (Supabase) — primary database
- **Upstash Redis** — rate limiting + caching
- **Supabase Auth** — Google OAuth
- **Stripe** — subscriptions + billing for Thinker Lite and Deep Thinker
- **Railway** — hosting

## Project Structure
```
synapse-backend/
├── app/
│   ├── main.py                  # FastAPI app entry point
│   ├── api/
│   │   └── routes/
│   │       ├── auth.py          # Google OAuth + session
│   │       ├── reformat.py      # Core proxy endpoint (extension → AI)
│   │       ├── profile.py       # Cognitive profile CRUD
│   │       ├── feedback.py      # Feedback log ingestion
│   │       ├── sessions.py      # Reading session history
│   │       ├── billing.py       # Stripe checkout + portal
│   │       └── webhooks.py      # Stripe webhook handler
│   ├── core/
│   │   ├── config.py            # All env vars
│   │   ├── security.py          # JWT validation
│   │   └── dependencies.py      # Shared FastAPI deps (get_current_user etc)
│   ├── db/
│   │   ├── database.py          # Async SQLAlchemy engine
│   │   └── schema.sql           # Raw SQL schema
│   ├── models/
│   │   └── models.py            # SQLAlchemy ORM models
│   ├── schemas/
│   │   └── schemas.py           # Pydantic request/response schemas
│   └── services/
│       ├── ai.py                # Gemini + Claude API calls
│       ├── rate_limit.py        # Redis rate limiting
│       ├── profile.py           # Profile update logic
│       └── stripe.py            # Stripe helpers
├── tests/
├── scripts/
│   └── seed.py                  # Dev seed data
├── .env.example
├── requirements.txt
└── Dockerfile
```

## Setup
```bash
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Stripe billing expects `STRIPE_THINKER_LITE_PRICE_ID`, `STRIPE_DEEP_THINKER_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET` in the environment.
