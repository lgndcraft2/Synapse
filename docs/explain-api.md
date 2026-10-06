# Explain API contract

Shared contract between the extension (`extension/`) and the backend (`backend/`) for the explain flow described in `docs/explain-plan.md`. All paths are under `/api/v1`. Auth is the existing optional bearer token (`get_optional_user`); anonymous callers send `fingerprint` and may send an inline `profile`, exactly like `/reformat`.

## POST /explain

Explain a highlighted text selection or a circled area.

### Request

```json
{
  "kind": "text",
  "text": "selected or circled DOM text",
  "image_base64": null,
  "image_media_type": null,
  "thumbnail_base64": null,
  "anchor": { "quote": "...", "prefix": "...", "suffix": "..." },
  "page_url": "https://example.com/article",
  "page_title": "Article title",
  "session_difficulty": "normal",
  "fingerprint": "ext-...",
  "profile": null
}
```

| Field | Rules |
|---|---|
| `kind` | `"text"` or `"image"`. `"image"` means a circle that produced a screenshot crop. A circle with no crop (screenshot failed) but with text is sent as `"text"` |
| `text` | `kind=text`: required, non-empty after trim, subject to the existing tiered text length limits. `kind=image`: optional DOM text from inside the hull, truncated by the backend to 20,000 chars |
| `image_base64` | Required when `kind=image`, forbidden when `kind=text`. Raw base64, no `data:` prefix. Decoded size max 4 MB (`EXPLAIN_MAX_IMAGE_BYTES`) |
| `image_media_type` | Required with an image: `image/png`, `image/jpeg` or `image/webp` |
| `thumbnail_base64` | Optional, `kind=image` only. Small WebP (longest side about 400 px) made by the extension, stored for paid history. Decoded max 200 KB |
| `anchor` | Optional opaque JSON used to find the source again. Text: `{quote, prefix, suffix}`. Image: `{rect: {x, y, width, height}, selector?: string, quote?, prefix?, suffix?}`. Serialized max 4 KB |
| `page_url`, `page_title` | Strings, may be empty |
| `session_difficulty` | `hard`, `normal` or `easy`, same handling as `/reformat` |
| `fingerprint`, `profile` | Same as `/reformat` |
| `recent_feedback` | Anonymous callers only: up to 20 local feedback entries (same shape as `POST /feedback` entries), oldest first. Ignored when signed in; the server's feedback log is used instead |

### Quota and rate limits

Applied in this order, before any AI call:

1. **Burst cap, everyone:** at most `EXPLAIN_BURST_PER_MINUTE` (default 10) explain calls per rolling minute per user (or per anonymous IP+fingerprint hash). Over the cap: 429, `detail.code = "EXPLAIN_BURST"`.
2. **`kind=text`:** the existing `check_rate_limit`, so one text explain costs exactly one reformat (free 100/day + 500 lifetime, Lite 300/month, Premium and institutional unlimited).
3. **`kind=image`:** a separate image-capture counter. Free and anonymous: `FREE_IMAGE_DAILY_LIMIT` (5) per UTC day. Lite: `LITE_IMAGE_MONTHLY_LIMIT` (100) per calendar month. Premium and institutional: unlimited. Over the limit: 429, `detail.code = "IMAGE_LIMIT"`. An image explain does **not** also consume reformat quota.
4. If the AI call fails, the image-capture unit is refunded (best effort). Text explains are not refunded, matching `/reformat`.

All Redis failures fail open, like `check_rate_limit`.

### Response 200

```json
{
  "html": "<div>...</div>",
  "kind": "text",
  "model_used": "gemini-flash",
  "history_entry": null,
  "usage": {
    "image_captures_used": 3,
    "image_captures_limit": 5,
    "image_period": "day"
  }
}
```

- `html` is sanitized again by the extension with DOMPurify before rendering.
- `history_entry` is the saved `HistoryEntry` (below) when the caller has an active paid plan (lite, premium, institutional), otherwise `null`.
- `usage` is present for `kind=image`; `image_captures_limit` and `image_period` are `null` for unlimited plans. For `kind=text`, `usage` is `null`.

### Errors

Errors use FastAPI's `detail`. Structured ones are objects with `code` and `message`:

