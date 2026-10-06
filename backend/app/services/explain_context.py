"""
Document context for explains: extract, store briefly, pick passages.

A document (a PDF, or a text/CSV/Markdown file) is uploaded once through
POST /explain/context. Its text is kept in Redis for an hour, compressed, and
later explains reference it by an opaque `context_id`. Nothing here touches
the database or a log line: the text is the user's document.

Keys and ids:

  * The Redis key is scoped to the caller identity (user id, or the anonymous
    IP+fingerprint hash shared with the explain limits) and to the sha256 of
    the uploaded content, so the same document re-uploaded in the window maps
    to the same entry.
  * `context_id` is an HMAC of identity + content hash under APP_SECRET_KEY.
    It is stable for re-uploads, unguessable without the secret, and is only
    ever looked up under the *caller's* identity — someone else's id simply
    misses, which is indistinguishable from an expired one.

Size: Upstash's REST API rejects requests over about 1 MB, so the stored text
is capped at STORE_CHAR_LIMIT characters and the base64 of the compressed
value is held under STORE_VALUE_LIMIT; incompressible text is cut further
until it fits. `truncated` reports either cut.
"""

import base64
import hashlib
import hmac
import io
import math
import re
import time
import zlib
from collections import Counter

from app.core.config import settings
from app.services import rate_limit as rl

CONTEXT_TTL_SECONDS = 60 * 60
STORE_CHAR_LIMIT = 400_000
STORE_VALUE_LIMIT = 700_000         # base64 chars of the compressed text

# PDF extraction guards. A hostile or broken PDF can be slow to parse; these
# bound the work regardless of what the file claims.
PDF_PAGE_LIMIT = 2_000
PDF_TIME_BUDGET_SECONDS = 20.0

# Passage selection.
OPENING_CHARS = 2_000
CHUNK_CHARS = 1_400
CHUNK_OVERLAP = 200
PASSAGE_BUDGET = 12_000

_CONTEXT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


class PdfUnreadable(Exception):
    """The upload is not a PDF pypdf can open at all."""


# ── Text normalisation and extraction ─────────────────────────────

def normalise_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf_text(data: bytes, char_limit: int = STORE_CHAR_LIMIT) -> tuple[str, bool]:
    """Text layer of a PDF, and whether extraction stopped early.

    Blocking: run it in a thread. An encrypted PDF that does not open with the
    empty password is treated like a scan with no text layer (chars 0), so the
    extension needs no extra branch: it explains with local context only.
    Raises PdfUnreadable for files pypdf cannot parse.
    """
    from pypdf import PdfReader   # lazy: only this route needs it

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    return "", False
            except Exception:
                return "", False
        pages = reader.pages
        page_count = len(pages)
    except Exception as exc:
        raise PdfUnreadable(str(exc)) from exc

    deadline = time.monotonic() + PDF_TIME_BUDGET_SECONDS
    parts: list[str] = []
    total = 0
    truncated = False
    for index in range(page_count):
        if index >= PDF_PAGE_LIMIT or total > char_limit or time.monotonic() > deadline:
            truncated = True
            break
        try:
            page_text = pages[index].extract_text() or ""
        except Exception:
            page_text = ""   # one broken page should not sink the document
        if page_text.strip():
            parts.append(page_text)
            total += len(page_text)

    text = normalise_text("\n\n".join(parts))
    if len(text) > char_limit:
        text, truncated = text[:char_limit], True
    return text, truncated


# ── Storage ───────────────────────────────────────────────────────

def content_hash(kind: str, payload: bytes) -> str:
    return hashlib.sha256(kind.encode() + b"\x00" + payload).hexdigest()


