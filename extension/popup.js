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
const accountStatus = document.getElementById("account-status");
const dashboardLink = document.getElementById("dashboard-link");
const billingStatus = document.getElementById("billing-status");
const usageStats = document.getElementById("usage-stats");

// The dashboard (frontend) origin — where users sign in. The extension talks to
// the backend API automatically; there is no user-facing backend setting.
const DASHBOARD_URL = window.SynapseConfig.DASHBOARD_URL;
if (dashboardLink) dashboardLink.href = DASHBOARD_URL + "/auth?tab=login";

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#1D9E75";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function applyProfileToForm(profile) {
  if (!profile) return;
  profileType.value = profile.profileType || "load-reducer";
  formatSelect.value = profile.preferredFormat || "bullet points";
  chunkSize.value = profile.chunkSize || "short";
  nesting.value = String(profile.maxNestingDepth || 2);
  examplesFirst.checked = profile.needsExamplesFirst !== false;
  simplifyVocab.checked = !!profile.simplifyVocab;
  useHeaders.checked = profile.useHeaders !== false;
  notesArea.value = profile.notes || "";
}

chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (res) => {
  applyProfileToForm(res?.profile || {});

  if (res?.pendingUpdate) {
    updateMsg.textContent = res.pendingUpdate.message || "Synapse updated your profile based on your feedback.";
    updateBanner.style.display = "flex";
    chrome.storage.local.remove("pendingProfileUpdate");
  }
});

// Reflect sign-in state and, when signed in, pull the latest dashboard profile.
chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (res) => {
  if (res?.authenticated) {
    const name = res.name || res.email || "your account";
    accountStatus.textContent = `Signed in as ${name}.`;
    if (dashboardLink) dashboardLink.style.display = "none";
    chrome.runtime.sendMessage({ type: "REFRESH_PROFILE" }, (refresh) => {
      if (refresh?.profile) applyProfileToForm(refresh.profile);
    });
  } else {
    accountStatus.textContent = "Not signed in.";
    if (dashboardLink) dashboardLink.style.display = "inline";
  }
});

chrome.runtime.sendMessage({ type: "GET_PROVIDER_CONFIG" }, (res) => {
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
    feedbackStats.textContent = "No feedback yet - rate an explanation to start.";
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

const reformatList = document.getElementById("reformat-list");
const reformatEmpty = document.getElementById("reformat-empty");
const clearReformats = document.getElementById("clear-reformats");

function timeAgo(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function renderReformats(entries) {
  reformatList.replaceChildren();
  reformatList.hidden = entries.length === 0;
  reformatEmpty.hidden = entries.length > 0;
  clearReformats.hidden = entries.length === 0;
  for (const entry of entries) {
    const item = document.createElement("li");
    // Chrome won't open file:// from a link here, so local files are text only.
    const title = document.createElement(/^https?:/i.test(entry.url) ? "a" : "span");
    title.className = "reformat-title";
    title.textContent = entry.title || entry.hostname || entry.url;
    title.title = entry.url;
    if (title.tagName === "A") {
      title.href = entry.url;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
    }
    const meta = document.createElement("span");
    meta.className = "reformat-meta";
    meta.textContent = `${entry.hostname} · ${timeAgo(entry.created_at)}`;
    item.append(title, meta);
    reformatList.append(item);
  }
}

chrome.runtime.sendMessage({ type: "GET_REFORMAT_HISTORY" }, (res) => {
  renderReformats(res?.entries || []);
});

clearReformats?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_REFORMAT_HISTORY" }, () => renderReformats([]));
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

clearFeedback?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_FEEDBACK" }, () => {
    feedbackStats.textContent = "Feedback cleared.";
    setStatus("Feedback log cleared.");
  });
});
