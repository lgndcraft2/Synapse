// Pure geometry/history and context helpers shared with the content scripts.
importScripts("lib/geometry.js", "explain/context.js");
const G = self.SynapseGeometry;
const CX = self.SynapseContext;

const defaultProfile = {
  preferredFormat: "bullet points",
  chunkSize: "short",
  needsExamplesFirst: true,
  maxNestingDepth: 2,
  useHeaders: true,
  simplifyVocab: false,
  profileType: "load-reducer",
  notes: ""
};

const defaultProviderConfig = {
  tier: "free",
  backendBaseUrl: "http://localhost:8000",
  backendAccessToken: "",
  useBackendProxy: true,
  preferredProvider: "auto",
  freeDailyLimit: 40
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

async function getClientFingerprint() {
  const result = await storageGet("synapseFingerprint");
  if (result.synapseFingerprint) return result.synapseFingerprint;

  const generated = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fingerprint = `ext-${generated}`;
  await storageSet({ synapseFingerprint: fingerprint });
  return fingerprint;
}

// ── Synapse session (handed off from the dashboard) ──────────────
// The dashboard pushes the logged-in session here via onMessageExternal, so the
// user never has to paste a token. The extension refreshes the token itself
// against our own API — it no longer receives any API key.

const SESSION_KEY = "synapseSession";

async function getStoredSession() {
  const stored = await storageGet(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function clearStoredSession() {
  return new Promise(resolve => chrome.storage.local.remove(SESSION_KEY, resolve));
}

// Only one refresh may be in flight at a time. The backend rotates the refresh
// token on every use and treats a second presentation of a spent token as
// theft, revoking the whole session family — and several callers below reach
// getValidAccessToken() concurrently. Without this mutex two of them would
// present the same token and sign the user out for no reason.
let refreshInFlight = null;

async function doRefresh(session) {
  const url = normalizeBackendBaseUrl(session.api_url);
  if (!url || !session.refresh_token) return null;

  let response;
  try {
    response = await fetch(`${url}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
  } catch {
    // Network failure: the session may still be good, so keep it and retry later.
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    // Terminal. Previously this kept the dead session forever, so the popup
    // showed "not signed in" while storage still held it — and under the new
    // backend every retry of a revoked token looks like an attack.
    await clearStoredSession();
    return null;
  }
  if (!response.ok) return null;

  const data = await response.json().catch(() => null);
  if (!data?.access_token || !data?.refresh_token) return null;

  const expiresAt = data.expires_at
    ? data.expires_at
    : Math.floor(Date.now() / 1000) + (data.expires_in || 900);

  const updated = {
    ...session,
    access_token: data.access_token,
    // Always the new one. The old `data.refresh_token || session.refresh_token`
    // fallback would silently re-present a spent token, which is exactly what
    // reuse detection revokes the family for.
    refresh_token: data.refresh_token,
    expires_at: expiresAt
  };
  await storageSet({ [SESSION_KEY]: updated });
  return updated;
}

function refreshSession(session) {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(session).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function getValidAccessToken() {
  const session = await getStoredSession();
  if (session?.access_token) {
    const now = Math.floor(Date.now() / 1000);
    // Refresh a minute before expiry to avoid using a just-expired token.
    // A missing expires_at counts as expired: treating it as "never expires"
    // was a Supabase-era accommodation that left dead tokens in use.
    if (session.expires_at && session.expires_at - 60 > now) {
      return session.access_token;
    }
    const refreshed = await refreshSession(session);
    if (refreshed?.access_token) return refreshed.access_token;
    return null; // refresh failed — fall back to anonymous behaviour
  }

  // Legacy fallback: a manually pasted token (deprecated by the dashboard handoff).
  const { providerConfig } = await storageGet("providerConfig");
  return providerConfig?.backendAccessToken || null;
}

// Decode a JWT payload (no verification — used only to read display claims).
function decodeJwtPayload(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// Returns { authenticated, name, email } derived from the current access token.
async function getAuthStatus() {
  const token = await getValidAccessToken();
  if (!token) return { authenticated: false };
  const payload = decodeJwtPayload(token) || {};
  // Our tokens carry flat `name` and `email` claims. The user_metadata
  // fallbacks are Supabase's envelope shape, kept only so an extension build
  // that ships ahead of the backend still renders a name instead of blank.
  const meta = payload.user_metadata || {};
  const email = payload.email || meta.email || null;
  const name = payload.name || meta.full_name || meta.name || (email ? email.split("@")[0] : null);
  return { authenticated: true, name, email };
}

async function resolvedBackendBaseUrl() {
  const { providerConfig } = await storageGet("providerConfig");
  return normalizeBackendBaseUrl(
    (providerConfig && providerConfig.backendBaseUrl) || defaultProviderConfig.backendBaseUrl
  );
}

// ── Profile <-> backend mapping ──────────────────────────────────
function profileFromBackend(p) {
  return {
    profileType: p.profile_type,
    preferredFormat: p.preferred_format,
    chunkSize: p.chunk_size,
    needsExamplesFirst: p.needs_examples_first,
    simplifyVocab: p.simplify_vocab,
    maxNestingDepth: p.max_nesting_depth,
    useHeaders: p.use_headers,
    notes: p.notes || ""
  };
}

function profileToBackend(profile) {
  return {
    profile_type: profile.profileType,
    preferred_format: profile.preferredFormat,
    chunk_size: profile.chunkSize,
    needs_examples_first: profile.needsExamplesFirst,
    simplify_vocab: profile.simplifyVocab,
    max_nesting_depth: profile.maxNestingDepth,
    use_headers: profile.useHeaders,
    notes: profile.notes
  };
}

async function fetchAndStoreProfile() {
  const token = await getValidAccessToken();
  if (!token) return null;
  const baseUrl = await resolvedBackendBaseUrl();
  if (!baseUrl) return null;

  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data) return null;

  const local = profileFromBackend(data);
  await storageSet({ cognitiveProfile: { ...defaultProfile, ...local } });
  return local;
}

async function patchBackendProfile(profile, token) {
  const baseUrl = await resolvedBackendBaseUrl();
  if (!baseUrl) throw new Error("Backend API URL is not configured.");
  const response = await fetch(`${baseUrl}/api/v1/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(profileToBackend(profile))
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Profile sync failed with HTTP ${response.status}`);
  }
  return response.json();
}

const FEEDBACK_REACTIONS = new Set(["clearer", "complex", "simple", "off-topic"]);

// Clamped to the backend schema: these entries also ride along on anonymous
// explain/reformat calls, where one out-of-range legacy value would 422 the
// whole request.
function toBackendFeedbackEntry(entry) {
  const num = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : null);
  const reaction = entry.reaction;
  return {
    reaction: FEEDBACK_REACTIONS.has(reaction) ? reaction : null,
    note: String(entry.note || "").slice(0, 500),
    time_spent_seconds: num(entry.timeSpentSeconds ?? entry.time_spent_seconds, 86400),
    read_progress: num(entry.readProgress ?? entry.read_progress, 100),
    session_difficulty: String(entry.sessionDifficulty || entry.session_difficulty || "normal").slice(0, 20),
    section_title: entry.sectionTitle || entry.section_title
      ? String(entry.sectionTitle || entry.section_title).slice(0, 200)
      : null
  };
}

async function getFullConfig() {
  const result = await storageGet(["cognitiveProfile", "feedbackLog", "providerConfig", "providerUsage", "premiumActive"]);
  const providerConfig = { ...defaultProviderConfig, ...(result.providerConfig || {}) };
  if (result.premiumActive) providerConfig.tier = "premium";
  
  const profile = { ...defaultProfile, ...(result.cognitiveProfile || {}) };
  // Mapping camelCase to snake_case for the backend schema
  const backendProfile = {
    profile_type: profile.profileType,
    preferred_format: profile.preferredFormat,
    chunk_size: profile.chunkSize,
    needs_examples_first: profile.needsExamplesFirst,
    simplify_vocab: profile.simplifyVocab,
    max_nesting_depth: profile.maxNestingDepth,
    use_headers: profile.useHeaders,
    notes: profile.notes
  };

  return {
    profile: backendProfile,
    feedbackLog: result.feedbackLog || [],
    providerConfig,
    providerUsage: result.providerUsage || {}
  };
}

async function recordProviderUse(provider) {
  const { providerUsage = {} } = await storageGet("providerUsage");
  const key = todayKey();
  const day = providerUsage[key] || { requests: 0, providers: {} };
  day.requests += 1;
  day.providers[provider] = (day.providers[provider] || 0) + 1;
  await storageSet({ providerUsage: { ...providerUsage, [key]: day } });
}

function normalizeBackendBaseUrl(raw) {
  return (raw || "").trim().replace(/\/+$/, "");
}

async function callBackendReformat(pageText, profile, providerConfig, options = {}) {
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  if (!baseUrl) throw new Error("Backend API URL is not configured.");

  const fingerprint = await getClientFingerprint();
  const token = await getValidAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/v1/reformat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      page_text: pageText,
      page_url: options.pageUrl || "",
      page_title: options.pageTitle || "",
      session_difficulty: options.sessionDifficulty || "normal",
      mode: options.mode || "cards",
      fingerprint,
      // Authenticated users use their server-side (dashboard) profile and
      // feedback; only send the local copies for anonymous callers.
      ...(token ? {} : { profile, recent_feedback: await recentFeedbackForBackend() })
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return { error: data?.detail || `Backend reformat failed with HTTP ${response.status}` };
  }

  await recordProviderUse(data?.model_used || "backend");
  return {
    html: data.html || "",
    questions: data.questions || null,
    modelUsed: data.model_used || "backend"
  };
}

async function callBackendAnalyseSections(pageText, profile, providerConfig) {
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  if (!baseUrl) throw new Error("Backend API URL is not configured.");

  const fingerprint = await getClientFingerprint();
  const token = await getValidAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/v1/reformat/analyse-sections`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page_text: pageText, fingerprint, ...(token ? {} : { profile }) })
  });

  const data = await response.json();
  if (!response.ok) {
    return { error: data?.detail || "Section analysis failed." };
  }
  return { sections: data.sections };
}

async function callBackendDocument(base64Data, mediaType, profile, providerConfig, sessionDifficulty = "normal") {
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  if (!baseUrl) throw new Error("Backend API URL is not configured.");

  const fingerprint = await getClientFingerprint();
  const token = await getValidAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/v1/reformat/reformat-document`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      base64_data: base64Data,
      media_type: mediaType,
      session_difficulty: sessionDifficulty,
      fingerprint,
      ...(token ? {} : { profile, recent_feedback: await recentFeedbackForBackend() })
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return { error: data?.detail || "Document reformatting failed." };
  }
  return { html: data.html };
}

async function getBackendBillingStatus(providerConfig) {
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  const token = await getValidAccessToken();
  if (!baseUrl || !token) {
    return { configured: Boolean(baseUrl), authenticated: false };
  }

  const response = await fetch(`${baseUrl}/api/v1/billing/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.detail || `Billing status failed with HTTP ${response.status}`);
  }

  return { configured: true, authenticated: true, ...data };
}