def context_id_for(identity: str, digest: str) -> str:
    mac = hmac.new(
        settings.APP_SECRET_KEY.encode(), f"ctx:{identity}:{digest}".encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def _key(identity: str, context_id: str) -> str:
    return f"ctx:doc:{identity}:{context_id}"


def encode_value(text: str, truncated: bool) -> tuple[str, str, bool]:
    """Compress for Redis. Returns (value, stored_text, truncated).

    The stored text is cut further when even the compressed form would not fit
    under STORE_VALUE_LIMIT (text that compresses badly, e.g. dense non-Latin
    scripts or random data).
    """
    text = text[:STORE_CHAR_LIMIT] if len(text) > STORE_CHAR_LIMIT else text
    while True:
        encoded = base64.b64encode(zlib.compress(text.encode("utf-8"), 6)).decode()
        if len(encoded) <= STORE_VALUE_LIMIT or not text:
            break
        text = text[: int(len(text) * STORE_VALUE_LIMIT / len(encoded) * 0.9)]
        truncated = True
    return f"{int(truncated)}:{encoded}", text, truncated


def decode_value(value: str) -> tuple[str, bool]:
    flag, _, encoded = value.partition(":")
    text = zlib.decompress(base64.b64decode(encoded)).decode("utf-8")
    return text, flag == "1"


async def store(identity: str, context_id: str, value: str) -> None:
    """Raises RedisError."""
    await rl.redis_client.setex(_key(identity, context_id), CONTEXT_TTL_SECONDS, value)


async def load(identity: str, context_id: str | None) -> tuple[str, bool] | None:
    """The caller's document text, refreshing its TTL; None when unusable.

    A malformed id, another caller's id and an expired one all miss the same
    way. Raises RedisError.
    """
    if not context_id or not _CONTEXT_ID_RE.match(context_id):
        return None
    key = _key(identity, context_id)
    value = await rl.redis_client.get(key)
    if not value:
        return None
    await rl.redis_client.expire(key, CONTEXT_TTL_SECONDS)
    try:
        return decode_value(value)
    except (ValueError, zlib.error, UnicodeDecodeError):
        return None


# ── Passage selection ─────────────────────────────────────────────

_STOPWORDS = frozenset("""
a about above after again against all also am an and any are as at be because been
before being below between both but by can could did do does doing down during each
few for from further had has have having he her here hers him his how i if in into is
it its itself just me more most my no nor not now of off on once only or other our
ours out over own same she should so some such than that the their theirs them then
there these they this those through to too under until up very was we were what when
where which while who whom why will with would you your yours
""".split())

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def _tokens(text: str) -> list[str]:
    return [
        t for t in _TOKEN_RE.findall(text.lower())
        if len(t) > 1 and t not in _STOPWORDS and not t.isdigit()
    ]


def _cut_at_space(text: str, limit: int) -> int:
    """An index <= limit that avoids splitting a word, when one is close."""
    if len(text) <= limit:
        return len(text)
    space = text.rfind(" ", int(limit * 0.8), limit)
    newline = text.rfind("\n", int(limit * 0.8), limit)
    cut = max(space, newline)
    return cut if cut > 0 else limit


def select_passages(document: str, selection: str, budget: int = PASSAGE_BUDGET) -> str:
    """The opening of `document` plus the chunks most relevant to `selection`.

    Scoring is BM25 over lowercase word tokens minus stopwords. With no usable
    query terms (an image-only circle) or no matches, the earliest chunks win.
    Chosen spans are merged and kept in document order, with gaps marked.
    A document that already fits the budget is returned whole.
    """
    if len(document) <= budget:
        return document

    opening_end = _cut_at_space(document, OPENING_CHARS)
    step = CHUNK_CHARS - CHUNK_OVERLAP
    spans = [
        (start, min(start + CHUNK_CHARS, len(document)))
        for start in range(opening_end, len(document), step)
    ]

    query = set(_tokens(selection or ""))
    scores = [0.0] * len(spans)
    if query and spans:
        chunk_tokens = [Counter(_tokens(document[s:e])) for s, e in spans]
        avg_len = sum(sum(c.values()) for c in chunk_tokens) / len(spans) or 1.0
        n = len(spans)
        df = {t: sum(1 for c in chunk_tokens if t in c) for t in query}
        k1, b = 1.2, 0.75
        for i, counts in enumerate(chunk_tokens):
            length = sum(counts.values())
            score = 0.0
            for term in query:
                tf = counts.get(term, 0)
                if not tf:
                    continue
                idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
                score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / avg_len))
            scores[i] = score

    remaining = budget - opening_end
    chosen: list[tuple[int, int]] = []
    for i in sorted(range(len(spans)), key=lambda i: (-scores[i], i)):
        start, end = spans[i]
        if end - start > remaining:
            continue
        chosen.append((start, end))
        remaining -= end - start
        if remaining < CHUNK_CHARS // 2:
            break

    # Merge overlapping or touching spans, in document order.
    merged: list[list[int]] = [[0, opening_end]]
    for start, end in sorted(chosen):
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    return "\n[…]\n".join(document[s:e].strip() for s, e in merged)
