// ================================================================
// SYNAPSE EXPLAIN — wiring
// Floating button behaviour, the document-page prompt (PDFs add "Open in
// Synapse viewer"), the history button,
// history loading/repainting, background messages, and SPA URL changes.
// Loaded last. On content-script pages it initialises itself; an extension
// page (the PDF viewer) calls SynapseExplain.init({...}) — see host.js.
// ================================================================
(function () {
  'use strict';
  const SX = globalThis.SynapseExplain;
  if (!SX || SX.init) return;
  const G = SX.G;
  const H = SX.H;
  const st = SX.state;
  if (H.FEATURES.articleMode) return;

  const HISTORY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>`;

  let fab = null;
  let historyBtn = null;
  let menu = null;

  // ── FAB ────────────────────────────────────────────────────────
  function onFabClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (SX.isCircling()) { SX.cancelCircle(); return; }
    if (hasDocumentPrompt()) { menu ? SX.closeFabMenu() : openFabMenu(); return; }
    SX.startCircle('click');
  }

  // ── Document prompt ────────────────────────────────────────────
  function hasDocumentPrompt() {
    return !!(H.S.documentType && H.canOpenReader());
  }

  /** PDFs on web/file pages (not already inside the Synapse viewer) can open in the viewer. */
  function canOpenViewer() {
    return H.S.documentType?.mime === 'application/pdf' && !H.isExtensionPage && /^(https?|file):$/.test(location.protocol);
  }

  async function openViewer() {
    const res = await SX.send({ type: 'OPEN_PDF_VIEWER', url: location.href });
    if (!res || !res.ok) SX.showTip((res && res.error) || "Couldn't open the Synapse viewer.", { message: true, duration: 3200 });
  }

  function openFabMenu() {
    SX.injectStyles();
    const label = H.S.documentType?.label || 'document';
    menu = document.createElement('div');
    menu.id = 'synapse-fab-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Synapse');
    const viewerItem = canOpenViewer() ? `
      <button type="button" role="menuitem" data-action="viewer">
        <span class="sxm-ico" aria-hidden="true">▤</span>
        <span><span>Open in Synapse viewer</span><span class="sxm-sub">Highlight and circle inside this PDF</span></span>
      </button>` : '';
    menu.innerHTML = `
      <span class="sxm-label">Synapse</span>${viewerItem}
      <button type="button" role="menuitem" data-action="circle">
        <span class="sxm-ico" aria-hidden="true">◎</span>
        <span><span>Circle something</span><span class="sxm-sub">Trace around anything to explain it</span></span>
      </button>
      <button type="button" role="menuitem" data-action="read">
        <span class="sxm-ico" aria-hidden="true">Aa</span>
        <span><span>Read this document</span><span class="sxm-sub">Rebuild this ${SX.escapeHTML(label)} for your brain</span></span>
      </button>`;
    document.body.appendChild(menu);
    fab.setAttribute('aria-expanded', 'true');
    historyBtn?.classList.add('s-suppressed');

    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    items[0].focus({ preventScroll: true });

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      SX.closeFabMenu();
      if (action === 'circle') SX.startCircle('click');
      else if (action === 'viewer') openViewer();
      else H.openReader();
    });

    menu.addEventListener('keydown', (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); SX.closeFabMenu(); fab.focus({ preventScroll: true }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') { SX.closeFabMenu(); }
    });
  }

  SX.closeFabMenu = function () {
    if (!menu) return;
    menu.remove();
    menu = null;
    fab?.setAttribute('aria-expanded', 'false');
    historyBtn?.classList.remove('s-suppressed');
  };

  // ── History button ─────────────────────────────────────────────
  function buildHistoryButton() {
    historyBtn = document.createElement('button');
    historyBtn.id = 'synapse-history-btn';
    historyBtn.type = 'button';
    historyBtn.innerHTML = `${HISTORY_ICON}<span class="sxh-count"></span>`;
    historyBtn.addEventListener('click', (e) => { e.stopPropagation(); SX.closeFabMenu(); SX.togglePanel(); });
    // Right after the FAB so `#synapse-fab:hover ~ #synapse-history-btn` works
    // and Tab order goes FAB -> history.
    fab.insertAdjacentElement('afterend', historyBtn);
    updateHistoryButton();
  }

  function updateHistoryButton() {
    if (!historyBtn) return;
    const n = st.history.length;
    historyBtn.classList.toggle('s-has-history', n > 0);
    historyBtn.querySelector('.sxh-count').textContent = n ? String(Math.min(n, 99)) : '';
    const label = n ? `Synapse explanations on this site (${n})` : 'Synapse explanations on this site';
    historyBtn.setAttribute('aria-label', label);
    historyBtn.title = label;
  }

  SX.onHistoryChanged = updateHistoryButton;
  SX.onPanelToggle = (open) => historyBtn?.setAttribute('aria-expanded', String(open));

  // ── History load + repaint ─────────────────────────────────────
  let retryTimer = null;
  SX.loadHistory = async function (opts) {
    const res = await SX.send({ type: 'GET_EXPLAIN_HISTORY', hostname: st.hostname });
    if (!res || !res.ok) return;
    SX.setHistory(res.entries || [], res.source);
    // Drop highlights whose entries were deleted elsewhere (other tab/device).
    const ids = new Set(st.history.map(e => e.id));
    for (const key of Array.from(st.highlights.keys())) {
      if (!key.startsWith('pending-') && !ids.has(key)) st.highlights.delete(key);
    }
    SX.repaintHighlights();
    if (opts && opts.repaint === false) return;
    const missing = SX.paintAllEntries();
    // Late-rendering pages: one quiet retry for quotes not found yet.
    clearTimeout(retryTimer);
    if (missing.length) retryTimer = setTimeout(() => SX.paintAllEntries(), 2000);
  };

  // ── SPA URL changes ────────────────────────────────────────────
  function onUrlMaybeChanged() {
    const key = G.pageKey(H.pageUrl());
    if (key === st.pageKey) return;
    SX.refreshPageIdentity();
    for (const k of Array.from(st.highlights.keys())) if (!k.startsWith('pending-')) st.highlights.delete(k);
    SX.repaintHighlights();
    SX.cancelCircle?.();
    SX.hideBubble?.();
    // Give the new view a moment to render before searching for quotes.
    setTimeout(() => SX.loadHistory({ repaint: true }), 600);
  }

  function watchUrl() {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', onUrlMaybeChanged);
    }
    window.addEventListener('popstate', onUrlMaybeChanged);
    window.addEventListener('hashchange', onUrlMaybeChanged);
    // Fallback for history.pushState from the page's world, which isolated
    // worlds cannot observe directly. Cheap string compare once a second.
    setInterval(onUrlMaybeChanged, 1000);
  }

  // ── Background messages ────────────────────────────────────────
  function onRuntimeMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'EXPLAIN_HISTORY_ADDED') {
      if (msg.entry && (msg.hostname || '').toLowerCase() === st.hostname) SX.upsertHistory(msg.entry);
    } else if (msg.type === 'EXPLAIN_CAPTURE_DONE') {
      SX.onCaptureDone?.();
    }
  }

  // ── Outside click closes the document prompt ───────────────────
  function onOutsideClick(e) {
    if (menu && !menu.contains(e.target) && e.target !== fab && !(fab && fab.contains(e.target))) SX.closeFabMenu();
  }

  /**
   * Uploads the current document for document context ahead of the first
   * explain (optional; explains upload on demand). Resolves to the
   * background's { ok, contextId?, error? }.
   */
  SX.prepareDocument = function (data) {
    const src = H.documentSource();
    if (!src) return Promise.resolve({ ok: false, error: 'No document on this page.' });
    if (SX.contextPolicy && !SX.contextPolicy().allowed) return Promise.resolve({ ok: false, error: 'Page context is off here.' });
    // data: { base64?, text? } for local files, which the background can't read.
    const msg = { type: 'PREPARE_DOCUMENT_CONTEXT', url: src.url, mediaType: src.mediaType };
    if (data && data.base64) msg.documentBase64 = data.base64;
    if (data && typeof data.text === 'string') msg.text = data.text;
    return SX.send(msg).then(res => {
      if (res && res.ok && res.contextId) st.documentContextReady = true;
      return res;
    });
  };

  // ── Init ───────────────────────────────────────────────────────
  function wireFab() {
    fab = document.getElementById('synapse-fab');
    if (!fab || fab.dataset.synapseExplain) return;
    fab.dataset.synapseExplain = '1';
    fab.type = 'button';
    if (hasDocumentPrompt()) {
      fab.setAttribute('aria-haspopup', 'menu');
      fab.setAttribute('aria-expanded', 'false');
      fab.setAttribute('aria-label', canOpenViewer()
        ? 'Synapse: open in the Synapse viewer, circle something, or read this document'
        : 'Synapse: circle something or read this document');
      fab.title = 'Synapse';
    } else {
      fab.setAttribute('aria-label', 'Synapse: circle something to explain it (or hold Alt+S)');
      fab.title = 'Circle something to explain (or hold Alt+S)';
    }
    fab.addEventListener('click', onFabClick);
    buildHistoryButton();
  }

  let started = false;
  /**
   * Starts the explain flow. Content-script pages call this automatically.
   * Extension pages call it themselves with host options (see host.js):
   * { document: { url, mediaType, title? }, contentRoot, openReader }.
   * Calling it again reconfigures and reloads history.
   */
  SX.init = function (opts) {
    if (opts) H.configure(opts);
    SX.refreshPageIdentity();
    SX.injectStyles();
    wireFab();
    if (!started) {
      started = true;
      SX.initialized = true;
      SX.initCircle();
      SX.initHighlight();
      watchUrl();
      try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_) { /* no runtime */ }
      document.addEventListener('click', onOutsideClick, true);
    }
    SX.loadContextSettings?.();
    SX.loadHistory({ repaint: true });
    return SX;
  };

  // Web pages: content.js has built the FAB. Extension pages wait for init().
  if (H.hasContentScript && document.getElementById('synapse-fab')) SX.init();
})();
