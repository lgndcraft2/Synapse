const CLAUDE_MODEL = "claude-sonnet-4-6";
const GEMINI_MODEL = "gemini-2.0-flash";

// Optional build-time fallbacks. Production keys should be injected by your
// backend or saved during internal testing, not committed into the extension.
const CLAUDE_API_KEY = "";
const GEMINI_API_KEYS = [];

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
  preferredProvider: "auto",
  claudeApiKey: CLAUDE_API_KEY,
  geminiApiKeys: GEMINI_API_KEYS,
  geminiKeyIndex: 0,
  rateLimitedGeminiKeys: {},
  freeDailyLimit: 40
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function stripCodeFence(raw) {
  return (raw || "").trim().replace(/^```(?:json|html)?/i, "").replace(/```$/i, "").trim();
}

function extractGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
}

function buildProfileInstructions(profile) {
  const chunkDesc = {
    short: "Keep each section concise - 2 to 3 sentences maximum per point.",
    medium: "Use moderate length - enough detail to be clear, but no padding.",
    long: "Be thorough - include full context and nuance for each point."
  }[profile.chunkSize] || "Keep sections concise.";

  const base = [
    `Format: Present all content as ${profile.preferredFormat}.`,
    chunkDesc,
    profile.needsExamplesFirst
      ? "Always lead with a concrete example BEFORE giving the explanation or rule."
      : "Give the explanation or concept first, then follow with examples.",
    profile.simplifyVocab
      ? "Use plain, everyday language. Replace jargon and technical terms with simpler alternatives where possible."
      : "Preserve the original technical vocabulary - do not dumb down terminology.",
    profile.useHeaders
      ? "Add a clear <h2> or <h3> header to each section to aid navigation."
      : "Do not add headers - present content as a continuous flow.",
    `Maximum nesting depth for lists: ${profile.maxNestingDepth} level${profile.maxNestingDepth > 1 ? "s" : ""}. Do not nest deeper than this.`
  ];

  const strategy = {
    "load-reducer": [
      "COGNITIVE STRATEGY: This user has high reading load. Your primary job is reducing cognitive friction.",
      "Lead with the single most important point. Everything else is secondary.",
      "Break any sentence longer than 20 words into two sentences.",
      "Never introduce more than one new concept per paragraph or bullet.",
      "Use <mark> on the single most critical term or phrase per section - no more than one.",
      "Avoid nested structures unless absolutely necessary for meaning."
    ],
    "comprehension-gap": [
      "COGNITIVE STRATEGY: This user reads fluently but loses meaning. Your job is making implicit things explicit.",
      "After each key paragraph or point, add a one-sentence plain-language interpretation: what the author actually means.",
      "Surface subtext: if the author is implying something rather than stating it, state it directly.",
      "Identify the single core argument of the section and state it clearly at the top.",
      "If there are multiple valid interpretations of a sentence, flag this explicitly.",
      "Connect each new point to the previous one with a brief bridging sentence.",
      "Avoid relying on tone or implication - be literal and direct."
    ],
    hyperfocus: [
      "COGNITIVE STRATEGY: This user is a strong reader who hyperfocuses. Your job is structure and retention, not simplification.",
      "Do NOT simplify vocabulary or water down nuance - preserve full technical depth.",
      "Provide a 2-line takeaway at the end of each section summarizing the key idea for later recall.",
      "Use consistent heading hierarchy so the user can navigate non-linearly.",
      "Bold key terms and novel concepts - this user scans fast and needs anchors.",
      "If the section contains a list of related items, group them by theme.",
      "Preserve the original argument structure - this user wants to engage with the author's reasoning, not a flattened version."
    ]
  }[profile.profileType] || [];

  const lines = [...base, "", ...strategy];
  if (profile.notes?.trim()) lines.push(`\nDirect note from the user: "${profile.notes.trim()}"`);
  return lines.join("\n");
}

