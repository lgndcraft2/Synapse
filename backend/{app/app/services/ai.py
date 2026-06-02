import httpx
import asyncio
from app.core.config import settings

# ── Gemini key rotation state ─────────────────────────────────────
_key_index = 0
_rate_limited_keys: set[str] = set()
_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
_CLAUDE_BASE  = "https://api.anthropic.com/v1/messages"
_CLAUDE_MODEL = "claude-sonnet-4-6"


def _get_next_gemini_key() -> str | None:
    """Round-robin through available (non-rate-limited) Gemini keys."""
    global _key_index
    available = [k for k in settings.gemini_keys if k not in _rate_limited_keys]
    if not available:
        # All keys are rate limited — reset and try again
        _rate_limited_keys.clear()
        available = settings.gemini_keys

    if not available:
        return None

    _key_index = (_key_index + 1) % len(available)
    return available[_key_index]


def _build_system_prompt(profile: dict, feedback_summary: str) -> str:
    """
    Constructs the cognitive accessibility system prompt.
    Identical logic to background.js — single source of truth on the server.
    """
    chunk_desc = {
        "short":  "Keep each section concise — 2 to 3 sentences maximum per point.",
        "medium": "Use moderate length — enough detail to be clear, but no padding.",
        "long":   "Be thorough — include full context and nuance for each point.",
    }.get(profile.get("chunk_size", "short"), "Keep sections concise.")

    base = [
        f"Format: Present all content as {profile.get('preferred_format', 'bullet points')}.",
        chunk_desc,
        "Always lead with a concrete example BEFORE the explanation."
            if profile.get("needs_examples_first") else
            "Give the explanation first, then follow with examples.",
        "Use plain, everyday language. Replace jargon with simpler alternatives."
            if profile.get("simplify_vocab") else
            "Preserve the original technical vocabulary.",
        f"Maximum nesting depth for lists: {profile.get('max_nesting_depth', 2)} level(s).",
    ]

    strategies = {
        "load-reducer": [
            "COGNITIVE STRATEGY: Reduce cognitive friction. Lead with the single most important point.",
            "Break any sentence longer than 20 words into two sentences.",
            "Never introduce more than one new concept per paragraph or bullet.",
            "Use <mark> on the single most critical term per section.",
        ],
        "comprehension-gap": [
            "COGNITIVE STRATEGY: Make implicit meaning explicit.",
            "After each key paragraph, add a one-sentence plain-language interpretation.",
            "Surface subtext: if the author implies something, state it directly.",
            "Identify and state the single core argument of the section at the top.",
        ],
        "hyperfocus": [
            "COGNITIVE STRATEGY: Structure and retention — not simplification.",
            "Do NOT simplify vocabulary or water down nuance.",
            "Provide a 2-line takeaway at the end of each section for later recall.",
            "Bold key terms and novel concepts as anchors for fast scanning.",
        ],
    }

    strategy = strategies.get(profile.get("profile_type", "load-reducer"), [])
    lines = [*base, "", *strategy]

    if notes := profile.get("notes", "").strip():
        lines.append(f'\nDirect note from the user: "{notes}"')

    system = f"""You are Synapse, a cognitive accessibility assistant.
Reformat page content into HTML that works for this user's brain.

── HOW THIS USER NEEDS CONTENT PRESENTED ──
{chr(10).join(lines)}

── WHAT YOU HAVE LEARNED FROM THIS USER'S FEEDBACK ──
{feedback_summary}

── RULES ──
- Return ONLY a single <div> of valid HTML. No markdown, no preamble.
- Use semantic tags: <h2>, <h3>, <p>, <ul>/<li>, <strong>, <mark>.
- Keep ALL original information — only restructure the presentation.
- No inline styles. No content outside the single <div>."""

    return system


async def call_gemini(page_text: str, profile: dict, feedback_summary: str) -> str:
    """Call Gemini Flash via direct API with key rotation."""
    system_prompt = _build_system_prompt(profile, feedback_summary)

    for attempt in range(len(settings.gemini_keys) + 1):
        key = _get_next_gemini_key()
        if not key:
            raise RuntimeError("All Gemini API keys are currently rate limited.")

        payload = {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": [{
                "parts": [{"text": f"Reformat this content:\n\n{page_text}"}]
            }],
            "generationConfig": {"maxOutputTokens": 2000},
        }

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{_GEMINI_BASE}?key={key}",
                json=payload,
            )

        if response.status_code == 429:
            _rate_limited_keys.add(key)
            # Brief wait before retrying with next key
            await asyncio.sleep(0.5)
            continue

        response.raise_for_status()
        data = response.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]

    raise RuntimeError("All Gemini API keys exhausted.")


