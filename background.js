const CLAUDE_MODEL = "claude-sonnet-4-6";

// ================================================================
// API KEY — hardcoded for shared use
// NOTE: visible to anyone who inspects the extension files.
// ================================================================

const defaultProfile = {
  preferredFormat:    "bullet points",
  chunkSize:          "short",
  needsExamplesFirst: true,
  maxNestingDepth:    2,
  useHeaders:         true,
  simplifyVocab:      false,
  profileType:        "load-reducer", // "load-reducer" | "comprehension-gap" | "hyperfocus"
  notes:              ""
};

// ================================================================
// SYSTEM PROMPT — injects profile + feedback history
// ================================================================
function buildProfileInstructions(profile) {
  const chunkDesc = {
    short:  'Keep each section concise — 2 to 3 sentences maximum per point.',
    medium: 'Use moderate length — enough detail to be clear, but no padding.',
    long:   'Be thorough — include full context and nuance for each point.',
  }[profile.chunkSize] || 'Keep sections concise.';

  // ── Base formatting rules (shared across all profiles) ──
  const base = [
    `Format: Present all content as ${profile.preferredFormat}.`,
    chunkDesc,
    profile.needsExamplesFirst
      ? 'Always lead with a concrete example BEFORE giving the explanation or rule.'
      : 'Give the explanation or concept first, then follow with examples.',
    profile.simplifyVocab
      ? 'Use plain, everyday language. Replace jargon and technical terms with simpler alternatives where possible.'
      : 'Preserve the original technical vocabulary — do not dumb down terminology.',
    profile.useHeaders
      ? 'Add a clear <h2> or <h3> header to each section to aid navigation.'
      : 'Do not add headers — present content as a continuous flow.',
    `Maximum nesting depth for lists: ${profile.maxNestingDepth} level${profile.maxNestingDepth > 1 ? 's' : ''}. Do not nest deeper than this.`,
  ];

  // ── Profile-type-specific cognitive strategy ──
  const strategy = {

    // Profile 1: High cognitive load — dyslexic, working memory issues, ADHD focus struggles
    "load-reducer": [
      'COGNITIVE STRATEGY: This user has high reading load. Your primary job is reducing cognitive friction.',
      'Lead with the single most important point. Everything else is secondary.',
      'Break any sentence longer than 20 words into two sentences.',
      'Never introduce more than one new concept per paragraph or bullet.',
      'Use <mark> on the single most critical term or phrase per section — no more than one.',
      'Avoid nested structures unless absolutely necessary for meaning.',
    ],

    // Profile 2: Comprehension gap — autistic, decodes fine but loses meaning/subtext
    "comprehension-gap": [
      'COGNITIVE STRATEGY: This user reads fluently but loses meaning. Your job is making implicit things explicit.',
      'After each key paragraph or point, add a one-sentence plain-language interpretation: what the author actually means.',
      'Surface subtext: if the author is implying something rather than stating it, state it directly.',
      'Identify the single core argument of the section and state it clearly at the top.',
      'If there are multiple valid interpretations of a sentence, flag this explicitly.',
      'Connect each new point to the previous one with a brief bridging sentence.',
      'Avoid relying on tone or implication — be literal and direct.',
    ],

    // Profile 3: Hyperfocus reader — reads a lot, needs organization and retention, not simplification
    "hyperfocus": [
      'COGNITIVE STRATEGY: This user is a strong reader who hyperfocuses. Your job is structure and retention, not simplification.',
      'Do NOT simplify vocabulary or water down nuance — preserve full technical depth.',
      'Provide a 2-line "takeaway" at the end of each section summarizing the key idea for later recall.',
      'Use consistent heading hierarchy so the user can navigate non-linearly.',
      'Bold key terms and novel concepts — this user scans fast and needs anchors.',
      'If the section contains a list of related items, group them by theme.',
      'Preserve the original argument structure — this user wants to engage with the author\'s reasoning, not a flattened version.',
    ],

  }[profile.profileType] || [];

  const lines = [...base, '', ...strategy];

  if (profile.notes?.trim()) {
    lines.push(`\nDirect note from the user: "${profile.notes.trim()}"`);
  }

  return lines.join('\n');
}