function buildFeedbackSummary(feedbackLog) {
  if (!feedbackLog || feedbackLog.length === 0) {
    return "No feedback collected yet. Apply the cognitive profile strictly.";
  }

  const recent = feedbackLog.slice(-20);
  const counts = { clearer: 0, complex: 0, simple: 0, "off-topic": 0 };
  const notes = [];
  let totalTime = 0;
  let totalRead = 0;
  let hardSessions = 0;

  recent.forEach(entry => {
    if (entry.reaction) counts[entry.reaction] = (counts[entry.reaction] || 0) + 1;
    if (entry.note) notes.push(entry.note);
    if (entry.timeSpentSeconds) totalTime += entry.timeSpentSeconds;
    if (entry.readProgress) totalRead += entry.readProgress;
    if (entry.sessionDifficulty === "hard") hardSessions++;
  });

  const avgTime = Math.round(totalTime / recent.length);
  const avgRead = Math.round(totalRead / recent.length);
  let summary = `Based on ${recent.length} interactions:\n`;
  summary += `- Reactions: ${counts.clearer} "clearer", ${counts.complex} "too complex", ${counts.simple} "too simple", ${counts["off-topic"]} "missed the point"\n`;
  summary += `- Average time reading a card: ${avgTime} seconds\n`;
  summary += `- Average scroll depth: ${avgRead}%\n`;
  if (hardSessions > 0) summary += `- ${hardSessions} hard reading day sessions. On hard days, use shorter chunks and simpler sentences even if the profile says otherwise.\n`;
  if (counts.complex > counts.clearer) summary += "- IMPORTANT: This user frequently finds reformats too complex. Simplify further - shorter sentences, fewer nested points, more white space.\n";
  if (counts.simple > counts.clearer) summary += "- IMPORTANT: This user finds reformats too simplified. Add more detail and preserve nuance.\n";
  if (counts["off-topic"] > 2) summary += "- IMPORTANT: This user frequently finds reformats miss the point. Focus harder on the central argument. Do not bury it in supporting detail.\n";
  if (avgRead < 40) summary += "- This user stops reading cards early. Lead with the most important information first.\n";
  if (avgTime < 10) summary += "- Very short read times. Make the reformat skimmable - strong headers, bold key terms.\n";
  if (notes.length > 0) {
    summary += "\nDirect notes from the user:\n";
    notes.slice(-5).forEach(note => { summary += `  - "${note}"\n`; });
  }
  return summary;
}

function buildSystemPrompt(profile, feedbackLog) {
  return `You are Synapse, a cognitive accessibility assistant.
Your job is to reformat page content into HTML that works best for this specific user's brain.

HOW THIS USER NEEDS CONTENT PRESENTED
${buildProfileInstructions(profile)}

WHAT YOU HAVE LEARNED FROM THIS USER'S FEEDBACK
${buildFeedbackSummary(feedbackLog)}

RULES
- Return ONLY a single <div> of valid HTML. No markdown, no explanation, no preamble.
- Use proper semantic tags: <h2> sections, <h3> subsections, <p> paragraphs, <ul>/<li> lists, <strong> key terms, <mark> for important concepts.
- Follow the user's presentation instructions above precisely.
- Keep ALL original information - only restructure the presentation.
- No inline styles. Classes and semantic tags only.
- Do not add text outside the single <div>.`;
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

async function getFullConfig() {
  const result = await storageGet(["cognitiveProfile", "feedbackLog", "providerConfig", "providerUsage", "premiumActive"]);
  const providerConfig = { ...defaultProviderConfig, ...(result.providerConfig || {}) };
  if (result.premiumActive) providerConfig.tier = "premium";
  return {
    profile: { ...defaultProfile, ...(result.cognitiveProfile || {}) },
    feedbackLog: result.feedbackLog || [],
    providerConfig,
    providerUsage: result.providerUsage || {}
  };
}

async function enforceFreeLimit(providerConfig, providerUsage) {
  if (providerConfig.tier !== "free") return;
  const key = todayKey();
  const count = providerUsage[key]?.requests || 0;
  if (count >= providerConfig.freeDailyLimit) {
    throw new Error("Free daily request limit reached. Try again tomorrow or switch to premium.");
  }
}

async function recordProviderUse(provider) {
  const { providerUsage = {} } = await storageGet("providerUsage");
  const key = todayKey();
  const day = providerUsage[key] || { requests: 0, providers: {} };
  day.requests += 1;
  day.providers[provider] = (day.providers[provider] || 0) + 1;
  await storageSet({ providerUsage: { ...providerUsage, [key]: day } });
}

async function markGeminiKeyLimited(providerConfig, keyIndex) {
  const next = {
    ...providerConfig,
    rateLimitedGeminiKeys: {
      ...(providerConfig.rateLimitedGeminiKeys || {}),
      [keyIndex]: Date.now()
    }
  };
  await storageSet({ providerConfig: next });
}

async function getNextGeminiKey(providerConfig) {
  const keys = (providerConfig.geminiApiKeys || []).map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;

  const limited = providerConfig.rateLimitedGeminiKeys || {};
  const start = providerConfig.geminiKeyIndex || 0;
  const oneHour = 60 * 60 * 1000;

  for (let step = 0; step < keys.length; step++) {
    const idx = (start + step) % keys.length;
    const limitedAt = limited[idx];
    if (limitedAt && Date.now() - limitedAt < oneHour) continue;

    await storageSet({
      providerConfig: {
        ...providerConfig,
        geminiKeyIndex: (idx + 1) % keys.length
      }
    });
    return { key: keys[idx], index: idx };
  }

  return null;
}

async function callClaudeText({ system, prompt, maxTokens = 2000, apiKey }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  await recordProviderUse("claude");
  return data.content?.[0]?.text || "";
}

async function callGeminiText({ system, prompt, maxTokens = 2000, providerConfig }) {
  const selected = await getNextGeminiKey(providerConfig);
  if (!selected) throw new Error("No available Gemini key is configured for the free tier.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(selected.key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.25
        }
      })
    }
  );

  const data = await response.json();
  if (!response.ok || data.error) {
    if ([429, 403].includes(response.status)) await markGeminiKeyLimited(providerConfig, selected.index);
    throw new Error(data.error?.message || `Gemini request failed with HTTP ${response.status}`);
  }
  await recordProviderUse("gemini");
  return extractGeminiText(data);
}

