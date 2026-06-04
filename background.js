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
  const headers = { "Content-Type": "application/json" };
  if (providerConfig.backendAccessToken) {
    headers.Authorization = `Bearer ${providerConfig.backendAccessToken}`;
  }

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
      profile: profile // Send local profile
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
  const headers = { "Content-Type": "application/json" };
  if (providerConfig.backendAccessToken) {
    headers.Authorization = `Bearer ${providerConfig.backendAccessToken}`;
  }

  const response = await fetch(`${baseUrl}/api/v1/reformat/analyse-sections`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page_text: pageText, fingerprint, profile })
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
  const headers = { "Content-Type": "application/json" };
  if (providerConfig.backendAccessToken) {
    headers.Authorization = `Bearer ${providerConfig.backendAccessToken}`;
  }

  const response = await fetch(`${baseUrl}/api/v1/reformat/reformat-document`, {
    method: "POST",
    headers,
    body: JSON.stringify({ 
      base64_data: base64Data, 
      media_type: mediaType, 
      session_difficulty: sessionDifficulty, 
      fingerprint,
      profile
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
  if (!baseUrl || !providerConfig.backendAccessToken) {
    return { configured: Boolean(baseUrl), authenticated: false };
  }

  const response = await fetch(`${baseUrl}/api/v1/billing/status`, {
    headers: { Authorization: `Bearer ${providerConfig.backendAccessToken}` }
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.detail || `Billing status failed with HTTP ${response.status}`);
  }

  return { configured: true, authenticated: true, ...data };
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
      chrome.storage.local.set({ feedbackLog: log.slice(-50) }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === "SAVE_PROFILE") {
    chrome.storage.local.set({ cognitiveProfile: { ...defaultProfile, ...msg.profile } }, () => sendResponse({ success: true }));
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

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});