// ── Feedback log ─────────────────────────────────────────────────
// Every reaction is kept locally (last 50). Entries are marked `synced: false`
// until the server accepts them, so feedback given while signed out or
// offline reaches the account on the next successful sync. Entries without
// the flag predate it and were already sent (or never will be); they are not
// resent. All reads and writes go through one queue so a sync marking entries
// can't overwrite a reaction added meanwhile.

const FEEDBACK_LOG_MAX = 50;
let feedbackQueue = Promise.resolve();

function withFeedbackLog(fn) {
  const run = feedbackQueue.then(fn);
  feedbackQueue = run.catch(() => {});
  return run;
}

function recordFeedback(entry) {
  return withFeedbackLog(async () => {
    const { feedbackLog = [] } = await storageGet("feedbackLog");
    feedbackLog.push({ ...entry, synced: false });
    await storageSet({ feedbackLog: feedbackLog.slice(-FEEDBACK_LOG_MAX) });
  });
}

/** The local log as backend entries, for anonymous explain/reformat calls. */
async function recentFeedbackForBackend() {
  const { feedbackLog = [] } = await storageGet("feedbackLog");
  return feedbackLog.slice(-20).map(toBackendFeedbackEntry);
}

async function syncPendingFeedback() {
  const baseUrl = await resolvedBackendBaseUrl();
  const token = await getValidAccessToken();
  if (!baseUrl || !token) return { synced: false };

  const { feedbackLog = [] } = await storageGet("feedbackLog");
  const pending = feedbackLog.filter(e => e.synced === false);
  if (!pending.length) return { synced: true };

  const response = await fetch(`${baseUrl}/api/v1/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      entries: pending.map(toBackendFeedbackEntry),
      fingerprint: await getClientFingerprint()
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Feedback sync failed with HTTP ${response.status}`);
  }
  const data = await response.json().catch(() => null);

  const sent = new Set(pending.map(e => e.ts));
  await withFeedbackLog(async () => {
    const { feedbackLog: latest = [] } = await storageGet("feedbackLog");
    await storageSet({
      feedbackLog: latest.map(e => (e.synced === false && sent.has(e.ts) ? { ...e, synced: true } : e))
    });
  });

  // The server nudged the profile after consistent feedback: pull it so the
  // popup and anonymous fallbacks match, and let the popup say what changed.
  if (data?.profile_update) {
    await fetchAndStoreProfile();
    await storageSet({
      pendingProfileUpdate: { message: data.profile_update.message, at: Date.now() }
    });
  }
  return { synced: true, profileUpdate: data?.profile_update || null };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ================================================================
