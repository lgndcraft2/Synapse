// popup.js — settings only, no reformat buttons needed anymore

const providerSelect = document.getElementById("provider");
const claudeKeyInput = document.getElementById("claude-key");
const geminiKeyInput = document.getElementById("gemini-key");
const formatSelect = document.getElementById("format");
const notesArea = document.getElementById("notes");
const saveBtn = document.getElementById("save-btn");
const statusEl = document.getElementById("status");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#1D9E75";
}

chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (res) => {
  if (res.profile) {
    providerSelect.value = res.profile.provider || "claude";
    formatSelect.value = res.profile.preferredFormat;
    notesArea.value = res.profile.notes || "";
  }
});

chrome.storage.local.get("apiKeys", (res) => {
  claudeKeyInput.value = res.apiKeys?.claude || "";
  geminiKeyInput.value = res.apiKeys?.gemini || "";
});

saveBtn.addEventListener("click", () => {
  const profile = {
    provider: providerSelect.value,
    preferredFormat: formatSelect.value,
    notes: notesArea.value.trim()
  };
  const apiKeys = {
    claude: claudeKeyInput.value.trim(),
    gemini: geminiKeyInput.value.trim()
  };
  chrome.runtime.sendMessage(
    { type: "SAVE_PROFILE", profile, apiKeys },
    () => setStatus("Profile saved.")
  );
});