# Synapse

Synapse is a cognitive accessibility Chrome extension that restructures webpages and documents around the user's cognitive profile.

## Current Features

- Section Cards: AI-detected page sections with clickable floating reformats.
- Full Page Reformat: replaces the main page content with a profile-matched version.
- Document Reader: detects PDF, TXT, CSV, and Markdown files opened in Chrome.
- Cognitive profiles: Load Reducer, Comprehension Gap, and Hyperfocus Reader.
- Adaptive feedback: tracks reactions, read time, scroll depth, notes, and hard-day state.
- SQ4R questions: generated for Load Reducer and Comprehension Gap profiles.
- Focus mode and bionic reading: session controls in the page panel.
- Media preservation: full-page media reinjection and section-card media cloning.
- Provider routing: free Gemini Flash pool and premium Claude Sonnet path.

## Model Setup

Open the extension popup after onboarding and configure model settings:

- Free tier: add one or more Gemini API keys, one per line. Synapse rotates keys round-robin and skips recently rate-limited keys.
- Premium tier: add an Anthropic API key and select Premium or Claude routing.
- Auto provider: uses Gemini first for free routing and can fall back to Claude if a Claude key is configured.

No API keys are committed to the repo. Local testing keys are stored in `chrome.storage.local`.

## Installation

1. Open Chrome and go to `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this `Synapse OS` folder.
5. Complete onboarding from the extension popup.

## Tech Stack

- Manifest V3 Chrome Extension
- Vanilla JavaScript, HTML, and CSS
- `chrome.storage.local` for cognitive profile, feedback, provider config, and usage state
- Google Gemini API for the free tier
- Anthropic Claude API for the premium tier

## Product Status

This repo now contains the core architecture described in the product brief. Subscription validation, real hosted key distribution, institutional SSO/admin tools, cross-device sync, and payment enforcement still need backend infrastructure outside the extension.