| Status | `detail.code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Kind/image mismatch, empty text, bad media type, oversized image or thumbnail, oversized anchor |
| 403 | `LENGTH_EXCEEDED` | Existing text length limit |
| 429 | `EXPLAIN_BURST` | Burst cap |
| 429 | `IMAGE_LIMIT` | Image-capture quota |
| 429 | (string detail) | Existing reformat quota messages from `check_rate_limit` |
| 502 | `AI_UNAVAILABLE` | Provider failure. Never leaks provider URLs or keys |

## Context (additions to POST /explain)

Two optional request fields:

```json
{
  "context": {
    "local": {
      "heading_path": ["Settings", "Connected accounts", "Chase Checking"],
      "surrounding_text": "Last synced 3 days ago. Transactions may be missing.",
      "element": {
        "tag": "button",
        "role": "button",
        "name": "Sync",
        "aria_label": null,
        "title": "Refresh transactions from your bank",
        "label": null,
        "href": null,
        "form": { "heading": "Chase Checking", "fields": ["Nickname", "Account type"] },
        "container": "toolbar: Account actions"
      }
    },
    "page": {
      "title": "Settings - MoneyApp",
      "site_name": "MoneyApp",
      "description": "Manage your accounts",
      "outline": ["Settings", "Profile", "Connected accounts", "Notifications"],
      "main_text": "slice of the main content centred on the selection"
    }
  },
  "context_id": null
}
```

| Field | Rules |
|---|---|
| `context` | Optional. `local` and `page` are each optional. Every string field is trimmed and capped: `heading_path` max 8 items of 200 chars, `surrounding_text` 2,000 chars, `element` string fields 300 chars, `form.fields` max 20 items, `outline` max 40 items of 200 chars, `main_text` 8,000 chars. Serialized `context` over 24 KB: 400 `INVALID_REQUEST` |
| `context_id` | Optional. A document context from `POST /explain/context`, owned by the same caller. Unknown, expired or someone else's: 400 `CONTEXT_EXPIRED`, so the extension re-uploads and retries |
| `source` | Optional. `page`, `pdf` (Synapse PDF viewer) or `document` (text, CSV, Markdown, reader). Stored on the `ai_usage_events` row for the observer's feature counts only. Missing: `document` when `context_id` is set, else `page` |

Charging (replaces the text rule above):

- `kind=text` with `context.page` present, or with a `context_id` whose document has text: **4 reformat units**. Otherwise 1.
- `kind=image`: 1 image capture, whatever context is sent. No reformat units.
- Units are all-or-nothing. If the caller has fewer than 4 left, 429 with `detail.code = "QUOTA_INSUFFICIENT_FOR_CONTEXT"` and nothing is charged. The extension then offers "Explain without page context".
- The 500-lifetime free cap and the daily/monthly caps all move by the same number of units.

The prompt tells the model to explain the selection itself and then what it means on this page, site or document. Context is wrapped in its own tags, is treated as background data, and is covered by the same prompt-injection rules. `ai_usage_events.input_characters` includes context characters.

## POST /explain/context

Upload a document once so later explains can reference it.

Request:

```json
{
  "media_type": "application/pdf",
  "document_base64": "raw base64, no data: prefix",
  "document_text": null,
  "source_url": "https://example.com/paper.pdf",
  "fingerprint": "ext-..."
}
```

- Exactly one of `document_base64` (PDF, max 20 MB decoded) or `document_text` (text, CSV or Markdown, max 2,000,000 chars).
- `media_type`: `application/pdf`, `text/plain`, `text/csv` or `text/markdown`.
- PDF text is extracted on the server. A PDF with no text layer still succeeds, with `chars: 0`.
- Subject to the explain burst cap. Costs no quota; charging happens on explain.

Response 200:

```json
{ "context_id": "opaque token", "chars": 182340, "truncated": false, "expires_in": 3600 }
```

- The extracted text is kept in Redis (compressed) for 1 hour, refreshed on each use, scoped to the caller (user id, or anonymous IP+fingerprint hash). Uploading the same document again within the window returns the same `context_id`.
- Stored text is capped; `truncated` says whether the cap was hit.
- Never written to the database or logs.
- Redis unavailable: 503 `CONTEXT_UNAVAILABLE`. The extension then explains with local context only.

On explain, the backend sends the model the document's opening (about 2,000 chars) plus the passages most relevant to the selection, up to about 12,000 chars in total.

## HistoryEntry

```json
{
  "id": "uuid",
  "hostname": "example.com",
  "url": "https://example.com/article",
  "page_title": "Article title",
  "kind": "image",
  "source_text": "first 2,000 chars of the explained text",
  "anchor": { "rect": { "x": 10, "y": 20, "width": 300, "height": 200 } },
  "result_html": "<div>...</div>",
  "thumbnail_url": "https://... (presigned, short-lived) or null",
  "created_at": "2026-10-04T12:00:00Z"
}
```

`hostname` is the lowercased host of `page_url` (no port, no `www.` stripping). `thumbnail_url` is `null` when no thumbnail was stored, storage is not configured, or the thumbnail has passed its 30-day retention.

## GET /explain/history?domain={hostname}&limit={n}&before={iso8601}

- Auth required (401 otherwise). Active paid plan required: 403 with `detail.code = "HISTORY_REQUIRES_PAID"` otherwise.
- Returns `{ "entries": [HistoryEntry...], "next_before": "iso8601 or null" }`, newest first, only the caller's own rows for that hostname. `limit` defaults to 50, max 100.

## DELETE /explain/history/{id}

- Auth required. Deletes one of the caller's own entries and its thumbnail object. 404 if the entry doesn't exist or belongs to someone else. 204 on success.
- Allowed regardless of plan, so a lapsed subscriber can still delete their data.

## DELETE /explain/history?domain={hostname}

## DELETE /explain/history?all=true

- Auth required. Deletes all of the caller's entries for one hostname, or every entry when `all=true` (the dashboard's "Clear all"). Exactly one of `domain` or `all=true` must be given, otherwise 400. Returns `{ "deleted": n }`. Allowed regardless of plan.

## Thumbnail storage and retention

- Thumbnails go to S3-compatible object storage configured by `EXPLAIN_STORAGE_ENDPOINT`, `EXPLAIN_STORAGE_BUCKET`, `EXPLAIN_STORAGE_ACCESS_KEY_ID`, `EXPLAIN_STORAGE_SECRET_ACCESS_KEY`, `EXPLAIN_STORAGE_REGION`. When these are unset, thumbnails are silently not stored and everything else works.
- Each stored thumbnail gets `thumbnail_expires_at = created_at + EXPLAIN_THUMBNAIL_RETENTION_DAYS` (30). A periodic purge deletes expired objects and clears the key. The text result stays.
- Full-size crops are never stored or logged anywhere. `ai_usage_events` rows record character counts only (`operation = "explain_text"` or `"explain_image"`; for images, `input_characters` is the text length only).

## Extension messages (content script to background)

| Message | Payload | Response |
|---|---|---|
| `CAPTURE_REGION` | `{ capture: { rect, hull, devicePixelRatio, viewport } }`, sent when a trace ends | `{ ok, captureId, hasImage, preview }`. The crop is held for 2 minutes and nothing is sent to the API |
| `DISCARD_CAPTURE` | `{ captureId }`, sent on Retry or Cancel | `{ ok }` |
| `EXPLAIN` | `{ kind, text, anchor, pageUrl, pageTitle, sessionDifficulty, context?, document?, localOnly?, captureId? }`. Confirmed circles send `captureId` (no second screenshot). `document = { url, mediaType, text? }` when the source is a document. `localOnly` drops page context (used by "Explain without page context") | `{ ok: true, html, kind, modelUsed, historyEntry, usage, localEntry?, contextUsed, contextNote }` where `contextUsed` is `page`, `document` or `local`; or `{ ok: false, error, code? }` with codes including `CAPTURE_EXPIRED`, `EMPTY_CAPTURE`, `QUOTA_INSUFFICIENT_FOR_CONTEXT` |
| `PREPARE_DOCUMENT_CONTEXT` | `{ url, mediaType, text?, documentBase64? }` (`text`/`documentBase64` carry local `file://` documents, which the worker can't read) | `{ ok, contextId, chars }` or `{ ok: false, code }`. Cached per document URL until expiry; `chars: 0` is cached as "no document context" |
| `GET_EXPLAIN_HISTORY` | `{ hostname }` | `{ ok: true, entries, source: "server" \| "local" }` |
| `DELETE_EXPLAIN_HISTORY` | `{ id }` or `{ hostname }` | `{ ok: true }` |
| `EXPLAIN_HISTORY_ADDED` (background to tabs) | `{ hostname, entry }` | none |

For circles, `CAPTURE_REGION` captures the visible tab, crops to the hull's bounding box scaled by `devicePixelRatio`, masks pixels outside the hull, encodes the crop (PNG or WebP) and a thumbnail, and calls `POST /explain`. If capture fails and there is text, it sends `kind=text`. If capture fails and there is no text, it returns `{ ok: false, code: "EMPTY_CAPTURE" }` without calling the API, and the content script shows "Couldn't read that area, try circling again."