// EXPLAIN (highlight / circle) — see docs/explain-api.md
// ================================================================

const LOCAL_HISTORY_KEY = "explainHistoryLocal";
const LOCAL_HISTORY_MAX = 10;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 200 * 1024;
const MAX_CROP_SIDE = 2048;
const THUMB_SIDE = 400;
// Chrome allows ~2 captureVisibleTab calls per second per extension.
const CAPTURE_MIN_INTERVAL_MS = 600;

let captureChain = Promise.resolve();
let lastCaptureAt = 0;

/** Serialises captureVisibleTab calls and spaces them out to respect the quota. */
function captureVisibleTabThrottled(windowId) {
  const run = async () => {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } finally {
      lastCaptureAt = Date.now();
    }
  };
  const result = captureChain.then(run, run);
  captureChain = result.catch(() => {});
  return result;
}

async function blobToBase64(blob) {
  return arrayBufferToBase64(await blob.arrayBuffer());
}

/** Encodes as WebP, falling back to JPEG when the encoder is unavailable. */
async function encodeCanvas(canvas, quality) {
  let blob = await canvas.convertToBlob({ type: "image/webp", quality });
  if (blob.type !== "image/webp") blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return blob;
}

/**
 * Captures the visible tab and returns the hull-masked crop plus a thumbnail.
 * Pixels outside the hull are painted white so nothing outside the user's
 * circle leaves the browser, and every model reads the background the same way.
 */
