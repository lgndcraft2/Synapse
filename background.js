const CLAUDE_MODEL = "claude-sonnet-4-6";
const GEMINI_MODEL = "gemini-2.5-flash";

const defaultProfile = {
  preferredFormat: "bullet points",
  chunkSize: "short",
  needsExamplesFirst: true,
  maxNestingDepth: 2,
  useHeaders: true,
  simplifyVocab: false,
  notes: ""
};

// ================================================================
// SYSTEM PROMPT — injects profile + feedback history
// ================================================================
function buildSystemPrompt(profile, feedbackLog) {
  const feedbackSummary = buildFeedbackSummary(feedbackLog);

  return `You are Synapse 2.0, a cognitive accessibility assistant.
Your job is to reformat page content into HTML that works best for this specific user's brain.

── COGNITIVE PROFILE ──
${JSON.stringify(profile, null, 2)}

── WHAT YOU HAVE LEARNED FROM THIS USER'S FEEDBACK ──
${feedbackSummary}

── RULES ──
- Return ONLY a single <div> of valid HTML. No markdown, no explanation, no preamble.
- Use proper semantic tags: <h2> sections, <h3> subsections, <p> paragraphs,
  <ul>/<li> lists, <strong> key terms, <mark> for important concepts.
- Use the profile AND the feedback history to decide structure.
- Keep ALL original information — only restructure the presentation.
- No inline styles. Classes and semantic tags only.
- Do not add any text, commentary or wrapper outside the single <div>.`;
}

// ================================================================
// FEEDBACK SUMMARY — converts raw log into useful prompt context
// ================================================================
function buildFeedbackSummary(feedbackLog) {
  if (!feedbackLog || feedbackLog.length === 0) {
    return "No feedback collected yet. Apply the cognitive profile strictly.";
  }

  const recent = feedbackLog.slice(-20); // last 20 entries

  const counts = { clearer: 0, complex: 0, simple: 0 };
  const notes = [];
  let totalTime = 0;
  let totalRead = 0;

  recent.forEach(entry => {
    if (entry.reaction) counts[entry.reaction] = (counts[entry.reaction] || 0) + 1;
    if (entry.note) notes.push(entry.note);
    if (entry.timeSpentSeconds) totalTime += entry.timeSpentSeconds;
    if (entry.readProgress) totalRead += entry.readProgress;
  });

  const avgTime = Math.round(totalTime / recent.length);
  const avgRead = Math.round(totalRead / recent.length);

  let summary = `Based on ${recent.length} interactions:\n`;
  summary += `- Reactions: ${counts.clearer} "clearer", ${counts.complex} "too complex", ${counts.simple} "too simple"\n`;
  summary += `- Average time reading a card: ${avgTime} seconds\n`;
  summary += `- Average scroll depth: ${avgRead}%\n`;

  if (counts.complex > counts.clearer) {
    summary += `- IMPORTANT: This user frequently finds reformats too complex. Simplify further — shorter sentences, fewer nested points, more white space.\n`;
  }
  if (counts.simple > counts.clearer) {
    summary += `- IMPORTANT: This user finds reformats too simplified. Add more detail and preserve nuance.\n`;
  }
  if (avgRead < 40) {
    summary += `- This user stops reading cards early. Lead with the most important information first.\n`;
  }
  if (avgTime < 10) {
    summary += `- Very short read times. Make the reformat skimmable — strong headers, bold key terms.\n`;
  }
  if (notes.length > 0) {
    summary += `\nDirect notes from the user:\n`;
    notes.slice(-5).forEach(n => {
      summary += `  - "${n}"\n`;
    });
  }

  return summary;
}

// ================================================================
// STORAGE HELPERS
// ================================================================
function getFullConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["cognitiveProfile", "apiKeys", "feedbackLog"],
      (result) => {
        resolve({
          profile: result.cognitiveProfile || defaultProfile,
          apiKeys: result.apiKeys || {},
          feedbackLog: result.feedbackLog || [],
        });
      }
    );
  });
}

function getApiKey(provider, apiKeys) {
  return provider === "gemini"
    ? apiKeys.gemini || ""
    : apiKeys.claude || "";
}

