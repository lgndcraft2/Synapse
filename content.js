// ============================================
// SYNAPSE 2.0 — FLOATING UI + CONTENT SCRIPT
// ============================================

let synapseOriginalContent = null;
let synapseActive = false;
let panelVisible = false;

// ─── Extract page text ───────────────────────
function extractPageText() {
  const main = document.querySelector(
    'main, article, [role="main"], .content, #content'
  );
  const target = main || document.body;
  const clone = target.cloneNode(true);
  clone.querySelectorAll('script, style, nav, footer, header')
       .forEach(el => el.remove());
  return clone.innerText.slice(0, 8000);
}

// ─── Inject Synapse styles ───────────────────
function injectSynapseStyles() {
  if (document.getElementById('synapse-styles')) return;
  const style = document.createElement('style');
  style.id = 'synapse-styles';
  style.textContent = `
    /* ── Floating button ── */
    #synapse-fab {
      position: fixed;
      bottom: 32px;
      right: 32px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #1D9E75;
      border: none;
      cursor: pointer;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background 0.2s;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    }
    #synapse-fab:hover {
      background: #0F6E56;
      transform: scale(1.08);
    }
    #synapse-fab svg {
      width: 22px;
      height: 22px;
      fill: white;
    }

    /* ── Floating panel ── */
    #synapse-panel {
      position: fixed;
      bottom: 92px;
      right: 32px;
      width: 260px;
      background: #ffffff;
      border: 0.5px solid #e0e0e0;
      border-radius: 16px;
      z-index: 2147483646;
      font-family: -apple-system, 'Segoe UI', sans-serif;
      overflow: hidden;
      transform: scale(0.92) translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.2s cubic-bezier(0.16,1,0.3,1),
                  opacity 0.2s ease;
    }
    #synapse-panel.visible {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: all;
    }
    #synapse-panel-header {
      padding: 14px 16px 10px;
      border-bottom: 0.5px solid #f0f0f0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #synapse-panel-header .synapse-logo {
      font-size: 13px;
      font-weight: 700;
      color: #1D9E75;
      letter-spacing: -0.01em;
    }
    #synapse-panel-header .synapse-tagline {
      font-size: 11px;
      color: #aaa;
    }
    #synapse-panel-body {
      padding: 12px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #synapse-status-text {
      font-size: 12px;
      color: #888;
      min-height: 18px;
      text-align: center;
      padding: 0 4px;
    }
    #synapse-status-text.success { color: #1D9E75; }
    #synapse-status-text.error   { color: #e74c3c; }
    #synapse-status-text.loading { color: #888; }

    .synapse-btn {
      width: 100%;
      padding: 9px 14px;
      border-radius: 9px;
      font-size: 13px;
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s, transform 0.1s;
      text-align: center;
    }
    .synapse-btn:active { transform: scale(0.97); }
    .synapse-btn.primary {
      background: #1D9E75;
      color: #fff;
    }
    .synapse-btn.primary:hover { background: #0F6E56; }
    .synapse-btn.primary:disabled {
      background: #9FE1CB;
      cursor: not-allowed;
    }
    .synapse-btn.secondary {
      background: #f5f5f5;
      color: #333;
    }
    .synapse-btn.secondary:hover { background: #ececec; }

    /* ── Loading spinner ── */
    .synapse-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: synapse-spin 0.7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes synapse-spin {
      to { transform: rotate(360deg); }
    }

    /* ── Active indicator on FAB ── */
    #synapse-fab.active {
      background: #0F6E56;
    }
    #synapse-fab .synapse-dot {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #FFD700;
      border: 2px solid #fff;
      display: none;
    }
    #synapse-fab.active .synapse-dot {
      display: block;
    }

    /* ── Reformatted content styles ── */
    .synapse-content {
      font-family: 'Segoe UI', system-ui, sans-serif;
      max-width: 780px;
      margin: 0 auto;
      padding: 28px 32px;
      line-height: 1.75;
      color: #1a1a1a;
    }
    .synapse-content h1,
    .synapse-content h2 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #111;
      margin: 1.75rem 0 0.6rem;
      padding-bottom: 6px;
      border-bottom: 2px solid #1D9E75;
    }
    .synapse-content h3 {
      font-size: 1rem;
      font-weight: 600;
      color: #333;
      margin: 1.25rem 0 0.4rem;
    }
    .synapse-content p {
      font-size: 1rem;
      color: #333;
      margin-bottom: 1rem;
    }
    .synapse-content ul,
    .synapse-content ol {
      padding-left: 1.4rem;
      margin-bottom: 1rem;
    }
    .synapse-content li {
      margin-bottom: 0.5rem;
      font-size: 1rem;
      color: #333;
    }
    .synapse-content strong { color: #111; font-weight: 600; }
    .synapse-content mark {
      background: #e8f8f2;
      color: #085041;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
    }
    .synapse-content a { color: #1D9E75; text-underline-offset: 3px; }
    .synapse-content table { width: 100%; border-collapse: collapse; margin-bottom: 1.25rem; }
    .synapse-content th {
      background: #f0faf6;
      color: #085041;
      font-weight: 600;
      padding: 10px 14px;
      text-align: left;
      border-bottom: 2px solid #1D9E75;
    }
    .synapse-content td {
      padding: 10px 14px;
      border-bottom: 1px solid #eee;
      color: #333;
    }
    .synapse-content input[type="text"],
    .synapse-content input[type="email"],
    .synapse-content input[type="password"],
    .synapse-content input[type="search"],
    .synapse-content textarea,
    .synapse-content select {
      width: 100%;
      padding: 10px 14px;
      font-size: 1rem;
      font-family: inherit;
      border: 1.5px solid #ddd;
      border-radius: 8px;
      margin-bottom: 12px;
      outline: none;
      background: #fafafa;
    }
    .synapse-content input:focus,
    .synapse-content textarea:focus,
    .synapse-content select:focus {
      border-color: #1D9E75;
      background: #fff;
    }
    .synapse-content button,
    .synapse-content input[type="submit"] {
      padding: 10px 20px;
      font-size: 0.95rem;
      font-weight: 500;
      color: #fff;
      background: #1D9E75;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .synapse-content button:hover { background: #0F6E56; }
  `;
  document.head.appendChild(style);
}