async function captureCircleCrop(windowId, capture) {
  const hull = Array.isArray(capture?.hull) ? capture.hull : [];
  if (hull.length < 3) throw new Error("No selection polygon.");

  const dataUrl = await captureVisibleTabThrottled(windowId);
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

  // Prefer the measured ratio between screenshot and viewport: it already
  // includes browser zoom. devicePixelRatio is the fallback.
  const viewportWidth = capture.viewport?.width;
  const scale = viewportWidth ? bitmap.width / viewportWidth : (capture.devicePixelRatio || 1);

  const box = G.bbox(hull);
  const crop = G.scaleAndClampRect(box, scale, bitmap.width, bitmap.height);
  if (crop.width < 4 || crop.height < 4) throw new Error("Selection is outside the visible area.");

  const out = G.fitWithin(crop.width, crop.height, MAX_CROP_SIDE);
  const canvas = new OffscreenCanvas(out.width, out.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.save();
  ctx.beginPath();
  hull.forEach((p, i) => {
    const x = (p.x * scale - crop.x) * out.scale;
    const y = (p.y * scale - crop.y) * out.scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
  ctx.restore();
  bitmap.close?.();

  let quality = 0.85;
  let blob = await encodeCanvas(canvas, quality);
  while (blob.size > MAX_IMAGE_BYTES && quality > 0.4) {
    quality -= 0.15;
    blob = await encodeCanvas(canvas, quality);
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("Selection is too large to send.");

  const t = G.fitWithin(out.width, out.height, THUMB_SIDE);
  const thumbCanvas = new OffscreenCanvas(t.width, t.height);
  thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  // The backend only accepts a real WebP thumbnail (RIFF/WEBP). If the
  // encoder falls back to another format, send no thumbnail at all.
  let thumbQuality = 0.75;
  let thumbBlob = await thumbCanvas.convertToBlob({ type: "image/webp", quality: thumbQuality });
  while (thumbBlob.type === "image/webp" && thumbBlob.size > MAX_THUMB_BYTES && thumbQuality > 0.3) {
    thumbQuality -= 0.15;
    thumbBlob = await thumbCanvas.convertToBlob({ type: "image/webp", quality: thumbQuality });
  }
  const thumbOk = thumbBlob.type === "image/webp" && thumbBlob.size <= MAX_THUMB_BYTES;
  const thumbBase64 = thumbOk ? await blobToBase64(thumbBlob) : null;

  return {
    base64: await blobToBase64(blob),
    mediaType: blob.type,
    thumbBase64,
    thumbDataUrl: thumbBase64 ? `data:${thumbBlob.type};base64,${thumbBase64}` : null
  };
}

// ── Circle confirm step: crops wait here until Confirm ───────────
// The crop never leaves the browser before Confirm. MV3 suspends an idle
// service worker after ~30 s, so a user who looks at the preview for longer
// would lose an in-memory crop. chrome.storage.session (in memory, survives
// worker suspension, cleared when the browser closes, ~10 MB) is the source of
// truth; the Map is only a fast path while this worker instance lives.
// Expired or missing -> Confirm reports CAPTURE_EXPIRED and the user circles
// again (never a silent recapture: the page may have changed).
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CAPTURES = 4;
const CAPTURE_KEY_PREFIX = "pendingCapture:";
const pendingCaptures = new Map(); // id -> { crop, tabId, createdAt, expiresAt }
let captureStoreChain = Promise.resolve();

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)}`;
}

/** Serialises capture-store mutations so pruning and the cap see a consistent view. */
function withCaptureStore(fn) {
  const result = captureStoreChain.then(fn, fn);
  captureStoreChain = result.catch(() => {});
  return result;
}

function captureKey(id) {
  return CAPTURE_KEY_PREFIX + id;
}

function sessionArea() {
  try { return chrome.storage.session || null; } catch { return null; }
}

/** All stored capture records as [{ id, rec }], oldest first. */
async function listStoredCaptures() {
  const area = sessionArea();
  if (!area) return [];
  let all = {};
  try { all = (await area.get(null)) || {}; } catch { return []; }
  return Object.keys(all)
    .filter(k => k.startsWith(CAPTURE_KEY_PREFIX) && all[k])
    .map(k => ({ id: k.slice(CAPTURE_KEY_PREFIX.length), rec: all[k] }))
    .sort((a, b) => (a.rec.createdAt || 0) - (b.rec.createdAt || 0));
}

async function removeStoredCaptures(ids) {
  if (!ids.length) return;
  for (const id of ids) pendingCaptures.delete(id);
  const area = sessionArea();
  if (!area) return;
  try { await area.remove(ids.map(captureKey)); } catch { /* best effort */ }
}

/** Drops expired captures (memory and storage). Returns the live stored list, oldest first. */
async function pruneCaptures() {
  const now = Date.now();
  for (const [id, rec] of pendingCaptures) if (rec.expiresAt <= now) pendingCaptures.delete(id);
  const stored = await listStoredCaptures();
  const expired = stored.filter(s => !(s.rec.expiresAt > now)).map(s => s.id);
  await removeStoredCaptures(expired);
  return stored.filter(s => s.rec.expiresAt > now);
}

function isQuotaError(err) {
  return /quota/i.test(String(err?.message || err || ""));
}

function dropCapture(id) {
  if (!id) return Promise.resolve();
  pendingCaptures.delete(id);
  return withCaptureStore(() => removeStoredCaptures([id]));
}

/**
 * Stores a crop until Confirm and returns its id. Keeps at most
 * MAX_PENDING_CAPTURES (oldest dropped). If session storage is full even after
 * dropping every older capture, the crop is kept in memory only: it works while
 * this worker lives and otherwise expires like any other capture.
 */
function storeCapture(crop, tabId) {
  return withCaptureStore(async () => {
    const live = await pruneCaptures();
    const id = newId("cap");
    const now = Date.now();
    // thumbDataUrl duplicates thumbBase64; rebuilt on take to save quota.
    const { thumbDataUrl, ...slim } = crop;
    const rec = { crop: slim, tabId: tabId ?? null, createdAt: now, expiresAt: now + CAPTURE_TTL_MS };

    const older = live.map(s => s.id);
    for (const memId of pendingCaptures.keys()) if (!older.includes(memId)) older.push(memId);
    while (older.length >= MAX_PENDING_CAPTURES) await removeStoredCaptures([older.shift()]);

    pendingCaptures.set(id, rec);
    setTimeout(() => { const r = pendingCaptures.get(id); if (r && r.expiresAt <= Date.now()) pendingCaptures.delete(id); }, CAPTURE_TTL_MS + 50);

    const area = sessionArea();
    if (!area) return id;
    for (;;) {
      try {
        await area.set({ [captureKey(id)]: rec });
        return id;
      } catch (err) {
        if (!isQuotaError(err) || !older.length) return id; // memory-only fallback
        await removeStoredCaptures([older.shift()]);
      }
    }
  });
}

/** Returns and forgets the crop, or null when it expired, is gone, or belongs to another tab. */
function takeCapture(id, tabId) {
  return withCaptureStore(async () => {
    if (!id) return null;
    let rec = pendingCaptures.get(id) || null;
    if (!rec) {
      const area = sessionArea();
      if (area) {
        try { rec = (await area.get(captureKey(id)))?.[captureKey(id)] || null; } catch { rec = null; }
      }
    }
    await removeStoredCaptures([id]);
    if (!rec || !(rec.expiresAt > Date.now())) return null;
    if (rec.tabId != null && tabId != null && rec.tabId !== tabId) return null;
    const crop = { ...rec.crop };
    crop.thumbDataUrl = crop.thumbBase64 ? `data:image/webp;base64,${crop.thumbBase64}` : null;
    return crop;
  });
}

// A restarted worker clears what expired while it was suspended.
pruneCaptures().catch(() => {});

async function handleCaptureRegion(msg, sender) {
  if (!sender.tab) return { ok: true, captureId: null, hasImage: false };
  try {
    const crop = await captureCircleCrop(sender.tab.windowId, msg.capture);
    const captureId = await storeCapture(crop, sender.tab.id);
    return {
      ok: true,
      captureId,
      hasImage: true,
      // Exactly what Confirm would send: the masked crop itself.
      preview: `data:${crop.mediaType};base64,${crop.base64}`
    };
  } catch {
    return { ok: true, captureId: null, hasImage: false };
  }
}

// ── Document context (POST /explain/context) ─────────────────────
// One upload per document URL; later explains send the context_id. Cached in
// memory and chrome.storage.session (survives worker suspension, not restarts).
const DOC_CONTEXT_KEY = "explainDocContexts";
const DOC_TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown"]);
const MAX_DOC_TEXT_CHARS = 2000000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// Failed uploads (503, burst cap, fetch errors) are not retried for a while,
// so a down Redis or missing PDF support doesn't burn the burst cap per explain.
const DOC_FAILURE_RETRY_MS = 2 * 60 * 1000;
const docContextMem = new Map(); // key -> { contextId, chars, expiresAt, failed? }
const docUploads = new Map();    // key -> Promise
// Bytes/text for local (file://) documents, handed over by the page because
// the worker can't read file:// itself. Kept so a re-upload after
// CONTEXT_EXPIRED still works while the worker stays alive.
const localDocData = new Map();  // key -> { base64?, text? }

function docKey(doc) {
  return `${G.pageKey(doc.url)}|${doc.mediaType}`;
}

function sessionGet(key) {
  return new Promise(resolve => {
    try { chrome.storage.session.get(key, r => resolve(r?.[key])); } catch { resolve(undefined); }
  });
}

function sessionSet(values) {
  return new Promise(resolve => {
    try { chrome.storage.session.set(values, () => resolve()); } catch { resolve(); }
  });
}

async function readDocCache(key) {
  let rec = docContextMem.get(key);
  if (!rec) {
    const all = (await sessionGet(DOC_CONTEXT_KEY)) || {};
    rec = all[key];
    if (rec) docContextMem.set(key, rec);
  }
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) { await writeDocCache(key, null); return null; }
  return rec;
}

async function writeDocCache(key, rec) {
  if (rec) docContextMem.set(key, rec); else docContextMem.delete(key);
  const all = (await sessionGet(DOC_CONTEXT_KEY)) || {};
  if (rec) all[key] = rec; else delete all[key];
  // Prune expired entries while we're here.
  for (const k of Object.keys(all)) if (!all[k] || all[k].expiresAt <= Date.now()) delete all[k];
  await sessionSet({ [DOC_CONTEXT_KEY]: all });
}

function normalizeDocMediaType(mediaType) {
  const mt = String(mediaType || "").toLowerCase().split(";")[0].trim();
  if (mt === "application/pdf" || DOC_TEXT_TYPES.has(mt)) return mt;
  if (mt.startsWith("text/")) return "text/plain";
  return null;
}

async function uploadDocumentContext(doc) {
  const { providerConfig } = await getFullConfig();
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  if (!baseUrl) return { ok: false, code: "NO_BACKEND" };

  const body = { media_type: doc.mediaType, source_url: doc.url || "", fingerprint: await getClientFingerprint() };
  try {
    if (doc.mediaType === "application/pdf" && doc.base64) {
      if (doc.base64.length * 0.75 > MAX_PDF_BYTES) return { ok: false, code: "TOO_LARGE" };
      body.document_base64 = doc.base64;
    } else if (doc.mediaType === "application/pdf") {
      const res = await fetch(doc.url);
      if (!res.ok) return { ok: false, code: "FETCH_FAILED" };
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_PDF_BYTES) return { ok: false, code: "TOO_LARGE" };
      body.document_base64 = arrayBufferToBase64(buf);
    } else {
      let text = typeof doc.text === "string" && doc.text ? doc.text : null;
      if (text == null) {
        const res = await fetch(doc.url);
        if (!res.ok) return { ok: false, code: "FETCH_FAILED" };
        text = await res.text();
      }
      body.document_text = text.slice(0, MAX_DOC_TEXT_CHARS);
    }
  } catch {
    return { ok: false, code: "FETCH_FAILED" };
  }

  const token = await getValidAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/explain/context`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return { ok: false, code: "NETWORK" };
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    return { ok: false, status: response.status, code: (detail && typeof detail === "object" && detail.code) || null };
  }
  if (!data?.context_id) return { ok: false, code: "BAD_RESPONSE" };
  return {
    ok: true,
    contextId: data.context_id,
    chars: Number(data.chars) || 0,
    truncated: !!data.truncated,
    expiresIn: Number(data.expires_in) || 3600
  };
}

