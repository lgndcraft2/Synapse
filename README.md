# Synapse

Synapse is a cognitive accessibility Chrome extension that restructures webpages and documents around the user's cognitive profile.

## Current Features

- **Section Cards:** AI-detected page sections with clickable floating reformats.
- **Full Page Reformat:** Replaces main page content with a profile-matched version.
- **Document Reader:** Securely processes PDF, TXT, CSV, and Markdown files.
- **Cognitive Profiles:** Load Reducer, Comprehension Gap, and Hyperfocus Reader.
- **Adaptive Feedback:** Tracks reactions, read time, and scroll depth to tune AI prompts.
- **SQ4R Questions:** Focus questions generated for specific cognitive profiles.
- **Bionic Reading & Focus Mode:** Session-level UI controls for deep reading.
- **Secure AI Proxy:** All AI logic and credentials are centralized on the backend.

## Plans

- **Free:** section cards, full-page reformatting, single profile, basic adaptive feedback, 30 reformats/month.
- **Thinker Lite:** everything in Free, Document Reader support, SQ4R questions, Bionic Reading, Google Docs support, 300 reformats/month.
- **Deep Thinker:** everything in Thinker Lite, full Google Docs/PDF support, cognitive pattern insights, full adaptive feedback loop, highest usage limits.

## Architecture & Security

Synapse uses a **Backend-First** architecture. The extension itself never handles raw API keys. Instead, it communicates with a FastAPI proxy that manages provider routing, rate limiting, and prompt isolation.

- **Credential Protection:** API keys for Gemini and Claude are stored only in the backend environment.
- **Prompt Isolation:** User content is wrapped in `<source_content>` tags and escaped to prevent prompt injection.
- **Tiered Limits:** Input size validation is enforced based on user plan (50K free / 100K Thinker Lite / 500K Deep Thinker).
- **Atomic Rate Limiting:** Request quotas are tracked via Redis and PostgreSQL with race-condition protection.

## Setup & Installation

### 1. Backend Setup
1. Navigate to the `backend/` directory.
2. Copy `.env.example` to `.env`.
3. Configure your **Gemini** and **Anthropic** API keys.
4. Install dependencies: `pip install -r requirements.txt`.
5. Run the server: `uvicorn app.main:app --reload`.

### 2. Extension Installation
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `Synapse OS` root folder.
4. Complete onboarding.
5. In the extension popup, ensure the **Backend API URL** matches your running server (default: `http://localhost:8000`).

## Tech Stack

- **Extension:** Manifest V3, Vanilla JS/HTML/CSS, DOMPurify.
- **Backend:** Python 3.11+, FastAPI, SQLAlchemy, Redis (Upstash).
- **Models:** Google Gemini 1.5 Flash (Free), Anthropic Claude 3.5 Sonnet (Deep Thinker).

## Product Status

The core secure architecture is complete. Ongoing work includes institutional SSO integration and organization-level admin tools.
