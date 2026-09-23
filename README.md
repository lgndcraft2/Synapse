# Synapse

Synapse is a cognitive accessibility Chrome extension and web app that reformats webpages and documents around a user's cognitive profile.

The project is organized around a backend-first architecture: the extension and dashboard authenticate through Supabase, then call a FastAPI backend that owns AI provider credentials, rate limits, billing state, prompt construction, and persistence.

## Current Features

- Section cards: AI-detected page sections with clickable reformats.
- Full-page reformat: Replaces the main page content with profile-matched output.
- Document reader: Processes PDF, TXT, CSV, and Markdown uploads through the backend.
- Cognitive profiles: Load Reducer, Comprehension Gap, and Hyperfocus Reader.
- Adaptive feedback: Tracks reactions, time spent, read progress, and section-level notes.
- SQ4R questions: Generates focus questions for profile-aware reading.
- Bionic reading and focus mode: Session-level controls for deeper reading.
- Auth handoff: The dashboard can pass a Supabase session to the installed extension.
- Billing: Stripe checkout, customer portal, subscription confirmation, and webhook handling.

## Repository Map

```text
.
|-- manifest.json              # Chrome Manifest V3 configuration
|-- background.js              # Extension service worker and backend bridge
|-- content.js                 # Injected page UI, extraction, reformat modes, feedback
|-- popup.html/css/js          # Extension popup and profile/billing controls
|-- onboarding.html/css/js     # Extension onboarding flow
|-- purify.min.js              # DOMPurify bundled for extension sanitization
|-- backend/
|   |-- app/main.py            # FastAPI app, middleware, CORS, route registration
|   |-- app/api/routes/        # Auth, reformat, profile/feedback/stats, billing/webhooks
|   |-- app/core/              # Settings, JWT verification, FastAPI dependencies
|   |-- app/db/                # Async SQLAlchemy database setup
|   |-- app/models/            # SQLAlchemy ORM models
|   |-- app/schemas/           # Pydantic request/response models
|   |-- app/services/          # AI provider calls, prompt building, rate limits/cache
|   |-- migrations/            # SQL migrations
|   |-- requirements.txt
|   `-- Dockerfile
|-- webpage/
|   |-- src/App.tsx            # Marketing/pricing page
|   |-- src/AuthPage.tsx       # Supabase sign-in/sign-up page
|   |-- src/Dashboard.tsx      # User dashboard/profile/billing UI
|   |-- src/lib/api.ts         # Backend API client
|   |-- src/lib/supabase.ts    # Supabase browser client
|   |-- src/lib/extensionBridge.ts
|   |-- package.json
|   `-- vite.config.ts
`-- tests/
    |-- auth-sync.spec.mjs     # Dashboard to extension auth/sync e2e test
    |-- global-setup.mjs       # Starts backend/Vite and discovers extension ID
    |-- global-teardown.mjs
    `-- README.md
```

## Architecture

### Chrome Extension

The extension is a Manifest V3 extension loaded from the repository root.

- `content.js` extracts page text, renders the floating Synapse UI, opens section cards, handles full-page/document modes, applies bionic reading/focus mode, and submits feedback.
- `background.js` stores user profile/provider config, refreshes Supabase sessions, calls backend endpoints, tracks local usage, and receives dashboard session handoff messages.
- `popup.js` lets users manage cognitive profile settings, see auth/billing state, refresh profile data, and clear local feedback.

### Backend

The backend is a FastAPI app under `backend/app`.

Active API groups:

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

The backend owns:

- Supabase JWT verification.
- User/profile/billing/session/feedback persistence.
- Gemini and Claude API calls.
- Prompt isolation using escaped source content.
- Request size limits.
- Free/lite/premium rate limits and monthly caps.
- Stripe checkout, billing portal, subscription confirmation, and webhook updates.

### Web App

The web app is a Vite React app under `webpage`.

Routing is selected in `webpage/src/main.tsx`:

- `/` renders the marketing and pricing app.
- `/auth...` renders the auth page.
- `/dashboard...` renders the dashboard.

The dashboard uses Supabase for browser auth, calls the backend through `src/lib/api.ts`, and optionally sends the active Supabase session to the extension through `src/lib/extensionBridge.ts`.

## Setup

### Backend

```bash
cd backend
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Important backend environment values:

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`
- `UPSTASH_REDIS_URL` (supports the Upstash REST `https://` endpoint)
- `UPSTASH_REDIS_TOKEN` (the matching Upstash REST token)
- `ADMIN_EMAILS` (comma-separated emails allowed to access `/observer`)
- `GEMINI_KEY_1` through `GEMINI_KEY_5`
- `ANTHROPIC_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_THINKER_LITE_PRICE_ID`
- `STRIPE_DEEP_THINKER_PRICE_ID`
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- `ALLOWED_ORIGIN_REGEX`

### Web App

```bash
cd webpage
npm install
npm run dev
```

Create `webpage/.env` from `webpage/.env.example`.

Important web environment values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_BACKEND_URL`
- `VITE_STRIPE_THINKER_LITE_PRICE_ID`
- `VITE_STRIPE_DEEP_THINKER_PRICE_ID`
- `VITE_EXTENSION_ID`

`VITE_EXTENSION_ID` is only needed for dashboard-to-extension session handoff. You can find it at `chrome://extensions` after loading the unpacked extension.

### Chrome Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository root.
5. Open the extension popup and confirm the backend URL points at your backend. Production uses `https://api.usesynapse.cv`; local development usually uses `http://localhost:8000`.

## Testing

```bash
npx playwright test --config=playwright.config.mjs
```

The Playwright suite is in `tests/`. Its global setup discovers the extension ID, temporarily patches `webpage/.env`, starts the backend on port 8000, starts Vite on port 5173, and runs a serial auth/sync flow against bundled Chromium.

Both ports must be free before running the suite.

## Tech Stack

- Extension: Chrome Manifest V3, vanilla JS/HTML/CSS, DOMPurify.
- Backend: Python, FastAPI, SQLAlchemy async, PostgreSQL/Supabase, Redis/Upstash.
- Web app: React, TypeScript, Vite, Supabase JS, lucide-react.
- Billing: Stripe.
- Tests: Playwright.
- AI providers: Google Gemini for the free path, Anthropic Claude for premium.

## Product Status

The core extension/backend/dashboard loop is present: auth sync, profile management, reformatting, feedback, usage limits, and billing. Good next areas to pick up are test coverage, README/env cleanup, production deployment verification, and any planned institutional SSO or organization admin work.