async def call_claude(page_text: str, profile: dict, feedback_summary: str) -> str:
    """Call Claude Sonnet via Anthropic API — premium users only."""
    system_prompt = _build_system_prompt(profile, feedback_summary)

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            _CLAUDE_BASE,
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": _CLAUDE_MODEL,
                "max_tokens": 2000,
                "system": system_prompt,
                "messages": [{
                    "role": "user",
                    "content": f"Reformat this content for my cognitive profile:\n\n{page_text}"
                }]
            }
        )

    response.raise_for_status()
    data = response.json()
    return data["content"][0]["text"]


async def generate_sq4r_questions(page_text: str, profile_type: str) -> list[str] | None:
    """
    Generate SQ4R pre-reading questions.
    Only fires for load-reducer and comprehension-gap profiles.
    Uses Gemini (free) regardless of user plan — these are lightweight calls.
    """
    if profile_type == "hyperfocus":
        return None

    key = _get_next_gemini_key()
    if not key:
        return None

    payload = {
        "system_instruction": {
            "parts": [{"text": (
                "You generate pre-reading focus questions for a neurodivergent reader. "
                "Return ONLY a JSON array of 2-3 short questions. No preamble, no markdown. "
                "Example: [\"What problem does this solve?\",\"Who does this affect?\"]"
            )}]
        },
        "contents": [{
            "parts": [{"text": f"Generate focus questions for:\n\n{page_text[:600]}"}]
        }],
        "generationConfig": {"maxOutputTokens": 200},
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"{_GEMINI_BASE}?key={key}", json=payload)
        response.raise_for_status()
        data = response.json()
        raw = data["candidates"][0]["content"]["parts"][0]["text"]
        import json
        questions = json.loads(raw.strip().replace("```json", "").replace("```", ""))
        return questions[:3] if isinstance(questions, list) else None
    except Exception:
        return None


def build_feedback_summary(feedback_entries: list[dict]) -> str:
    """Convert feedback log entries into prompt context."""
    if not feedback_entries:
        return "No feedback collected yet. Apply the cognitive profile strictly."

    counts = {"clearer": 0, "complex": 0, "simple": 0, "off-topic": 0}
    total_time, total_read, hard_sessions = 0, 0, 0

    for e in feedback_entries:
        if r := e.get("reaction"):
            counts[r] = counts.get(r, 0) + 1
        total_time += e.get("time_spent_seconds", 0) or 0
        total_read += e.get("read_progress", 0) or 0
        if e.get("session_difficulty") == "hard":
            hard_sessions += 1

    n = len(feedback_entries)
    avg_time = round(total_time / n)
    avg_read = round(total_read / n)

    summary = f"Based on {n} interactions:\n"
    summary += f"- Reactions: {counts['clearer']} clearer, {counts['complex']} complex, {counts['simple']} simple, {counts['off-topic']} off-topic\n"
    summary += f"- Avg time on card: {avg_time}s | Avg scroll depth: {avg_read}%\n"

    if hard_sessions > 0:
        summary += f"- {hard_sessions} hard-day sessions. Use shorter chunks and simpler sentences.\n"
    if counts["complex"] > counts["clearer"]:
        summary += "- IMPORTANT: User finds reformats too complex. Simplify further.\n"
    if counts["off-topic"] > 2:
        summary += "- IMPORTANT: User finds reformats miss the point. Front-load the central argument.\n"
    if avg_read < 40:
        summary += "- User stops reading early. Lead with the most important information first.\n"

    return summary