// ================================================================
// CLAUDE API
// ================================================================
async function callClaude(pageText, profile, feedbackLog, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: buildSystemPrompt(profile, feedbackLog),
      messages: [
        {
          role: "user",
          content: `Reformat this content for my cognitive profile:\n\n${pageText}`
        }
      ]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ================================================================
// GEMINI API
// ================================================================
async function callGemini(pageText, profile, feedbackLog, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Reformat this content for my cognitive profile:\n\n${pageText}`
          }]
        }],
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(profile, feedbackLog) }]
        },
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.3
        }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini error ${response.status}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

// ================================================================
// PROVIDER ROUTER
// ================================================================
async function callProvider(pageText, profile, apiKeys, feedbackLog) {
  const provider = (profile.provider || "claude").toLowerCase();
  const apiKey = getApiKey(provider, apiKeys);

  if (provider === "gemini") {
    if (!apiKey) throw new Error("Gemini API key is not configured.");
    return callGemini(pageText, profile, feedbackLog, apiKey);
  }

  if (!apiKey) throw new Error("Claude API key is not configured.");
  return callClaude(pageText, profile, feedbackLog, apiKey);
}

// ================================================================
// SECTION ANALYSIS — identifies logical sections from page text
// ================================================================
const SECTION_SYSTEM_PROMPT = `You are a document structure analyser.
Read the page text and divide it into 3–8 meaningful logical sections.
Return ONLY a valid JSON array — no markdown, no explanation, nothing else.
Each element must have exactly these keys:
  "title"   — short section heading (max 6 words)
  "content" — a brief 1-2 sentence excerpt that identifies this section. Do NOT copy large blocks of text.
  "summary" — one sentence describing what this section covers
If the page has fewer than 3 distinguishable sections, return as many as exist.
Never return fewer than 1 element.`;

async function analyseSections(pageText, profile, apiKeys) {
  const provider = (profile.provider || "claude").toLowerCase();
  const apiKey = getApiKey(provider, apiKeys);

  let raw;
  if (provider === "gemini") {
    if (!apiKey) throw new Error("Gemini API key is not configured.");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Analyse and split into sections:\n\n${pageText}` }] }],
          systemInstruction: { parts: [{ text: SECTION_SYSTEM_PROMPT }] },
          generationConfig: { maxOutputTokens: 9000, temperature: 0.2 }
        })
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini error ${response.status}`);
    raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  } else {
    if (!apiKey) throw new Error("Claude API key is not configured.");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 9500,
        system: SECTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Analyse and split into sections:\n\n${pageText}` }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    raw = data.content[0].text;
  }

  if (!raw) throw new Error("Empty response from LLM.");

  // Strip markdown code fences if the model added them
  const clean = raw.replace(/```json|```/gi, "").trim();

  let sections;
  try {
    sections = JSON.parse(clean);
  } catch (e) {
    console.error("Synapse: failed to parse sections JSON. Raw response was:", raw);
    throw new Error("LLM returned malformed JSON — check the service worker console for the raw output.");
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("LLM returned no sections.");
  }

  // Validate each entry has the required keys
  return sections.filter(s => s.title && s.content);
}

// ================================================================
// PROFILE AUTO-UPDATE
// — After every 10 feedback entries, propose a profile amendment
// ================================================================
async function maybeUpdateProfile(feedbackLog, profile, apiKeys) {
  if (feedbackLog.length % 10 !== 0 || feedbackLog.length === 0) return;

  const apiKey = getApiKey(profile.provider || 'claude', apiKeys);
  if (!apiKey) return;

  const summary = buildFeedbackSummary(feedbackLog);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 500,
        system: `You are a cognitive profile updater for Synapse 2.0.
Based on feedback data, suggest minimal updates to a user's cognitive profile.
Return ONLY a valid JSON object with the same keys as the profile.
Only change values that the feedback clearly supports changing.
Do not add new keys. Return the complete profile with updates applied.`,
        messages: [{
          role: "user",
          content: `Current profile:\n${JSON.stringify(profile, null, 2)}\n\nFeedback summary:\n${summary}\n\nReturn the updated profile JSON only.`
        }]
      })
    });

    const data = await response.json();
    if (data.error) return;

    const raw = data.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const updated = JSON.parse(clean);

    // Save updated profile and store a pending suggestion for popup to show
    chrome.storage.local.set({
      cognitiveProfile: updated,
      pendingProfileUpdate: {
        ts: Date.now(),
        message: "Synapse updated your profile based on your feedback.",
        profile: updated
      }
    });
  } catch (e) {
    console.log('Synapse profile update skipped:', e.message);
  }
}

// ================================================================
// MESSAGE LISTENER
// ================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Section analysis request ──
  if (msg.type === "ANALYSE_SECTIONS") {
    getFullConfig().then(async ({ profile, apiKeys }) => {
      try {
        const sections = await analyseSections(msg.pageText, profile, apiKeys);
        sendResponse({ sections });
      } catch (err) {
        console.error("Synapse section analysis error:", err);
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  // ── Reformat request ──
  if (msg.type === "CALL_CLAUDE" || msg.type === "CALL_LLM") {
    getFullConfig().then(async ({ profile, apiKeys, feedbackLog }) => {
      try {
        const html = await callProvider(msg.pageText, profile, apiKeys, feedbackLog);
        sendResponse({ html });
      } catch (err) {
        console.error("Synapse error:", err);
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  // ── Feedback received ──
  if (msg.type === "FEEDBACK") {
    chrome.storage.local.get(
      ["feedbackLog", "cognitiveProfile", "apiKeys"],
      (result) => {
        const log = result.feedbackLog || [];
        log.push(msg.entry);
        const trimmed = log.slice(-50);
        chrome.storage.local.set({ feedbackLog: trimmed }, () => {
          // Try a profile update every 10 entries
          maybeUpdateProfile(
            trimmed,
            result.cognitiveProfile || defaultProfile,
            result.apiKeys || {}
          );
        });
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  // ── Save profile ──
  if (msg.type === "SAVE_PROFILE") {
    chrome.storage.local.set(
      { cognitiveProfile: msg.profile, apiKeys: msg.apiKeys || {} },
      () => sendResponse({ success: true })
    );
    return true;
  }

  // ── Get profile ──
  if (msg.type === "GET_PROFILE") {
    chrome.storage.local.get(
      ["cognitiveProfile", "pendingProfileUpdate"],
      (result) => {
        sendResponse({
          profile: result.cognitiveProfile || null,
          pendingUpdate: result.pendingProfileUpdate || null
        });
      }
    );
    return true;
  }

  // ── Get feedback log (for popup display) ──
  if (msg.type === "GET_FEEDBACK") {
    chrome.storage.local.get("feedbackLog", (result) => {
      sendResponse({ feedbackLog: result.feedbackLog || [] });
    });
    return true;
  }

  // ── Clear feedback log ──
  if (msg.type === "CLEAR_FEEDBACK") {
    chrome.storage.local.remove("feedbackLog", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Ping ──
  if (msg.type === "PING") {
    sendResponse({ alive: true });
    return true;
  }
});