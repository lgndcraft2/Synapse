# Synapse

Synapse is a cognitive-accessibility product: a Chrome extension reshapes web content around a person's reading profile, while a React dashboard and FastAPI API handle identity, profiles, billing, support, and operations.

## What is included

- AI-assisted section, full-page, and document reformatting; SQ4R questions; bionic reading; focus mode; and adaptive feedback.
- Three reading profiles: Load Reducer, Comprehension Gap, and Hyperfocus Reader.
- First-party account flows: password registration, email verification, password recovery, Google OAuth, short-lived access tokens, and rotating refresh tokens with reuse detection.
- Dashboard management for profiles, validated preset avatars, usage, billing, invoices, payment methods, support tickets, and subscription changes.
- Stripe Checkout, customer portal, cancellation, resumption, plan changes, and signed webhook handling.
- An access-controlled Observer panel with privacy-safe request telemetry, AI provider usage/cost estimates, user actions, and an audit log.
- Gemini and Claude calls kept server-side, with tier-aware rate limits and usage caps backed by Redis or Upstash REST.

## Repository layout

```text
.
|-- extension/                 # Self-contained unpacked Chrome Manifest V3 bundle
|   |-- manifest.json
|   |-- background.js          # Session refresh, API bridge, and extension storage
|   |-- content.js             # In-page reader UI and reformat interactions
|   |-- popup.*                # Profile, account, billing, and feedback controls
|   |-- onboarding.*           # First-run cognitive profile setup
|   |-- icons/
|   `-- purify.min.js          # Bundled DOM sanitiser for extension output
|-- webpage/                   # Vite + React dashboard and marketing site
|   |-- src/lib/auth.ts        # First-party browser session client
|   |-- src/lib/api.ts         # Authenticated backend client
|   |-- src/lib/extensionBridge.ts
|   `-- src/Observer.tsx       # Operator-only observability view
|-- backend/                   # FastAPI application and Alembic migrations
|   |-- app/api/routes/        # Auth, profile, reformat, billing, support, observer
|   |-- app/services/          # AI, email, auth, rate limiting, telemetry
|   |-- alembic/versions/
|   `-- tests/
|-- tests/                     # Playwright dashboard-to-extension contract tests
|-- Dockerfile                 # Builds the web app and serves it with the API
`-- playwright.config.mjs
```

`extension/` is deliberately an independent loadable directory. It contains every asset referenced by `manifest.json`; the web app and backend remain in their own folders. The dashboard's small `extensionBridge.ts` is an intentional cross-product contract: it can hand an authenticated session to an installed extension, but safely becomes a no-op when none is installed.

## Architecture

```text
Chrome extension <--> FastAPI API <--> PostgreSQL
       ^                    |              |
       |                    +--> Redis / Upstash
React dashboard ------------+--> Gemini / Claude / Stripe / Resend
```

The dashboard authenticates against the API and passes its session to the extension through Chrome's externally-connectable messaging. The extension refreshes its own token family and calls the API; it does not contain AI-provider credentials or a standalone sign-in flow. The API owns prompt construction, input limits, persistence, billing, email, and access control.

## Local setup

### 1. Backend

```bash
cd backend
Copy-Item .env.example .env
pip install -r requirements.txt
alembic upgrade head
python -m uvicorn app.main:app --reload
```

Set the values in `backend/.env` before starting. At minimum, configure `DATABASE_URL`, a strong `APP_SECRET_KEY`, Redis/Upstash credentials, Gemini keys, the Anthropic key, Stripe credentials, frontend/CORS origins, and the plan price IDs. `GOOGLE_CLIENT_*` values enable Google OAuth; `RESEND_API_KEY` enables support-email delivery; `ADMIN_EMAILS` grants access to `/observer`. The template documents optional annual pricing, provider cost estimates, and production migration configuration.

### 2. Web app

```bash
cd webpage
Copy-Item .env.example .env
npm install
npm run dev
```

Set `VITE_BACKEND_URL`; add matching Stripe price IDs and `VITE_SUPPORT_EMAIL` as needed. `VITE_EXTENSION_ID` is optional for normal web development, but required for dashboard-to-extension session handoff.

### 3. Chrome extension

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked**.
3. Select the repository's `extension/` directory — not the repository root.
4. Copy the generated extension ID into `webpage/.env` as `VITE_EXTENSION_ID`, then restart Vite.

For local development the extension's default API target is `http://localhost:8000`; production is handled by the deployed session handoff. The manifest already permits the local Vite origins used by the project and the production dashboard origins.

## Tests

Backend tests:

```bash
cd backend
python -m pytest
```

Browser contract tests:

```bash
npm install
npx playwright test --config=playwright.config.mjs
```

The Playwright setup loads `extension/`, discovers its path-derived ID, temporarily puts that ID in `webpage/.env`, seeds a disposable SQLite database, and starts the backend on port 8000 plus Vite on port 3000. Both ports must be free. See [`tests/README.md`](tests/README.md) for limitations and test-flow detail.

## Deployment

The root `Dockerfile` builds `webpage/`, installs the backend, runs `alembic upgrade head`, and serves the API plus compiled SPA on `$PORT`. Configure production URLs, Chrome extension origin restrictions (`CHROME_EXTENSION_ID` or `ALLOWED_ORIGIN_REGEX`), Stripe webhooks, and direct migration connectivity before deploying.

## Technology

- Extension: Chrome Manifest V3, vanilla JavaScript, HTML/CSS, DOMPurify
- Dashboard: React, TypeScript, Vite, Lucide
- API: FastAPI, SQLAlchemy async, Alembic, PostgreSQL
- Services: Redis/Upstash, Gemini, Claude, Stripe, Resend, Google OAuth
- Validation: pytest and Playwright
