const CLAUDE_MODEL = "claude-sonnet-4-6";
const GEMINI_MODEL = "gemini-2.5-flash";

const defaultProfile = {
  preferredFormat: "bullet points",
  chunkSize: "short", // short | medium | long paragraphs
  needsExamplesFirst: true, // concrete before abstract
  maxNestingDepth: 2, // don't go deeper than 2 levels of bullet nesting
  useHeaders: true, // break content into labelled sections
  simplifyVocab: false, // rewrite jargon into plain language
  notes: "" // free text from the user
};

// function buildSystemPrompt(profile) {
//   return `You are Synapse 2.0. Reformat page content for this cognitive profile:

// Preferred format: ${profile.preferredFormat}
// Chunk size: ${profile.chunkSize} paragraphs
// Examples before concepts: ${profile.needsExamplesFirst}
// Max bullet nesting depth: ${profile.maxNestingDepth}
// Use section headers: ${profile.useHeaders}
// Simplify vocabulary: ${profile.simplifyVocab}
// User notes: ${profile.notes || "none"}

// Return ONLY a single 
//  of valid HTML with inline styles.
// Keep all information. Only change the structure and presentation.
// Do not add any explanation or text outside the HTML.`;
// }

// Build the system prompt from the user's cognitive profile
function buildSystemPrompt(profile) {
  return `You are Synapse 2.0, a cognitive accessibility assistant.
The user has the following cognitive profile:
${JSON.stringify(profile, null, 2)}

Reformat the page content into clean semantic HTML.

Rules:
- Return ONLY a single <div> of valid HTML. No inline styles.
- Use semantic tags: <h2> sections, <h3> subsections, <p> paragraphs,
  <ul>/<li> lists, <strong> key terms, <mark> important concepts.
- PRESERVE all interactive elements: forms, inputs, buttons, selects,
  checkboxes, radio buttons, links. Do not remove or skip them.
- For buttons: use class="secondary" for cancel/back actions,
  class="danger" for delete/destructive actions.
- Wrap label + input pairs in <div class="form-group">.
- Structure layout based on the cognitive profile.
- Keep ALL information and ALL functionality.
- No markdown, no explanation, no text outside the HTML div.`;
}

function getStoredConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["cognitiveProfile", "apiKeys"], (result) => {
      resolve({
        profile: result.cognitiveProfile || null,
        apiKeys: result.apiKeys || {}
      });
    });
  });
}

function getApiKey(provider, apiKeys) {
  if (provider === "gemini") {
    return apiKeys.gemini || "";
  }

  return apiKeys.claude || "";
}

// Call Claude API
async function callClaude(pageText, profile, apiKey) {
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
      system: buildSystemPrompt(profile),
      messages: [
        {
          role: "user",
          content: `Reformat this page content for my cognitive profile:\n\n${pageText}`
        }
      ]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  // Extract the HTML from Claude's response
  return data.content[0].text;
}

// Call Gemini API
async function callGemini(pageText, profile, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Reformat this page content for my cognitive profile:\n\n${pageText}`
              }
            ]
          }
        ],
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(defaultProfile) }]
        },
        generationConfig: {
          temperature: 0.3
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const message = data.error?.message || `Gemini request failed with ${response.status}`;
    throw new Error(message);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return text;
}

async function callProvider(pageText, profile) {
  const provider = (profile.provider || "claude").toLowerCase();
  const { apiKeys } = await getStoredConfig();
  const apiKey = getApiKey(provider, apiKeys);

  if (provider === "gemini") {
    if (!apiKey) {
      throw new Error("Gemini API key is not configured in background.js.");
    }
    return callGemini(pageText, profile, apiKey);
  }

  if (!apiKey) {
    throw new Error("Claude API key is not configured in background.js.");
  }

  return callClaude(pageText, profile, apiKey);
}

// Listen for messages from content.js or popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "CALL_CLAUDE" || msg.type === "CALL_LLM") {
    // Load the profile from storage, then call the selected provider
    chrome.storage.local.get("cognitiveProfile", async (result) => {
      const profile = result.cognitiveProfile || {
        provider: "claude",
        preferredFormat: "bullet points",
        readingLevel: "normal",
        notes: "No profile set yet. Use sensible defaults."
      };

      try {
        const html = await callProvider(msg.pageText, profile);
        sendResponse({ html });
      } catch (err) {
        console.error("Synapse model error:", err);
        sendResponse({ error: err.message });
      }
    });

    return true; // async — keep channel open
  }

  if (msg.type === "SAVE_PROFILE") {
    chrome.storage.local.set({ cognitiveProfile: msg.profile, apiKeys: msg.apiKeys || {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "GET_PROFILE") {
    chrome.storage.local.get("cognitiveProfile", (result) => {
      sendResponse({ profile: result.cognitiveProfile || null });
    });
    return true;
  }

});