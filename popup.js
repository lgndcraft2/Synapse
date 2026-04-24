// ── Redirect to onboarding if not yet complete ──
chrome.storage.local.get("onboardingComplete", (res) => {
  if (!res.onboardingComplete) {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    window.close();
  }
});

const formatSelect    = document.getElementById("format");
const notesArea       = document.getElementById("notes");
const saveBtn         = document.getElementById("save-btn");
const statusEl        = document.getElementById("status");
const updateBanner    = document.getElementById("update-banner");
const updateMsg       = document.getElementById("update-msg");
const dismissBtn      = document.getElementById("dismiss-update");
const feedbackStats   = document.getElementById("feedback-stats");
const clearFeedback   = document.getElementById("clear-feedback");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#1D9E75";
}

// ── Load saved profile + check for pending update ──
chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (res) => {
  if (res?.profile) {
    formatSelect.value = res.profile.preferredFormat || "bullet points";
    notesArea.value    = res.profile.notes || "";
  }

  // Show update banner if Synapse updated the profile automatically
  if (res?.pendingUpdate) {
    updateMsg.textContent = res.pendingUpdate.message ||
      "Synapse updated your profile based on your feedback.";
    updateBanner.style.display = "block";

    // Clear the pending flag once shown
    chrome.storage.local.remove("pendingProfileUpdate");
  }
});

// ── Load API keys ──
// (keys are now hardcoded in background.js — nothing to load)

// ── Load feedback stats ──
chrome.runtime.sendMessage({ type: "GET_FEEDBACK" }, (res) => {
  const log = res?.feedbackLog || [];
  if (log.length === 0) {
    feedbackStats.textContent = "No feedback yet — use section cards to start.";
    return;
  }

  const counts = { clearer: 0, complex: 0, simple: 0 };
  log.forEach(e => { if (e.reaction) counts[e.reaction]++; });

  const total = log.length;
  const withReaction = counts.clearer + counts.complex + counts.simple;
  const notes = log.filter(e => e.note).length;

  feedbackStats.textContent =
    `${total} interaction${total !== 1 ? 's' : ''} · ` +
    `${counts.clearer} clearer · ${counts.complex} complex · ` +
    `${counts.simple} simple · ${notes} note${notes !== 1 ? 's' : ''}`;
});

// ── Dismiss update banner ──
dismissBtn?.addEventListener("click", () => {
  updateBanner.style.display = "none";
});

// ── Save profile ──
saveBtn.addEventListener("click", () => {
  const profile = {
    preferredFormat: formatSelect.value,
    notes:           notesArea.value.trim()
  };
  chrome.runtime.sendMessage(
    { type: "SAVE_PROFILE", profile },
    () => setStatus("Profile saved.")
  );
});

// ── Clear feedback log ──
clearFeedback?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_FEEDBACK" }, () => {
    feedbackStats.textContent = "Feedback cleared.";
    setStatus("Feedback log cleared.");
  });
});