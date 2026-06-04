chrome.storage.local.get("onboardingComplete", (res) => {
  if (!res.onboardingComplete) {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    window.close();
  }
});

const profileType = document.getElementById("profile-type");
const formatSelect = document.getElementById("format");
const chunkSize = document.getElementById("chunk-size");
const nesting = document.getElementById("nesting");
const examplesFirst = document.getElementById("examples-first");
const simplifyVocab = document.getElementById("simplify-vocab");
const useHeaders = document.getElementById("use-headers");
const notesArea = document.getElementById("notes");
const saveBtn = document.getElementById("save-btn");
const statusEl = document.getElementById("status");
const updateBanner = document.getElementById("update-banner");
const updateMsg = document.getElementById("update-msg");
const dismissBtn = document.getElementById("dismiss-update");
const feedbackStats = document.getElementById("feedback-stats");
const clearFeedback = document.getElementById("clear-feedback");
const backendUrl = document.getElementById("backend-url");
const backendToken = document.getElementById("backend-token");
const billingStatus = document.getElementById("billing-status");
const saveProviderBtn = document.getElementById("save-provider-btn");
const usageStats = document.getElementById("usage-stats");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#1D9E75";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (res) => {
  const profile = res?.profile || {};
  profileType.value = profile.profileType || "load-reducer";
  formatSelect.value = profile.preferredFormat || "bullet points";
  chunkSize.value = profile.chunkSize || "short";
  nesting.value = String(profile.maxNestingDepth || 2);
  examplesFirst.checked = profile.needsExamplesFirst !== false;
  simplifyVocab.checked = !!profile.simplifyVocab;
  useHeaders.checked = profile.useHeaders !== false;
  notesArea.value = profile.notes || "";

  if (res?.pendingUpdate) {
    updateMsg.textContent = res.pendingUpdate.message || "Synapse updated your profile based on your feedback.";
    updateBanner.style.display = "flex";
    chrome.storage.local.remove("pendingProfileUpdate");
  }
});

chrome.runtime.sendMessage({ type: "GET_PROVIDER_CONFIG" }, (res) => {
  const config = res?.providerConfig || {};
  backendUrl.value = config.backendBaseUrl || "https://api.synapseos.app";
  backendToken.value = config.backendAccessToken || "";

  const usage = res?.providerUsage || {};
  const today = usage[todayKey()] || { requests: 0, providers: {} };
  const gemini = today.providers?.gemini || 0;
  const claude = today.providers?.claude || 0;
  const backend = today.providers?.backend || today.providers?.["gemini-flash"] || today.providers?.["claude-sonnet"] || 0;
  usageStats.textContent = `${today.requests || 0} request${today.requests === 1 ? "" : "s"} today — ${backend + gemini + claude} requests via backend`;

  chrome.runtime.sendMessage({ type: "GET_BILLING_STATUS" }, (billingRes) => {
    if (billingRes?.status?.authenticated) {
      const status = billingRes.status;
      billingStatus.textContent = `Billing: ${status.plan || "unknown"} (${status.status || "unknown"})`;
    } else if (billingRes?.error) {
      billingStatus.textContent = `Billing: ${billingRes.error}`;
    } else {
      billingStatus.textContent = "Billing: anonymous free-tier rate limits active.";
    }
  });
});

chrome.runtime.sendMessage({ type: "GET_FEEDBACK" }, (res) => {
  const log = res?.feedbackLog || [];
  if (log.length === 0) {
    feedbackStats.textContent = "No feedback yet - use section cards to start.";
    return;
  }

  const counts = { clearer: 0, complex: 0, simple: 0, "off-topic": 0 };
  log.forEach(entry => {
    if (entry.reaction) counts[entry.reaction] = (counts[entry.reaction] || 0) + 1;
  });

  const notes = log.filter(entry => entry.note).length;
  feedbackStats.textContent =
    `${log.length} interaction${log.length !== 1 ? "s" : ""} - ` +
    `${counts.clearer} clearer, ${counts.complex} complex, ` +
    `${counts.simple} simple, ${counts["off-topic"]} missed, ${notes} note${notes !== 1 ? "s" : ""}`;
});

dismissBtn?.addEventListener("click", () => {
  updateBanner.style.display = "none";
});

saveBtn.addEventListener("click", () => {
  const profile = {
    profileType: profileType.value,
    preferredFormat: formatSelect.value,
    chunkSize: chunkSize.value,
    needsExamplesFirst: examplesFirst.checked,
    maxNestingDepth: Number(nesting.value),
    useHeaders: useHeaders.checked,
    simplifyVocab: simplifyVocab.checked,
    notes: notesArea.value.trim()
  };

  chrome.runtime.sendMessage({ type: "SAVE_PROFILE", profile }, () => {
    setStatus("Profile saved.");
  });
});

saveProviderBtn.addEventListener("click", () => {
  const providerConfig = {
    backendBaseUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    backendAccessToken: backendToken.value.trim(),
    useBackendProxy: true
  };

  chrome.runtime.sendMessage({ type: "SAVE_PROVIDER_CONFIG", providerConfig }, () => {
    setStatus("Backend settings saved.");
  });
});

clearFeedback?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_FEEDBACK" }, () => {
    feedbackStats.textContent = "Feedback cleared.";
    setStatus("Feedback log cleared.");
  });
});