async function callProviderText({ system, prompt, maxTokens, providerConfig, providerUsage }) {
  await enforceFreeLimit(providerConfig, providerUsage);

  const claudeKey = providerConfig.claudeApiKey || CLAUDE_API_KEY;
  const wantsClaude = providerConfig.tier === "premium" || providerConfig.preferredProvider === "claude";

  if (wantsClaude) {
    if (!claudeKey) throw new Error("Claude API key is not configured for premium routing.");
    return callClaudeText({ system, prompt, maxTokens, apiKey: claudeKey });
  }

  try {
    return await callGeminiText({ system, prompt, maxTokens, providerConfig });
  } catch (geminiError) {
    if (claudeKey && providerConfig.preferredProvider === "auto") {
      return callClaudeText({ system, prompt, maxTokens, apiKey: claudeKey });
    }
    throw geminiError;
  }
}

async function callReformat(pageText, profile, feedbackLog, providerConfig, providerUsage) {
  return callProviderText({
    system: buildSystemPrompt(profile, feedbackLog),
    prompt: `Reformat this content for my cognitive profile:\n\n${pageText}`,
    maxTokens: 2500,
    providerConfig,
    providerUsage
  });
}

async function generateSQ4RQuestions(pageText, profile, providerConfig, providerUsage) {
  if (profile.profileType === "hyperfocus") return null;
  try {
    const raw = await callProviderText({
      system: "You generate pre-reading focus questions for a neurodivergent reader. Return ONLY a JSON array of 2-3 short, concrete questions. No markdown fences.",
      prompt: `Generate focus questions for this section:\n\n${pageText.slice(0, 800)}`,
      maxTokens: 300,
      providerConfig,
      providerUsage
    });
    const questions = JSON.parse(stripCodeFence(raw));
    return Array.isArray(questions) ? questions.slice(0, 3) : null;
  } catch (e) {
    console.log("Synapse: SQ4R question generation skipped:", e.message);
    return null;
  }
}

const SECTION_SYSTEM_PROMPT = `You are a document structure analyser.
Given a block of webpage text, split it into logical reading sections.
Return ONLY a valid JSON array. Each element must have exactly three keys:
"title" - a short heading for this section, 5 words max
"content" - the full text belonging to this section
"summary" - one sentence describing what this section covers
If the page has fewer than 3 distinguishable sections, return as many as exist.
Never return fewer than 1 element.`;

async function analyseSections(pageText, providerConfig, providerUsage) {
  const raw = await callProviderText({
    system: SECTION_SYSTEM_PROMPT,
    prompt: `Analyse and split into sections:\n\n${pageText}`,
    maxTokens: 5000,
    providerConfig,
    providerUsage
  });

  let sections;
  try {
    sections = JSON.parse(stripCodeFence(raw));
  } catch (e) {
    console.error("Synapse: failed to parse sections JSON. Raw response was:", raw);
    throw new Error("The model returned malformed section JSON.");
  }
  if (!Array.isArray(sections) || sections.length === 0) throw new Error("The model returned no sections.");
  return sections.filter(section => section.title && section.content);
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

async function callClaudeWithDocument(base64Data, mediaType, profile, feedbackLog, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "pdfs-2024-09-25"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(profile, feedbackLog),
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: "Reformat the content of this document for my cognitive profile. Return valid HTML wrapped in a single <div>." }
        ]
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  await recordProviderUse("claude");
  return data.content?.[0]?.text || "";
}