function buildSystemPrompt(profile, feedbackLog) {
  const feedbackSummary = buildFeedbackSummary(feedbackLog);

  return `You are Synapse, a cognitive accessibility assistant.
Your job is to reformat page content into HTML that works best for this specific user's brain.

── HOW THIS USER NEEDS CONTENT PRESENTED ──
${buildProfileInstructions(profile)}

── WHAT YOU HAVE LEARNED FROM THIS USER'S FEEDBACK ──
${feedbackSummary}

── RULES ──
- Return ONLY a single <div> of valid HTML. No markdown, no explanation, no preamble.
- Use proper semantic tags: <h2> sections, <h3> subsections, <p> paragraphs,
  <ul>/<li> lists, <strong> key terms, <mark> for important concepts.
- Follow the user's presentation instructions above precisely.
- Keep ALL original information — only restructure the presentation.
- No inline styles. Classes and semantic tags only.
- Do not add any text, commentary or wrapper outside the single <div>.`;
}

// ================================================================
// SQ4R — Pre-reading question generator
// Fires for load-reducer and comprehension-gap profiles.
// Returns an array of 2-3 question strings, or null if skipped.
// ================================================================
async function generateSQ4RQuestions(pageText, profile) {
  if (profile.profileType === "hyperfocus") return null;

  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
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
        max_tokens: 300,
        system: `You generate pre-reading focus questions for a neurodivergent reader.
Given a section of text, return ONLY a JSON array of 2-3 short questions the reader should
try to answer as they read. Questions should be concrete and specific to this text.
No preamble, no markdown fences. Return raw JSON array only. Example: ["What problem does this solve?","Who does this affect?"]`,
        messages: [{
          role: "user",
          content: `Generate focus questions for this section:\n\n${pageText.slice(0, 600)}`
        }]
      })
    });

    const data = await response.json();
    if (data.error) return null;

    const raw = data.content[0].text.trim().replace(/```json|```/gi, "").trim();
    const questions = JSON.parse(raw);
    return Array.isArray(questions) ? questions.slice(0, 3) : null;
  } catch (e) {
    console.log("Synapse: SQ4R question generation skipped:", e.message);
    return null;
  }
}

// ================================================================
// FEEDBACK SUMMARY — converts raw log into useful prompt context
// ================================================================
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
  summary += `- Reactions: ${counts.clearer} "clearer", ${counts.complex} "too complex", ${counts.simple} "too simple", ${counts["off-topic"]} "off-topic"\n`;
  summary += `- Average time reading a card: ${avgTime} seconds\n`;
  summary += `- Average scroll depth: ${avgRead}%\n`;
  if (hardSessions > 0) {
    summary += `- ${hardSessions} sessions where user reported a hard reading day. On hard days, use shorter chunks and simpler sentences even if the profile says otherwise.\n`;
  }

  if (counts.complex > counts.clearer) {
    summary += `- IMPORTANT: This user frequently finds reformats too complex. Simplify further — shorter sentences, fewer nested points, more white space.\n`;
  }
  if (counts.simple > counts.clearer) {
    summary += `- IMPORTANT: This user finds reformats too simplified. Add more detail and preserve nuance.\n`;
  }
  if (counts["off-topic"] > 2) {
    summary += `- IMPORTANT: This user frequently finds reformats miss the point. Focus harder on the central argument — don't bury it in supporting detail.\n`;
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
      ["cognitiveProfile", "feedbackLog"],
      (result) => {
        resolve({
          profile: { ...defaultProfile, ...(result.cognitiveProfile || {}) },
          feedbackLog: result.feedbackLog || [],
        });
      }
    );
  });
}

function getApiKey() {
  return CLAUDE_API_KEY;
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
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
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
// REFORMAT ROUTER
// ================================================================
async function callProvider(pageText, profile, feedbackLog) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Claude API key is not configured.");
  return callClaude(pageText, profile, feedbackLog, apiKey);
}

