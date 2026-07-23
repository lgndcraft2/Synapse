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
  backendBaseUrl: "https://api.usesynapse.cv",
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

// ── Supabase session (handed off from the dashboard) ─────────────
// The dashboard pushes the logged-in session here via onMessageExternal, so the
// user never has to paste a token. The extension refreshes the token itself.

async function getStoredSession() {
  const { supabaseSession } = await storageGet("supabaseSession");
  return supabaseSession || null;
}

async function refreshSupabaseSession(session) {
  const url = normalizeBackendBaseUrl(session.supabase_url);
  if (!url || !session.refresh_token || !session.supabase_anon_key) return null;

  let response;
  try {
    response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: session.supabase_anon_key
      },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data?.access_token) return null;

  const expiresAt = data.expires_at
    ? data.expires_at
    : Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

  const updated = {
    ...session,
    access_token: data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    expires_at: expiresAt
  };
  await storageSet({ supabaseSession: updated });
  return updated;
}

async function getValidAccessToken() {
  const session = await getStoredSession();
  if (session?.access_token) {
    const now = Math.floor(Date.now() / 1000);
    // Refresh a minute before expiry to avoid using a just-expired token.
    if (!session.expires_at || session.expires_at - 60 > now) {
      return session.access_token;
    }
    const refreshed = await refreshSupabaseSession(session);
    if (refreshed?.access_token) return refreshed.access_token;
    return null; // refresh failed — fall back to anonymous behaviour
  }

  // Legacy fallback: a manually pasted token (deprecated by the dashboard handoff).
  const { providerConfig } = await storageGet("providerConfig");
  return providerConfig?.backendAccessToken || null;
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

function toBackendFeedbackEntry(entry) {
  return {
    reaction: entry.reaction || null,
    note: entry.note || "",
    time_spent_seconds: entry.timeSpentSeconds ?? entry.time_spent_seconds ?? null,
    read_progress: entry.readProgress ?? entry.read_progress ?? null,
    session_difficulty: entry.sessionDifficulty || entry.session_difficulty || "normal",
    section_title: entry.sectionTitle || entry.section_title || null
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
      // Authenticated users use their server-side (dashboard) profile; only send
      // the local profile for anonymous callers.
      ...(token ? {} : { profile })
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
      ...(token ? {} : { profile })
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

async function submitBackendFeedback(entry, providerConfig) {
  const baseUrl = normalizeBackendBaseUrl(providerConfig.backendBaseUrl);
  const token = await getValidAccessToken();
  if (!baseUrl || !token) return { synced: false };

  const response = await fetch(`${baseUrl}/api/v1/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      entries: [toBackendFeedbackEntry(entry)],
      fingerprint: await getClientFingerprint()
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Feedback sync failed with HTTP ${response.status}`);
  }

  return { synced: true };
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        const res = await fetch(msg.url);
        if (!res.ok) throw new Error(`Could not fetch document: HTTP ${res.status}`);
        const base64 = arrayBufferToBase64(await res.arrayBuffer());
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
    chrome.storage.local.get("feedbackLog", result => {
      const log = result.feedbackLog || [];
      log.push(msg.entry);
      chrome.storage.local.set({ feedbackLog: log.slice(-50) }, async () => {
        try {
          const { providerConfig } = await getFullConfig();
          const sync = await submitBackendFeedback(msg.entry, providerConfig);
          sendResponse({ ok: true, ...sync });
        } catch (err) {
          sendResponse({ ok: true, synced: false, syncError: err.message });
        }
      });
    });
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
    getValidAccessToken()
      .then(token => sendResponse({ authenticated: Boolean(token) }))
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
    sendResponse({ ok: true, installed: true });
    return true;
  }

  if (msg.type === "SYNAPSE_SESSION") {
    if (!msg.access_token || !msg.refresh_token || !msg.supabase_url || !msg.supabase_anon_key) {
      sendResponse({ ok: false, error: "Incomplete session payload." });
      return true;
    }
    const session = {
      access_token: msg.access_token,
      refresh_token: msg.refresh_token,
      expires_at: msg.expires_at || null,
      supabase_url: msg.supabase_url,
      supabase_anon_key: msg.supabase_anon_key
    };
    storageSet({ supabaseSession: session })
      .then(() => fetchAndStoreProfile())
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "SYNAPSE_LOGOUT") {
    chrome.storage.local.remove("supabaseSession", () => sendResponse({ ok: true }));
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});
