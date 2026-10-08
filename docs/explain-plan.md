# Synapse explain plan

Status: everything in this plan is built and merged into `main`: highlight, circle with confirm step, panel and history, page and document context, and the Synapse PDF viewer (`extension/viewer/`, pdf.js 5.7.284 in `extension/vendor/pdfjs/`). Re-explain (simpler, more detail, a specific request) has shipped on top of it. Backend in `backend/app/api/routes/explain.py` (contract: `docs/explain-api.md`), extension in `extension/explain/` and `extension/lib/geometry.js`. Deploying needs `pip install -r requirements.txt` (boto3, pypdf), migrations through `0005_reexplain` (the Docker image runs `alembic upgrade head` on start) and, for thumbnails, the `EXPLAIN_STORAGE_*` env vars.

## Direction

Synapse explains what the user points at. Highlight and circle capture feed one pipeline, one endpoint, and one bottom-right panel.

Whole-page rebuilding (section mode, full-page reformat) is parked. Keep the code, hide its entry points behind a flag. See [Parked: Article mode](#parked-article-mode).

## Current code this builds on

- `extension/content.js`: section mode (`activateSectionMode`, `renderAISections`, `openCard`), full-page mode (`activateFullPage`), document reader (`activateDocumentMode`), floating button and panel (`buildFloatingUI`, `sp-main-btn`).
- `extension/background.js`: all API calls go through the service worker, so in-flight requests survive page navigation.
- `backend/app/api/routes/reformat.py:206`: tier routing, `provider = "claude" if is_premium else "gemini"`.
- `backend/app/services/rate_limit.py`: Redis-backed limits. Free 100/day plus 500 lifetime, Lite 300/month, per-IP daily cap.
- `ai_usage_events` table (migration `0002_observer_audit_and_ai_usage.py`), provider is `gemini` or `claude`.
- Tiers in code: `free`, `lite`, `premium`, `institutional`.

## Decisions

| Topic | Decision |
|---|---|
| Inputs | Highlight-to-explain and circle-to-explain (`Alt + S`) |
| Floating button | On document pages, clicking it opens a prompt: "Circle something" or "Read this document". On every other page, clicking it starts circle mode directly. It is the chord-free way to start circle mode, so it is required, not optional |
| Document reader | Stays visible and is not parked. Reached from the floating button prompt |
| Empty circle | No readable text and the screenshot failed: show "Couldn't read that area, try circling again" in the panel and charge no quota |
| Result UI | Bottom-right panel holds explanations and history |
| Source marking | Explained text turns Synapse green; source briefly pulses when its result arrives |
| Return to source | Clicking a history entry scrolls back to its source and emphasizes it. Respect `prefers-reduced-motion` |
| Model routing | Same as reformat: premium on Claude, others on Gemini. Both accept images |
| Circle payload | Always send the hull-masked crop plus the DOM text inside the hull (v1) |
| Text explain limits | Count against the existing reformat quota, one explain = one reformat |
| Image capture limits | Free 5/day, Lite ("basic") 100/month, Premium and institutional unlimited |
| Mixed circles | A circle sending crop plus text counts once, as an image capture |
| Circle confirm step | After a circle, show a preview of the exact masked crop with Confirm (Enter), Retry (R) and Cancel (Esc). Nothing is sent and no quota is used until Confirm |
| Context | Explains carry local context (always) and page or document context (when allowed). See [Context](#context) |
| Context quota | A text explain with page or document context costs 4 reformats. Local-only costs 1. A circle stays at 1 image capture with or without context |
| Context privacy | Normal sites: local + page context, with a "Use page context" On/Off setting in the panel. Sensitive sites (email, messaging, banking): local context only by default |
| PDFs | Synapse opens PDFs in its own pdf.js viewer so highlight and circle both work, with the PDF as context |
| Image thumbnail retention | 30 days |
| Paid history | All paid tiers. Persisted per hostname, synced to the account across devices |
| Free history | 10 entries total across all sites |
| Navigation mid-request | Never cancel. Let the request finish and save it to history |
| Deleting history | Per entry and per site, plus "Clear all" on the dashboard. Hard delete |
| Multiple tabs | Background broadcasts new entries to open tabs on the same hostname. Other devices refresh when the panel opens |

## Pipeline

```
highlight / circle
  -> content.js builds payload { text?, image?, rect, anchor, pageTitle, url }
  -> background.js (crop + mask for circles) -> POST /api/v1/explain
  -> panel shows loading, then result
  -> history entry saved (server for paid, local for free)
  -> source painted green
```

### `/api/v1/explain`

- Accepts text, image, or both in one request, plus page title, URL, and the user's cognitive profile and session difficulty.
- Returns content for one panel entry, rendered with the existing profile-aware formatting (bionic reading, feedback strip).
- Records an `ai_usage_events` row. Telemetry and logs never store the image.

### Rate limits

- Text explains (highlights and text-only circles) go through the existing `check_rate_limit` and count exactly like reformats: free 100/day plus 500 lifetime, Lite 300/month.
- Image captures get their own Redis counter: free 5/day, Lite 100/month, Premium and institutional unlimited.
- A circle that sends a crop plus text counts once, as an image capture, and does not touch the reformat quota.
- A burst cap for everyone, including Premium and institutional (suggested 10/minute), to catch accidental spam and abuse of the unlimited tier.
- Re-opening an already-explained source (green highlight) shows the saved answer with no API call and no quota charge.

## Highlight-to-explain

1. On a text selection outside inputs and `contenteditable`, show a small bubble near it with the Synapse icon and a gentle pulse. Exact motion to be designed.
2. Clicking the bubble opens the panel in a loading state and sends the selected text.
3. After the click, the selection is painted Synapse green.
4. Keyboard-only users can select text and trigger the bubble, so this path covers people who can't use the circle gesture.

## Circle-to-explain

### Gesture

- Hold `Alt + S`, move the pointer (no button pressed) to trace, release to finish. Hover tracing avoids Linux window managers' Alt+drag.
- Match `e.code === 'KeyS'`, not `e.key` (Option+S on macOS gives "ß"). Ignore `e.repeat`.
- Finish when either key is released. The confirm step follows; recognition starts on Confirm, not on key-up.
- Ignore the chord while focus is in an input, textarea, select, or `contenteditable`.
- Cancel on `blur`, `visibilitychange`, and `scroll`, and remove the overlay.
- `chrome.commands` can't report key-up, so it can't drive hold-to-draw. Content-script key events only.
- Clicking the floating button (or choosing "Circle something" on document pages) starts the same mode without the chord (click to start, trace, click to finish).

### Selection

- Draw a live trace in an overlay. Compute the convex hull of the recorded points, which handles open or rough shapes.
- Text: walk text nodes under elements intersecting the hull's bounding box, call `Range.getClientRects()`, and keep text whose rects fall inside the hull polygon.
- Keep a reference to the source elements, or the captured rectangle when nothing maps to the DOM (canvas, cross-origin iframes).

### Screenshot

- `content.js` sends the rect and hull to `background.js`, which calls `chrome.tabs.captureVisibleTab`.
- Hide the overlay and wait two `requestAnimationFrame` ticks before capturing.
- Scale coordinates by `devicePixelRatio`. Crop with `OffscreenCanvas` and clip to the hull polygon so only circled pixels leave the browser.
- `captureVisibleTab` is limited to about 2 calls per second. Debounce.
- Cross-origin iframes (embedded tweets, videos): no DOM text, but the crop still works, so these fall back to image-only.

### Confirm step

- When tracing ends, take the screenshot and build the masked crop as usual, but don't send it.
- Show a small bar anchored next to the circled area (kept inside the viewport) with a preview of the exact crop that would be sent, and three buttons: **Confirm** (Enter), **Retry** (R), **Cancel** (Esc).
- Confirm sends the already-captured crop and text. It never takes a second screenshot.
- Retry discards the crop and immediately starts a new trace in the same mode (chord or click-to-trace).
- Cancel discards everything and restores the page.
- No quota is charged and nothing leaves the browser before Confirm.
- Keep the circled outline visible behind the bar so the user can see what they picked. Focus moves to Confirm; the bar is keyboard reachable and announced to screen readers.
- If the screenshot failed but text was found, the preview shows the text snippet instead and Confirm sends it as a text explain. If both failed, show the "Couldn't read that area" message with Retry and Cancel only.

## Context

Explanations should say what the selection means where it is, not just in general.

### Local context (always sent, small)

- Heading path down to the selection, e.g. `Settings › Connected accounts › Chase Checking`.
- The paragraph or block around the selection, plus a little before and after (about 2,000 chars).
- For buttons, links and inputs: accessible name, `aria-label`, `title` or tooltip text, associated `<label>`, the containing form (its heading and field names), the menu or toolbar it belongs to, and a link's destination.
- A circle uses the main element inside the circled area.

### Page context (normal sites, setting on)

- Page title, site name, meta description.
- Outline of the main headings.
- A slice of the main content centred on the selection, about 6,000-8,000 chars.

### Document context

- Text, CSV and Markdown files: the whole file's text.
- PDFs: the PDF, opened in Synapse's viewer.
- Inside Synapse's document reader: the original document. Highlighting inside the reader is allowed even though it's Synapse UI.
- Uploaded once per document to `POST /explain/context`, which extracts the text and keeps it in Redis for about an hour. Later explains send only the `context_id`. When the document is too big, the backend picks the passages most relevant to the selection. Never stored in the database.

### Why not let the model fetch the URL

Gemini's URL context and Claude's web fetch only see the public, logged-out page: no dashboards, email, paywalled articles or app state. The extension already has the page the user is looking at. URL fetching may come later as a fallback for thin public pages; it is not in v1.

### Privacy

- Sensitive sites (email, messaging, banking, by domain list) send local context only, unless the user turns page context on for that site.
- The panel has a "Use page context" On/Off setting.
- The model is told context is background, not the thing to explain, and the prompt-injection rules cover it.

### Quota

- Text explain with page or document context: 4 reformats.
- Text explain with local context only: 1 reformat.
- Circle: 1 image capture, with or without context.
- If a user has fewer than 4 reformats left, the request is refused with a code the extension uses to offer "Explain without page context" (costs 1).

## Synapse PDF viewer

- Built on pdf.js (the engine Firefox uses), bundled in the extension.
- On PDF pages, the floating button prompt offers "Open in Synapse viewer", "Circle something" and "Read this document".
- The viewer page loads the explain scripts directly (content scripts don't run on extension pages), so highlight, circle, the panel and history all work there, with the PDF as document context.
- History and green highlights use the original PDF URL, not the viewer URL.
- Limits: scanned PDFs have no text layer, so only circling works; password-protected PDFs ask for the password; local `file://` PDFs need Chrome's "Allow access to file URLs" for the extension.
- Local files (`file://`): content scripts run there too, so the floating button works on local PDFs, text, CSV and Markdown files. The service worker can't read `file://`, so the page hands over the file: text pages send their text, and the viewer sends the PDF bytes it loaded. On a local PDF, "Read this document" opens the Synapse viewer with the reader open (`read=1`, dropped after use). History works like any other site: local files are grouped as one site, `local-files` (free users: local, counted in the 10; paid users: synced). Clicking a local entry reopens the file, PDFs in the Synapse viewer.

## Floating button

- On document pages (PDF, text, CSV, Markdown, as detected by `detectDocumentType`), clicking the floating button opens a small two-option prompt next to it: "Circle something" and "Read this document".
- On every other page there is no prompt: clicking the floating button starts circle mode directly.
- "Circle something" starts click-to-trace circle mode.
- "Read this document" runs the existing document reader (`activateDocumentMode`).
- The prompt replaces the current panel's "Activate on this page" / "Reformat full page" button (`sp-main-btn`), which is hidden with the rest of Article mode.
- Keyboard accessible: focusable options, `Escape` closes the prompt.

## Panel and history

### Panel

- Bottom-right. Shows loading, then the explanation. Scrolls back through history for the current site.
- Entries show their type (text or circled image), a thumbnail for images, and a timestamp.
- Clicking an entry scrolls to its source if it's on the current page, otherwise opens its URL.

### Paid history (lite, premium, institutional)

- Server-side `explanation_history` table: user id, hostname, full URL, kind (text or image), source text, anchor data, image thumbnail reference, result, created at.
- Endpoints: `GET /explain/history?domain=`, `POST` (written by `/explain`), `DELETE /explain/history/{id}`, `DELETE /explain/history?domain=`.
- Images: store a small thumbnail (about 400px WebP) in object storage, not Postgres. Deleted after 30 days, or immediately when the entry is deleted. The text result stays in history after the thumbnail expires.
- Group by hostname, so `mail.google.com` and `docs.google.com` stay separate.

### Free history

- 10 entries total across all sites, oldest dropped first.
- Stored in `chrome.storage.local`. Not synced, no server copy.

### Restoring green highlights

- Store the selected text plus a short prefix and suffix with each entry. On page load, search for it and skip quietly if the page changed.
- Paint with the CSS Custom Highlight API (`CSS.highlights`) rather than wrapping text in spans, so the host page's DOM is untouched.
- Circled images: outline the source element if it can be found again.

### Navigation and tabs

- Requests finish in the service worker even if the page navigates. The result lands in history and shows when the panel next opens on that site.
- New entries are broadcast to open tabs on the same hostname.

## Build order

1. `/api/v1/explain` (text and image, profile-aware, usage-tracked, separate rate limits) and the flag that hides rebuild mode.
2. Bottom-right panel with loading state and entries.
3. Highlight-to-explain with green highlighting. This tests steps 1 and 2 end to end.
4. Circle capture: gesture, overlay, hull, text in polygon, cancellation, "Circle something" button.
5. Screenshot capture, crop and hull mask in the background script.
6. History: free local cap, paid server table and endpoints, deletion, highlight restore, tab broadcast, return-to-source.

## Build order: context, confirm step, PDF viewer

1. Confirm step for circles.
2. Local and page context collection in the extension, with sensitive-site rules and the "Use page context" setting.
3. Backend: `context` on `/explain`, explain-in-context prompt, 4-reformat charging, `QUOTA_INSUFFICIENT_FOR_CONTEXT`.
4. Backend: `POST /explain/context`, Redis document cache, PDF text extraction, passage selection, `context_id` on `/explain`.
5. Extension: document context for text files and the reader, highlight inside the reader.
6. Synapse PDF viewer with explain inside it.

## Open questions

None at the moment.

## Limitations

- Nothing runs on `chrome://` pages or in Chrome's built-in PDF viewer.
- Content script runs in the top frame only.
- Closed shadow roots, canvas-rendered text, and virtualized content outside the viewport are not readable as DOM text. The crop still covers what's visible.

## Parked: Article mode

Revisit after the explain flow ships.

- Replace the AI-rewrites-sections approach with DOM block IDs: send numbered snippets, get block IDs back, wrap the real DOM ranges. Removes the heading/Dice/even-distribution guessing in `renderAISections`.
- Only offer it on pages that pass a readability check: a `main`/`article` landmark, enough text compared to interactive elements, little `contenteditable`.
- Wait for the DOM to settle with a debounced `MutationObserver` (about 500-1000 ms, with a maximum wait) before extracting.
- Domain blocklist for high-risk sites (messaging, email, banking) to hide the floating button.