// ================================================================
// DOCUMENT READER (PDF / TXT / CSV sent as base64 to Claude)
// ================================================================
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function callClaudeWithDocument(base64Data, mediaType, profile, feedbackLog) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Claude API key is not configured.");

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
          {
            type: "document",
            source: { type: "base64", media_type: mediaType, data: base64Data }
          },
          {
            type: "text",
            text: "Reformat the content of this document for my cognitive profile. Return valid HTML wrapped in a single <div>."
          }
        ]
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ================================================================
// SECTION ANALYSER
// ================================================================
const SECTION_SYSTEM_PROMPT = `You are a document structure analyser.
Given a block of webpage text, split it into logical reading sections.
Return ONLY a valid JSON array. Each element must have exactly three keys:
  "title"   — a short heading for this section (5 words max)
  "content" — the full text belonging to this section
  "summary" — one sentence describing what this section covers
If the page has fewer than 3 distinguishable sections, return as many as exist.
Never return fewer than 1 element.`;

async function analyseSections(pageText) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Claude API key is not configured.");

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
      max_tokens: 9500,
      system: SECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Analyse and split into sections:\n\n${pageText}` }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content[0].text;
  if (!raw) throw new Error("Empty response from LLM.");

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

  return sections.filter(s => s.title && s.content);
}

// ================================================================
// PROFILE AUTO-UPDATE
// — After every 10 feedback entries, propose a profile amendment.
// Bug fix: profile was referenced from outer scope without being
// passed in. Now fetches it properly before updating.
// ================================================================
async function maybeUpdateProfile(feedbackLog) {
  if (feedbackLog.length % 10 !== 0 || feedbackLog.length === 0) return;

  const apiKey = getApiKey();
  if (!apiKey) return;

  const { profile } = await getFullConfig();
  const summary = buildFeedbackSummary(feedbackLog);

  try {
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
        max_tokens: 500,
        system: `You are a cognitive profile updater for Synapse.
Based on feedback data, suggest minimal updates to a user's cognitive profile.
Return ONLY a valid JSON object with the same keys as the profile.
Only change values that the feedback clearly supports changing.
Do not add new keys. Do not change profileType unless off-topic reactions dominate.
Return the complete profile with updates applied.`,
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

    chrome.storage.local.set({
      cognitiveProfile: { ...defaultProfile, ...updated },
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
    (async () => {
      try {
        const sections = await analyseSections(msg.pageText);
        sendResponse({ sections });
      } catch (err) {
        console.error("Synapse section analysis error:", err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── SQ4R pre-reading questions ──
  if (msg.type === "GET_SQ4R_QUESTIONS") {
    getFullConfig().then(async ({ profile }) => {
      try {
        const questions = await generateSQ4RQuestions(msg.pageText, profile);
        sendResponse({ questions });
      } catch (err) {
        sendResponse({ questions: null });
      }
    });
    return true;
  }

  // ── Document reader (PDF / TXT / CSV) ──
  if (msg.type === "ANALYSE_DOCUMENT") {
    getFullConfig().then(async ({ profile, feedbackLog }) => {
      try {
        const res = await fetch(msg.url);
        if (!res.ok) throw new Error(`Could not fetch document: HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const html   = await callClaudeWithDocument(base64, msg.mediaType, profile, feedbackLog);
        sendResponse({ html });
      } catch (err) {
        console.error("Synapse document reader error:", err);
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  // ── Reformat request ──
  if (msg.type === "CALL_CLAUDE" || msg.type === "CALL_LLM") {
    getFullConfig().then(async ({ profile, feedbackLog }) => {
      try {
        const html = await callProvider(msg.pageText, profile, feedbackLog);
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
    chrome.storage.local.get("feedbackLog", (result) => {
      const log = result.feedbackLog || [];
      log.push(msg.entry);
      const trimmed = log.slice(-50);
      chrome.storage.local.set({ feedbackLog: trimmed }, () => {
        maybeUpdateProfile(trimmed);
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Save profile ──
  if (msg.type === "SAVE_PROFILE") {
    chrome.storage.local.set(
      { cognitiveProfile: { ...defaultProfile, ...msg.profile } },
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

// ================================================================
// FIRST INSTALL — open onboarding tab
// ================================================================
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});