// ─── Build the floating UI ───────────────────
function buildFloatingUI() {
  if (document.getElementById('synapse-fab')) return;

  injectSynapseStyles();

  // FAB button
  const fab = document.createElement('button');
  fab.id = 'synapse-fab';
  fab.title = 'Synapse 2.0';
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
               10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4
               0h-2V8h2v8z"/>
    </svg>
    <span class="synapse-dot"></span>
  `;

  // Panel
  const panel = document.createElement('div');
  panel.id = 'synapse-panel';
  panel.innerHTML = `
    <div id="synapse-panel-header">
      <div>
        <div class="synapse-logo">Synapse 2.0</div>
        <div class="synapse-tagline">Your cognitive layer</div>
      </div>
    </div>
    <div id="synapse-panel-body">
      <div id="synapse-status-text">Ready to reformat</div>
      <button class="synapse-btn primary" id="synapse-reformat-btn">
        Reformat this page
      </button>
      <button class="synapse-btn secondary" id="synapse-revert-btn"
              style="display:none">
        Revert to original
      </button>
    </div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // Toggle panel on FAB click
  fab.addEventListener('click', () => {
    panelVisible = !panelVisible;
    panel.classList.toggle('visible', panelVisible);
  });

  // Close panel if user clicks outside
  document.addEventListener('click', (e) => {
    if (!fab.contains(e.target) && !panel.contains(e.target)) {
      panelVisible = false;
      panel.classList.remove('visible');
    }
  });

  // Reformat button
  document.getElementById('synapse-reformat-btn')
    .addEventListener('click', handleReformat);

  // Revert button
  document.getElementById('synapse-revert-btn')
    .addEventListener('click', handleRevert);
}

// ─── Set status text ─────────────────────────
function setStatus(msg, type = 'default') {
  const el = document.getElementById('synapse-status-text');
  if (!el) return;
  el.textContent = msg;
  el.className = type;
}

// ─── Reformat handler ────────────────────────
function handleReformat() {
  const btn = document.getElementById('synapse-reformat-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="synapse-spinner"></span>Reformatting...';
  setStatus('Claude is rebuilding this page...', 'loading');

  const pageText = extractPageText();

  chrome.runtime.sendMessage(
    { type: "CALL_LLM", pageText },
    (response) => {
      btn.disabled = false;
      btn.textContent = 'Reformat this page';

      if (response && response.html) {
        injectReformattedContent(response.html);
        setStatus('Page reformatted', 'success');
        document.getElementById('synapse-revert-btn').style.display = 'block';
        document.getElementById('synapse-fab').classList.add('active');
      } else {
        setStatus(response?.error || 'Something went wrong', 'error');
      }
    }
  );
}

// ─── Revert handler ──────────────────────────
function handleRevert() {
  if (synapseOriginalContent) {
    const main = document.querySelector(
      'main, article, [role="main"], .content, #content'
    ) || document.body;
    main.innerHTML = synapseOriginalContent;
    synapseOriginalContent = null;
    synapseActive = false;
  }
  setStatus('Reverted to original', 'default');
  document.getElementById('synapse-revert-btn').style.display = 'none';
  document.getElementById('synapse-fab').classList.remove('active');
}

// ─── Inject reformatted content ──────────────
function injectReformattedContent(html) {
  const main = document.querySelector(
    'main, article, [role="main"], .content, #content'
  ) || document.body;

  if (!synapseOriginalContent) {
    synapseOriginalContent = main.innerHTML;
  }

  main.innerHTML = `<div class="synapse-content">${html}</div>`;
  synapseActive = true;
}

// ─── Init ────────────────────────────────────
buildFloatingUI();