/**
 * Returns { ok: true, contextId, chars } for a usable document context, or
 * { ok: false, code } when there is none (upload failed, or the document has
 * no text: scanned or password-protected PDFs come back with chars: 0, which
 * is cached so the same document isn't uploaded again).
 * opts.force skips the cache (after CONTEXT_EXPIRED). Never retries itself.
 */
async function ensureDocumentContext(rawDoc, opts = {}) {
  const mediaType = normalizeDocMediaType(rawDoc?.mediaType);
  if (!rawDoc?.url || !mediaType) return { ok: false, code: "UNSUPPORTED" };
  const doc = { url: String(rawDoc.url), mediaType, text: rawDoc.text, base64: rawDoc.base64 };
  const key = docKey(doc);
  if (doc.url.startsWith("file:")) {
    if (doc.base64 || doc.text) localDocData.set(key, { base64: doc.base64, text: doc.text });
    else Object.assign(doc, localDocData.get(key));
  }
  const handedOver = !!(rawDoc.base64 || rawDoc.text);

  if (!opts.force) {
    const cached = await readDocCache(key);
    if (cached && !(cached.failed && handedOver)) {
      if (cached.failed) return { ok: false, code: cached.code || "UNAVAILABLE", cached: true };
      if (!cached.chars) return { ok: false, code: "NO_TEXT", cached: true };
      return { ok: true, contextId: cached.contextId, chars: cached.chars, cached: true };
    }
  }
  if (docUploads.has(key)) return docUploads.get(key);

  const run = (async () => {
    const res = await uploadDocumentContext(doc);
    if (!res.ok) {
      await writeDocCache(key, { failed: true, code: res.code, expiresAt: Date.now() + DOC_FAILURE_RETRY_MS });
      return res;
    }
    // Refresh a minute early so a cached id is never presented right at expiry.
    const ttl = Math.max(60, res.expiresIn - 60) * 1000;
    await writeDocCache(key, { contextId: res.contextId, chars: res.chars, expiresAt: Date.now() + ttl });
    if (!res.chars) return { ok: false, code: "NO_TEXT" };
    return { ok: true, contextId: res.contextId, chars: res.chars };
  })();
  docUploads.set(key, run);
  try { return await run; } finally { docUploads.delete(key); }
}

async function contextSettings() {
  const { explainContextSettings } = await storageGet("explainContextSettings");
  return explainContextSettings || {};
}

/** Turns a FastAPI error body into copy the panel can show as-is. */
function explainErrorMessage(status, data) {
  const detail = data?.detail;
  const code = detail && typeof detail === "object" ? detail.code : null;
  if (code === "QUOTA_INSUFFICIENT_FOR_CONTEXT") {
    return {
      code,
      error: "You don't have enough explanations left to include page context (it counts as 4). You can still explain this with just the nearby text."
    };
  }
  if (code === "CONTEXT_EXPIRED") {
    return { code, error: "Synapse lost track of this document. Try again." };
  }
  if (code === "IMAGE_LIMIT") {
    return {
      code,
      error: "You've used all your circle captures for now. Highlighting text still works, or upgrade your plan for more captures."
    };
  }
  if (code === "EXPLAIN_BURST") {
    return { code, error: "That's a lot of explanations at once. Give it a minute, then try again." };
  }
  if (detail && typeof detail === "object" && detail.message) return { code, error: detail.message };
  if (typeof detail === "string" && detail) return { code: null, error: detail };
  if (Array.isArray(detail)) return { code: "INVALID_REQUEST", error: "Synapse couldn't read that request. Try again." };
  return { code: null, error: `Synapse couldn't explain that (HTTP ${status}). Try again.` };
}

// Local (free/anonymous) history: one key, at most 10 entries across all sites.
// Writes are chained so two requests finishing together cannot drop an entry.
let localHistoryChain = Promise.resolve();

function updateLocalHistory(mutator) {
  const run = async () => {
    const stored = await storageGet(LOCAL_HISTORY_KEY);
    const next = mutator(Array.isArray(stored[LOCAL_HISTORY_KEY]) ? stored[LOCAL_HISTORY_KEY] : []);
    await storageSet({ [LOCAL_HISTORY_KEY]: next });
    return next;
  };
  const result = localHistoryChain.then(run, run);
  localHistoryChain = result.catch(() => {});
  return result;
}

async function readLocalHistory(hostname) {
  const stored = await storageGet(LOCAL_HISTORY_KEY);
  const list = Array.isArray(stored[LOCAL_HISTORY_KEY]) ? stored[LOCAL_HISTORY_KEY] : [];
  return list.filter(e => !hostname || e.hostname === hostname).map(e => ({ ...e, source: "local" }));
}

// ── Synapse PDF viewer ───────────────────────────────────────────
const VIEWER_PATH = "viewer/viewer.html";