async function callGeminiWithDocument(base64Data, mediaType, profile, feedbackLog, providerConfig, providerUsage) {
  await enforceFreeLimit(providerConfig, providerUsage);
  const selected = await getNextGeminiKey(providerConfig);
  if (!selected) throw new Error("No available Gemini key is configured for document reading.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(selected.key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(profile, feedbackLog) }] },
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data: base64Data } },
            { text: "Reformat this document for my cognitive profile. Return one valid HTML <div> only." }
          ]
        }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.25 }
      })
    }
  );

  const data = await response.json();
  if (!response.ok || data.error) {
    if ([429, 403].includes(response.status)) await markGeminiKeyLimited(providerConfig, selected.index);
    throw new Error(data.error?.message || `Gemini document request failed with HTTP ${response.status}`);
  }
  await recordProviderUse("gemini");
  return extractGeminiText(data);
}

async function callDocument(base64Data, mediaType, profile, feedbackLog, providerConfig, providerUsage) {
  const claudeKey = providerConfig.claudeApiKey || CLAUDE_API_KEY;
  if (providerConfig.tier === "premium" || providerConfig.preferredProvider === "claude") {
    if (!claudeKey) throw new Error("Claude API key is not configured for document reading.");
    return callClaudeWithDocument(base64Data, mediaType, profile, feedbackLog, claudeKey);
  }
  return callGeminiWithDocument(base64Data, mediaType, profile, feedbackLog, providerConfig, providerUsage);
}

async function maybeUpdateProfile(feedbackLog) {
  if (feedbackLog.length % 10 !== 0 || feedbackLog.length === 0) return;

  const { profile, providerConfig, providerUsage } = await getFullConfig();
  try {
    const raw = await callProviderText({
      system: `You are a cognitive profile updater for Synapse.
Based on feedback data, suggest minimal updates to a user's cognitive profile.
Return ONLY a valid JSON object with the same keys as the profile.
Only change values that the feedback clearly supports changing.
Do not add new keys. Do not change profileType unless missed-the-point reactions dominate.
Return the complete profile with updates applied.`,
      prompt: `Current profile:\n${JSON.stringify(profile, null, 2)}\n\nFeedback summary:\n${buildFeedbackSummary(feedbackLog)}\n\nReturn the updated profile JSON only.`,
      maxTokens: 700,
      providerConfig,
      providerUsage
    });
    const updated = JSON.parse(stripCodeFence(raw));
    await storageSet({
      cognitiveProfile: { ...defaultProfile, ...updated },
      pendingProfileUpdate: {
        ts: Date.now(),
        message: "Synapse updated your profile based on your feedback.",
        profile: updated
      }
    });
  } catch (e) {
    console.log("Synapse profile update skipped:", e.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANALYSE_SECTIONS") {
    getFullConfig()
      .then(({ providerConfig, providerUsage }) => analyseSections(msg.pageText, providerConfig, providerUsage))
      .then(sections => sendResponse({ sections }))
      .catch(err => {
        console.error("Synapse section analysis error:", err);
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (msg.type === "GET_SQ4R_QUESTIONS") {
    getFullConfig()
      .then(({ profile, providerConfig, providerUsage }) => generateSQ4RQuestions(msg.pageText, profile, providerConfig, providerUsage))
      .then(questions => sendResponse({ questions }))
      .catch(() => sendResponse({ questions: null }));
    return true;
  }

  if (msg.type === "ANALYSE_DOCUMENT") {
    getFullConfig().then(async ({ profile, feedbackLog, providerConfig, providerUsage }) => {
      try {
        const res = await fetch(msg.url);
        if (!res.ok) throw new Error(`Could not fetch document: HTTP ${res.status}`);
        const base64 = arrayBufferToBase64(await res.arrayBuffer());
        const html = await callDocument(base64, msg.mediaType, profile, feedbackLog, providerConfig, providerUsage);
        sendResponse({ html });
      } catch (err) {
        console.error("Synapse document reader error:", err);
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (msg.type === "CALL_CLAUDE" || msg.type === "CALL_LLM") {
    getFullConfig().then(async ({ profile, feedbackLog, providerConfig, providerUsage }) => {
      try {
        const html = await callReformat(msg.pageText, profile, feedbackLog, providerConfig, providerUsage);
        sendResponse({ html });
      } catch (err) {
        console.error("Synapse error:", err);
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (msg.type === "FEEDBACK") {
    chrome.storage.local.get("feedbackLog", result => {
      const log = result.feedbackLog || [];
      log.push(msg.entry);
      const trimmed = log.slice(-50);
      chrome.storage.local.set({ feedbackLog: trimmed }, () => {
        maybeUpdateProfile(trimmed);
        sendResponse({ ok: true });
      });
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
