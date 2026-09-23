# Synapse Backend

FastAPI backend for Synapse. It handles authentication sync, cognitive profiles, AI reformatting, document processing, feedback ingestion, dashboard stats, rate limiting, and Stripe billing.

## Stack

- FastAPI
- PostgreSQL through Supabase
- Async SQLAlchemy
- Supabase Auth/JWT verification
- Upstash Redis for rate limiting and cache
- Stripe for subscriptions and billing portal
- Gemini and Claude provider calls through server-side credentials

## Project Structure

```text
backend/
|-- app/
|   |-- main.py                  # FastAPI app, middleware, CORS, route registration
|   |-- api/routes/
|   |   |-- auth.py              # Supabase user sync and current-user endpoint
|   |   |-- reformat.py          # Page, section, and document AI proxy endpoints
|   |   |-- profile.py           # Profile CRUD, feedback ingestion, dashboard stats
|   |   `-- billing.py           # Stripe status, checkout, portal, confirm, webhooks
|   |-- core/
|   |   |-- config.py            # Environment settings
|   |   |-- dependencies.py      # Authenticated user dependencies
|   |   `-- jwt_verify.py        # Supabase JWT/JWKS verification
|   |-- db/
|   |   `-- database.py          # Async SQLAlchemy engine/session/base
|   |-- models/
|   |   `-- models.py            # SQLAlchemy ORM models
|   |-- schemas/
|   |   `-- schemas.py           # Pydantic API models
|   `-- services/
|       |-- ai.py                # Prompt building and Gemini/Claude calls
|       `-- rate_limit.py        # Redis cache/rate limits and usage caps
|-- migrations/
|   `-- 0001_add_lite_plan.sql
|-- .env.example
|-- requirements.txt
`-- Dockerfile
```

## API Routes

- `POST /api/v1/auth/sync`
- `GET /api/v1/auth/me`
- `POST /api/v1/reformat`
- `POST /api/v1/reformat/analyse-sections`
- `POST /api/v1/reformat/reformat-document`
- `GET /api/v1/profile`
- `PATCH /api/v1/profile`
- `GET /api/v1/profile/history`
- `POST /api/v1/feedback`
- `GET /api/v1/dashboard/stats`
- `GET /api/v1/billing/status`
- `POST /api/v1/billing/checkout`
- `POST /api/v1/billing/confirm`
- `POST /api/v1/billing/portal`
- `POST /api/v1/webhooks/stripe`
- `GET /health`

## Setup

```bash
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Run those commands from the `backend/` directory.

Before starting the app, replace `APP_SECRET_KEY` in `.env` with a freshly generated secret. A quick option is:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Required Environment

See `.env.example` for the full list. The main groups are:

- Database: `DATABASE_URL`
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- Redis: `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN` (the Upstash REST `https://` URL and REST token are supported)
- Observer panel: `ADMIN_EMAILS` (comma-separated internal operator email addresses)
- AI: `GEMINI_KEY_1` through `GEMINI_KEY_5`, `ANTHROPIC_API_KEY`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_THINKER_LITE_PRICE_ID`, `STRIPE_DEEP_THINKER_PRICE_ID`
- App/CORS: `APP_ENV`, `FRONTEND_URL`, `ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_REGEX`
- Limits: `FREE_DAILY_LIMIT`, `FREE_LIFETIME_LIMIT`, `LITE_MONTHLY_LIMIT`

## Notes

- API docs are available at `/docs` only when `APP_ENV=development`.
- The app applies a request body size middleware before route handling.
- Static frontend serving is supported if a built frontend exists under `backend/static`.
- Prompt isolation and provider credentials live on the backend, not in the extension.