/** chrome-extension://…/viewer/viewer.html?file=<pdf> for an http(s)/file PDF URL, or null. */
function viewerUrlFor(rawUrl, opts = {}) {
  let u;
  try { u = new URL(String(rawUrl || "")); } catch { return null; }
  if (!/^(https?|file):$/.test(u.protocol)) return null;
  // read=1 opens the document reader once the PDF has loaded.
  return `${chrome.runtime.getURL(VIEWER_PATH)}?file=${encodeURIComponent(u.href)}${opts.read ? "&read=1" : ""}`;
}

/** The URL a tab's explain history belongs to: the original PDF for viewer tabs. */
function documentUrlOfTab(tabUrl) {
  const viewer = chrome.runtime.getURL(VIEWER_PATH);
  if (!tabUrl || !tabUrl.startsWith(viewer)) return tabUrl;
  try { return new URL(tabUrl).searchParams.get("file") || tabUrl; } catch { return tabUrl; }
}

/** Sends a new entry to every open tab on the same hostname (including the sender's tab). */
async function broadcastHistoryEntry(hostname, entry) {
  if (!hostname) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const tab of tabs) {
    if (!tab.id || !tab.url || G.hostnameOf(documentUrlOfTab(tab.url)) !== hostname) continue;
    chrome.tabs.sendMessage(tab.id, { type: "EXPLAIN_HISTORY_ADDED", hostname, entry }, { frameId: 0 })
      .catch(() => {}); // tabs without our content script
  }
}

function notifyCaptureDone(sender, requestId) {
  if (!sender.tab?.id) return;
  chrome.tabs.sendMessage(
    sender.tab.id,
    { type: "EXPLAIN_CAPTURE_DONE", requestId },
    { frameId: sender.frameId ?? 0 }
  ).catch(() => {});
}

async function postExplain(baseUrl, headers, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/explain`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return { networkError: true };
  }
  const data = await response.json().catch(() => null);
  return { response, data };
}

function detailCode(data) {
  const d = data?.detail;
  return d && typeof d === "object" ? d.code || null : null;
}

async function handleExplain(msg, sender) {
  const { profile, providerConfig } = await getFullConfig();
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  if (!baseUrl) return { ok: false, error: "Backend API URL is not configured." };

  const text = String(msg.text || "").trim();
  let kind = "text";
  let crop = null;

  if (msg.captureId) {
    // Confirmed circle: use the crop taken before the confirm bar. Never recapture.
    crop = await takeCapture(msg.captureId, sender.tab?.id);
    if (!crop) {
      return { ok: false, code: "CAPTURE_EXPIRED", error: "That capture expired, please circle again." };
    }
    kind = "image";
  } else if (msg.capture) {
    try {
      if (!sender.tab) throw new Error("No tab to capture.");
      crop = await captureCircleCrop(sender.tab.windowId, msg.capture);
      kind = "image";
    } catch (err) {
      crop = null;
    } finally {
      notifyCaptureDone(sender, msg.requestId);
    }
    if (!crop && !text) {
      return { ok: false, code: "EMPTY_CAPTURE", error: "Couldn't read that area, try circling again." };
    }
  } else if (!text) {
    return { ok: false, code: "EMPTY_TEXT", error: "Select some text to explain first." };
  }

  // ── Context: local always; page or document only when allowed ──
  const hostname = G.hostnameOf(msg.pageUrl || sender.tab?.url || "");
  const policy = CX.pageContextAllowed(await contextSettings(), hostname);
  const allowRich = policy.allowed && !msg.localOnly;
  let context = CX.capContext(msg.context);
  // Document context replaces page context; local-only drops page context.
  if (!allowRich || msg.document) context = CX.localOnly(context);
  let contextId = null;
  let contextNote = null;
  if (allowRich && msg.document && msg.document.url) {
    const doc = await ensureDocumentContext(msg.document);
    if (doc.ok) contextId = doc.contextId; else contextNote = "document_unavailable";
  } else if (!policy.allowed && !msg.localOnly) {
    contextNote = policy.reason === "sensitive" ? "sensitive" : "setting";
  }

  const fingerprint = await getClientFingerprint();
  const token = await getValidAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = {
    kind,
    text: kind === "image" ? G.truncate(text, 20000) : text,
    image_base64: crop ? crop.base64 : null,
    image_media_type: crop ? crop.mediaType : null,
    thumbnail_base64: crop ? crop.thumbBase64 : null,
    anchor: msg.anchor || null,
    page_url: msg.pageUrl || "",
    page_title: msg.pageTitle || "",
    session_difficulty: msg.sessionDifficulty || "normal",
    context: context || null,
    context_id: contextId,
    // Aggregate telemetry only: which surface the explain came from.
    source: !msg.document ? "page" : msg.document.mediaType === "application/pdf" ? "pdf" : "document",
    fingerprint,
    // Same rule as /reformat: signed-in users use their server profile and feedback.
    profile: token ? null : profile,
    recent_feedback: token ? null : await recentFeedbackForBackend()
  };

  let { response, data, networkError } = await postExplain(baseUrl, headers, body);

  // Unknown/expired document context: re-upload once, then retry once. If the
  // re-upload fails (e.g. Redis down -> 503), retry with local context only.
  if (!networkError && response.status === 400 && detailCode(data) === "CONTEXT_EXPIRED" && contextId) {
    const doc = await ensureDocumentContext(msg.document, { force: true });
    body.context_id = doc.ok ? doc.contextId : null;
    if (!doc.ok) contextNote = "document_unavailable";
    contextId = body.context_id;
    ({ response, data, networkError } = await postExplain(baseUrl, headers, body));
    if (!networkError && response.status === 400 && detailCode(data) === "CONTEXT_EXPIRED" && body.context_id) {
      // Still refused: last attempt without the document. No further retries.
      body.context_id = null;
      contextId = null;
      contextNote = "document_unavailable";
      ({ response, data, networkError } = await postExplain(baseUrl, headers, body));
    }
  }

  if (networkError) {
    return { ok: false, code: "NETWORK", error: "Couldn't reach Synapse. Check your connection and try again." };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, ...explainErrorMessage(response.status, data) };
  }
  if (!data || typeof data.html !== "string") {
    return { ok: false, error: "Synapse returned an empty explanation. Try again." };
  }

  await recordProviderUse(data.model_used || "backend").catch(() => {});

  let historyEntry = data.history_entry ? { ...data.history_entry, source: "server" } : null;
  let localEntry = null;

  // history_entry is null for free/anonymous callers, who get a local entry.
  // Local files count as one site ("local-files") like any other; other
  // non-web pages (no hostname) save no history, only show the result.
  const savesHistory = /^(https?|file):/i.test(msg.pageUrl || "") && !!hostname;
  if (!historyEntry && savesHistory) {
    localEntry = {
      id: newId("local"),
      hostname,
      url: msg.pageUrl || "",
      page_title: msg.pageTitle || "",
      kind,
      source_text: G.truncate(text, 2000),
      anchor: msg.anchor || null,
      result_html: data.html,
      thumbnail_url: crop?.thumbDataUrl || null,
      created_at: new Date().toISOString(),
      source: "local"
    };
    // Saved here, in the worker, so it survives the page navigating away.
    await updateLocalHistory(list => G.pushCapped(list, localEntry, LOCAL_HISTORY_MAX));
  }

  if (historyEntry || localEntry) broadcastHistoryEntry(hostname, historyEntry || localEntry);

  return {
    ok: true,
    html: data.html,
    kind: data.kind || kind,
    modelUsed: data.model_used || "backend",
    historyEntry,
    usage: data.usage || null,
    contextUsed: contextId ? "document" : (context?.page ? "page" : "local"),
    contextNote,
    ...(localEntry ? { localEntry } : {})
  };
}

async function handleGetExplainHistory(hostname) {
  const local = await readLocalHistory(hostname);
  const token = await getValidAccessToken();
  const baseUrl = await resolvedBackendBaseUrl();
  if (!token || !baseUrl || !hostname) return { ok: true, entries: local, source: "local" };

  try {
    const response = await fetch(
      `${baseUrl}/api/v1/explain/history?domain=${encodeURIComponent(hostname)}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return { ok: true, entries: local, source: "local" };
    const data = await response.json().catch(() => null);
    const server = (data?.entries || []).map(e => ({ ...e, source: "server" }));
    // Keep entries saved locally before the user upgraded or signed in.
    const merged = server.concat(local)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return { ok: true, entries: merged, source: "server" };
  } catch {
    return { ok: true, entries: local, source: "local" };
  }
}

