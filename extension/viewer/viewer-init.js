// ================================================================
// SYNAPSE PDF VIEWER — explain wiring (classic script)
// Loaded after the explain scripts and before viewer.js (a deferred module),
// as described at the bottom of explain/host.js. Owns everything Synapse:
// SynapseExplain.init with the ORIGINAL PDF URL, the toolbar's Circle /
// Explanations / Read buttons, the document reader overlay, and repainting
// green highlights as pages' text layers render.
// viewer.js talks to this file through globalThis.SynapseViewerHost.
// ================================================================
(function () {
  'use strict';

  const MEDIA_TYPE = 'application/pdf';
  const SX = globalThis.SynapseExplain;

  /** The original PDF URL from ?file=, or null when missing/unsupported. */
  function readFileParam() {
    const raw = new URLSearchParams(location.search).get('file');
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (!/^(https?|file):$/.test(u.protocol)) return null;
    return u.href;
  }

  function fileNameOf(url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      return last || u.hostname || 'PDF';
    } catch (_) {
      return 'PDF';
    }
  }

  const fileUrl = readFileParam();
  const isLocal = !!fileUrl && fileUrl.startsWith('file:');
  const readOnOpen = new URLSearchParams(location.search).get('read') === '1';
  let localBytes = null;   // Uint8Array of a file:// PDF (the worker can't read it)
  let localBase64 = null;  // encoded once, on first use
  let title = fileUrl ? fileNameOf(fileUrl) : 'PDF';
  let paintTimer = null;
  let started = false;

  function localDocumentBase64() {
    if (!localBytes) return null;
    if (!localBase64) {
      let binary = '';
      for (let i = 0; i < localBytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, localBytes.subarray(i, i + 8192));
      }
      localBase64 = btoa(binary);
    }
    return localBase64;
  }

  // ── Document reader ("Read with Synapse") ──────────────────────
  // Same structure as content.js's reader so the explain scripts treat its
  // rebuilt content as explainable (highlight/circle inside the reader).
  let readerBusy = false;

  function closeReader() {
    const reader = document.getElementById('synapse-reader-overlay');
    if (!reader) return;
    reader.classList.remove('s-visible');
    document.getElementById('readBtn')?.setAttribute('aria-pressed', 'false');
    setTimeout(() => { if (!reader.classList.contains('s-visible')) reader.remove(); }, 250);
    document.getElementById('readBtn')?.focus({ preventScroll: true });
  }

  function openReader() {
    if (!fileUrl || readerBusy || (isLocal && !localBytes)) return;
    let reader = document.getElementById('synapse-reader-overlay');
    if (reader && reader.classList.contains('s-visible')) { closeReader(); return; }
    reader?.remove();
    readerBusy = true;

    reader = document.createElement('div');
    reader.id = 'synapse-reader-overlay';
    reader.className = 'synapse-reader';
    reader.setAttribute('role', 'dialog');
    reader.setAttribute('aria-modal', 'false');
    reader.setAttribute('aria-labelledby', 'synapse-reader-title');
    reader.innerHTML = `
      <div class="synapse-reader-panel">
        <div class="synapse-reader-topbar">
          <div class="synapse-reader-title" id="synapse-reader-title">Synapse Document Reader</div>
          <button type="button" class="synapse-reader-close" aria-label="Close the reader">✕</button>
        </div>
        <div class="synapse-reader-loading" role="status">
          <div class="vw-spinner" aria-hidden="true"></div>
          <span>Rebuilding this PDF for your brain…</span>
        </div>
        <div class="synapse-reader-content" hidden></div>
      </div>`;
    document.body.appendChild(reader);
    reader.querySelector('.synapse-reader-close').addEventListener('click', closeReader);
    reader.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !SX?.isCircling?.()) { e.preventDefault(); closeReader(); }
    });
    document.getElementById('readBtn')?.setAttribute('aria-pressed', 'true');
    requestAnimationFrame(() => requestAnimationFrame(() => reader.classList.add('s-visible')));
    reader.querySelector('.synapse-reader-close').focus({ preventScroll: true });

    const done = (res) => {
      readerBusy = false;
      if (!reader.isConnected) return;
      const loading = reader.querySelector('.synapse-reader-loading');
      const content = reader.querySelector('.synapse-reader-content');
      loading.hidden = true;
      loading.style.display = 'none';
      content.hidden = false;
      if (res && res.html) {
        content.innerHTML = DOMPurify.sanitize(res.html);
      } else {
        const p = document.createElement('p');
        p.className = 'synapse-reader-error';
        p.textContent = (res && res.error) || "Synapse couldn't read this document.";
        content.replaceChildren(p);
      }
    };
    try {
      const msg = { type: 'ANALYSE_DOCUMENT', url: fileUrl, mediaType: MEDIA_TYPE };
      if (isLocal) msg.documentBase64 = localDocumentBase64();
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) done({ error: 'Synapse lost its connection. Reload the page and try again.' });
        else done(res);
      });
    } catch (_) {
      done({ error: 'Synapse was updated. Reload the page to keep using it.' });
    }
  }

  // ── Explain init ───────────────────────────────────────────────
  function start() {
    if (started || !SX || !fileUrl) return;
    started = true;
    SX.init({
      document: { url: fileUrl, mediaType: MEDIA_TYPE, title },
      contentRoot: () => document.getElementById('viewer'),
      openReader
    });
  }

  function wireToolbar() {
    const circleBtn = document.getElementById('circleBtn');
    const panelBtn = document.getElementById('panelBtn');
    const readBtn = document.getElementById('readBtn');
    if (!SX) {
      [circleBtn, panelBtn, readBtn].forEach(b => { if (b) b.disabled = true; });
      return;
    }
    circleBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // the click must not reach circle mode's own listeners
      if (SX.isCircling()) { SX.cancelCircle(); return; }
      SX.startCircle('click');
    });
    panelBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      SX.togglePanel();
    });
    readBtn?.addEventListener('click', (e) => { e.preventDefault(); openReader(); });
    if (isLocal && readBtn && !localBytes) {
      // Local PDFs are read from bytes this page loaded; enabled by setLocalBytes().
      readBtn.disabled = true;
    }
    // Keep the Explanations button's state in sync with the panel.
    const prevToggle = SX.onPanelToggle;
    SX.onPanelToggle = (open) => {
      prevToggle?.(open);
      panelBtn?.setAttribute('aria-expanded', String(open));
    };
  }

  // ── API for viewer.js ──────────────────────────────────────────
  globalThis.SynapseViewerHost = {
    fileUrl,
    fileName: fileUrl ? fileNameOf(fileUrl) : null,

    /** The bytes of a local (file://) PDF, for the reader and document context. */
    setLocalBytes(bytes) {
      localBytes = bytes || null;
      localBase64 = null;
      const readBtn = document.getElementById('readBtn');
      if (readBtn && SX) readBtn.disabled = !localBytes;
    },

    /** Document metadata is known: update the title used for explains/history. */
    setTitle(t) {
      if (!t) return;
      title = String(t);
      if (started) SX.H.configure({ document: { url: fileUrl, mediaType: MEDIA_TYPE, title } });
    },

    /** The PDF opened: warm the document context (one upload, reused by explains). */
    documentReady() {
      start();
      if (!SX || !fileUrl) return;
      SX.prepareDocument(isLocal ? { base64: localDocumentBase64() } : undefined).catch(() => {});
      if (readOnOpen) {
        // One-shot: a reload shouldn't reopen the reader.
        try {
          const u = new URL(location.href);
          u.searchParams.delete('read');
          history.replaceState(history.state, '', u.href);
        } catch (_) { /* keep the URL */ }
        openReader();
      }
    },

    /** A page's text layer rendered (lazily): paint saved green highlights now on screen. */
    textLayerRendered() {
      if (!started) return;
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => {
        try { SX.paintAllEntries(); } catch (_) { /* best effort */ }
      }, 150);
    },

    /** Zoom changed: drop the confirm bar/outline (their geometry is stale). */
    layoutChanged() {
      if (started && SX.isCircling()) SX.cancelCircle();
      SX?.hideBubble?.();
    },

    openReader,
    isStarted: () => started
  };

  wireToolbar();
  if (fileUrl) start();
})();