async function handleDeleteExplainHistory(msg) {
  const token = await getValidAccessToken();
  const baseUrl = await resolvedBackendBaseUrl();
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : null;

  if (msg.id) {
    const isLocal = msg.source === "local" || String(msg.id).startsWith("local-");
    if (isLocal) {
      await updateLocalHistory(list => list.filter(e => e.id !== msg.id));
      return { ok: true };
    }
    if (!authHeaders || !baseUrl) return { ok: false, error: "Sign in to delete saved history." };
    try {
      const response = await fetch(`${baseUrl}/api/v1/explain/history/${encodeURIComponent(msg.id)}`, {
        method: "DELETE",
        headers: authHeaders
      });
      if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => null);
        return { ok: false, ...explainErrorMessage(response.status, data) };
      }
    } catch {
      return { ok: false, error: "Couldn't reach Synapse to delete that entry." };
    }
    return { ok: true };
  }

  if (msg.hostname) {
    await updateLocalHistory(list => list.filter(e => e.hostname !== msg.hostname));
    if (authHeaders && baseUrl) {
      try {
        const response = await fetch(
          `${baseUrl}/api/v1/explain/history?domain=${encodeURIComponent(msg.hostname)}`,
          { method: "DELETE", headers: authHeaders }
        );
        // 401/403 just mean there is no server history to clear.
        if (!response.ok && ![401, 403, 404].includes(response.status)) {
          const data = await response.json().catch(() => null);
          return { ok: false, ...explainErrorMessage(response.status, data) };
        }
      } catch {
        return { ok: false, error: "Cleared this device, but couldn't reach Synapse to clear synced history." };
      }
    }
    return { ok: true };
  }

  return { ok: false, error: "Nothing to delete." };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "EXPLAIN") {
    handleExplain(msg, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || "Something went wrong." }));
    return true;
  }

  if (msg.type === "CAPTURE_REGION") {
    handleCaptureRegion(msg, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: true, captureId: null, hasImage: false }));
    return true;
  }

  if (msg.type === "DISCARD_CAPTURE") {
    dropCapture(msg.captureId).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "OPEN_PDF_VIEWER") {
    // Navigates the sender's tab to the Synapse viewer. Done here (tabs API)
    // rather than location.href in the content script, so viewer/ and the
    // vendored pdf.js need not be web_accessible_resources.
    const target = viewerUrlFor(msg.url, { read: !!msg.read });
    if (!target || !sender.tab?.id) {
      sendResponse({ ok: false, error: "This PDF can't be opened in the Synapse viewer." });
      return true;
    }
    chrome.tabs.update(sender.tab.id, { url: target })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "Couldn't open the Synapse viewer." }));
    return true;
  }

  if (msg.type === "OPEN_LOCAL_FILE") {
    // History entries for local files: PDFs reopen in the Synapse viewer,
    // other files directly. Only file:// URLs are accepted here.
    let target = null;
    try {
      const u = new URL(String(msg.url || ""));
      if (u.protocol === "file:") target = /\.pdf$/i.test(u.pathname) ? viewerUrlFor(u.href) : u.href;
    } catch { /* invalid URL */ }
    if (!target || !sender.tab?.id) {
      sendResponse({ ok: false, error: "That file can't be opened." });
      return true;
    }
    chrome.tabs.update(sender.tab.id, { url: target })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "Couldn't open that file." }));
    return true;
  }

  if (msg.type === "PREPARE_DOCUMENT_CONTEXT") {
    (async () => {
      const policy = CX.pageContextAllowed(await contextSettings(), G.hostnameOf(msg.url || ""));
      if (!policy.allowed) return { ok: false, code: "CONTEXT_NOT_ALLOWED", error: "Page context is off for this site." };
      const res = await ensureDocumentContext({ url: msg.url, mediaType: msg.mediaType, text: msg.text, base64: msg.documentBase64 });
      return res.ok
        ? { ok: true, contextId: res.contextId, chars: res.chars }
        : { ok: false, code: res.code || null, error: "Document context isn't available." };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "Document context isn't available." }));
    return true;
  }

  if (msg.type === "GET_EXPLAIN_HISTORY") {
    handleGetExplainHistory(String(msg.hostname || "").toLowerCase())
      .then(sendResponse)
      .catch(() => sendResponse({ ok: true, entries: [], source: "local" }));
    return true;
  }

  if (msg.type === "DELETE_EXPLAIN_HISTORY") {
    handleDeleteExplainHistory(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || "Delete failed." }));
    return true;
  }

  if (msg.type === "ANALYSE_SECTIONS") {
    getFullConfig()
      .then(({ profile, providerConfig }) => callBackendAnalyseSections(msg.pageText, profile, providerConfig))
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SQ4R_QUESTIONS") {
    // SQ4R is now handled by the backend's main reformat endpoint
    sendResponse({ questions: null });
    return true;
  }

  if (msg.type === "ANALYSE_DOCUMENT") {
    getFullConfig().then(async ({ profile, providerConfig }) => {
      try {
        // Local files arrive from the page (the worker can't read file://).
        let base64 = msg.documentBase64 || null;
        if (!base64 && typeof msg.text === "string") base64 = arrayBufferToBase64(new TextEncoder().encode(msg.text));
        if (!base64) {
          const res = await fetch(msg.url);
          if (!res.ok) throw new Error(`Could not fetch document: HTTP ${res.status}`);
          base64 = arrayBufferToBase64(await res.arrayBuffer());
        }
        const result = await callBackendDocument(base64, msg.mediaType, profile, providerConfig);
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (msg.type === "CALL_LLM") {
    getFullConfig().then(async ({ profile, providerConfig }) => {
      try {
        const result = await callBackendReformat(msg.pageText, profile, providerConfig, {
          pageUrl: msg.pageUrl,
          pageTitle: msg.pageTitle,
          sessionDifficulty: msg.sessionDifficulty,
          mode: msg.mode
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (msg.type === "FEEDBACK") {
    recordFeedback(msg.entry)
      .then(() => syncPendingFeedback())
      .then(sync => sendResponse({ ok: true, ...sync }))
      .catch(err => sendResponse({ ok: true, synced: false, syncError: err.message }));
    return true;
  }

  if (msg.type === "SAVE_PROFILE") {
    const merged = { ...defaultProfile, ...msg.profile };
    chrome.storage.local.set({ cognitiveProfile: merged }, async () => {
      // When signed in, persist to the backend so it shows on the dashboard too.
      try {
        const token = await getValidAccessToken();
        if (token) {
          await patchBackendProfile(merged, token);
          sendResponse({ success: true, synced: true });
        } else {
          sendResponse({ success: true, synced: false });
        }
      } catch (err) {
        sendResponse({ success: true, synced: false, syncError: err.message });
      }
    });
    return true;
  }

  if (msg.type === "GET_PROFILE") {
    chrome.storage.local.get(["cognitiveProfile", "pendingProfileUpdate"], result => {
      sendResponse({
        profile: result.cognitiveProfile || defaultProfile,
        pendingUpdate: result.pendingProfileUpdate || null
      });
    });
    return true;
  }

  if (msg.type === "SAVE_PROVIDER_CONFIG") {
    chrome.storage.local.get("providerConfig", result => {
      const existing = { ...defaultProviderConfig, ...(result.providerConfig || {}) };
      chrome.storage.local.set({ providerConfig: { ...existing, ...msg.providerConfig } }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === "GET_AUTH_STATUS") {
    getAuthStatus()
      .then(status => sendResponse(status))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }

  if (msg.type === "REFRESH_PROFILE") {
    fetchAndStoreProfile()
      .then(local => sendResponse({ profile: local }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_PROVIDER_CONFIG") {
    chrome.storage.local.get(["providerConfig", "providerUsage"], result => {
      sendResponse({
        providerConfig: { ...defaultProviderConfig, ...(result.providerConfig || {}) },
        providerUsage: result.providerUsage || {}
      });
    });
    return true;
  }

  if (msg.type === "GET_BILLING_STATUS") {
    getFullConfig()
      .then(({ providerConfig }) => getBackendBillingStatus(providerConfig))
      .then(status => sendResponse({ status }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_FEEDBACK") {
    chrome.storage.local.get("feedbackLog", result => sendResponse({ feedbackLog: result.feedbackLog || [] }));
    return true;
  }

  if (msg.type === "CLEAR_FEEDBACK") {
    chrome.storage.local.remove("feedbackLog", () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "PING") {
    sendResponse({ alive: true });
    return true;
  }
});

// ── External messages from the dashboard (session handoff) ───────
// Origins allowed to hand off a session are pinned by manifest
// "externally_connectable". We accept the session, then pull the DB profile.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") {
    sendResponse({ ok: false, error: "Invalid message." });
    return true;
  }

  if (msg.type === "SYNAPSE_PING") {
    // The version lets the support page report which build a user is on,
    // which is usually the first thing worth knowing about a bug report.
    // user_id tells the dashboard whether a handoff is needed at all.
    getStoredSession().then(session => sendResponse({
      ok: true,
      installed: true,
      version: chrome.runtime.getManifest().version,
      user_id: session?.user_id || null
    }));
    return true;
  }

  if (msg.type === "SYNAPSE_SESSION") {
    if (!msg.access_token || !msg.refresh_token || !msg.api_url) {
      sendResponse({ ok: false, error: "Incomplete session payload." });
      return true;
    }
    const session = {
      access_token: msg.access_token,
      refresh_token: msg.refresh_token,
      expires_at: msg.expires_at || null,
      user_id: msg.user_id || null,
      api_url: msg.api_url
    };
    // The handoff also configures which API to talk to. providerConfig
    // .backendBaseUrl is read in six places but was never written by anything
    // — there is no settings UI for it — so every install was falling back to
    // the localhost default. Taking it from the dashboard fixes that.
    storageGet("providerConfig")
      .then(({ providerConfig }) => storageSet({
        providerConfig: { ...defaultProviderConfig, ...providerConfig, backendBaseUrl: msg.api_url }
      }))
      .then(() => storageSet({ [SESSION_KEY]: session }))
      .then(() => fetchAndStoreProfile())
      .then(() => syncPendingFeedback().catch(() => {}))
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "SYNAPSE_LOGOUT") {
    // Also drop the cached profile — it belongs to the user signing out, and
    // previously survived to greet whoever signed in next. The extension's
    // session is its own, so the dashboard's logout doesn't revoke it; do that
    // here, best effort.
    getStoredSession()
      .then(session => {
        const url = normalizeBackendBaseUrl(session?.api_url);
        if (!url || !session?.refresh_token) return;
        return fetch(`${url}/api/v1/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refresh_token })
        }).catch(() => {});
      })
      .finally(() => {
        chrome.storage.local.remove([SESSION_KEY, "cognitiveProfile"], () => sendResponse({ ok: true }));
      });
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
  if (details.reason === "update") {
    // Discard any pre-migration Supabase session rather than translating it.
    // Its access token is unverifiable by our backend and its refresh token is
    // worthless against us, so the only honest outcome is one sign-out. The
    // dashboard re-arms the extension on the next visit.
    chrome.storage.local.remove("supabaseSession");
  }
});
