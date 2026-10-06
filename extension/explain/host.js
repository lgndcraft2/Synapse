// ================================================================
// SYNAPSE EXPLAIN — host environment
// The explain scripts run in two kinds of host:
//
//  1. As content scripts on web pages, after content.js. content.js owns the
//     shared state (S), colours (C), z-indexes (Z), base styles, Bionic
//     reading, the feedback strip, the FAB and the document reader.
//  2. On an extension page (e.g. the Synapse PDF viewer), loaded with
//     <script> tags and WITHOUT content.js. Everything content.js would
//     provide falls back to the minimal versions below, and the page tells
//     the scripts what document they are showing via SynapseExplain.init().
//
// Every explain file reads these through `SynapseExplainHost` (alias `H`),
// never through content.js globals directly. See docs at the bottom of this
// file for how an extension page hosts the explain scripts.
// ================================================================
(function () {
  'use strict';
  if (globalThis.SynapseExplainHost) return;

  /* global S, C, Z, FEATURES, injectStyles, applyBionicReading, injectFeedbackStrip, activateDocumentMode */
  const hasContentScript = typeof S !== 'undefined' && typeof injectStyles === 'function';

  const FALLBACK_C = {
    green: '#1D9E75', greenDark: '#0F6E56', greenLight: '#E1F5EE', greenMid: '#9FE1CB', greenDeep: '#085041',
    gold: '#F5C842', white: '#ffffff', g50: '#fafafa', g100: '#f4f4f4', g200: '#e8e8e8', g400: '#aaaaaa',
    g600: '#666666', g900: '#111111', red: '#e74c3c'
  };
  const FALLBACK_Z = {
    dock: 2147483641, card: 2147483642, panel: 2147483643, fab: 2147483644,
    menu: 2147483645, bubble: 2147483645, overlay: 2147483646
  };

  const H = globalThis.SynapseExplainHost = {
    hasContentScript,
    isExtensionPage: location.protocol === 'chrome-extension:',
    S: hasContentScript ? S : { sessionDifficulty: 'normal', bionicReading: false, documentType: null },
    C: typeof C !== 'undefined' ? C : FALLBACK_C,
    Z: typeof Z !== 'undefined' ? Z : FALLBACK_Z,
    FEATURES: typeof FEATURES !== 'undefined' ? FEATURES : { articleMode: false },

    // Set by configure(): { url, mediaType } of the document being shown, the
    // element whose text is selectable/circleable, and an optional reader opener.
    source: null,
    contentRoot: null,
    openReaderFn: null,
  };

  // ── Document source + page identity ────────────────────────────
  /**
   * The URL explains, history and green highlights belong to. On an extension
   * page showing a document, that is the document's URL, not the viewer's.
   */
  H.pageUrl = function () {
    return (H.source && H.source.url) || location.href;
  };

  H.pageTitle = function () {
    return (H.source && H.source.title) || document.title;
  };

  /**
   * The document behind this page, when there is one: { url, mediaType }.
   * Explicit host configuration wins; otherwise content.js's detection of a
   * PDF/text/CSV/Markdown page.
   */
  H.documentSource = function () {
    if (H.source && H.source.url && H.source.mediaType) return { url: H.source.url, mediaType: H.source.mediaType };
    const dt = H.S.documentType;
    if (dt && dt.mime) return { url: location.href, mediaType: dt.mime };
    return null;
  };

  /** Root element for text extraction and selection (defaults to <body>). */
  H.getContentRoot = function () {
    const r = H.contentRoot;
    if (!r) return document.body;
    if (typeof r === 'string') return document.querySelector(r) || document.body;
    if (typeof r === 'function') return r() || document.body;
    return r.isConnected ? r : document.body;
  };

  /**
   * opts: {
   *   document?: { url, mediaType, title? },   // the source document
   *   contentRoot?: Element | string | () => Element,
   *   openReader?: () => void                  // "Read this document" handler
   * }
   */
  H.configure = function (opts) {
    if (!opts) return H;
    if (opts.document !== undefined) {
      const d = opts.document;
      H.source = d && d.url ? { url: String(d.url), mediaType: d.mediaType || null, title: d.title || null } : null;
      if (H.source && H.source.mediaType && !hasContentScript) {
        const label = { 'application/pdf': 'PDF', 'text/plain': 'Text file', 'text/csv': 'CSV', 'text/markdown': 'Markdown' }[H.source.mediaType];
        H.S.documentType = { mime: H.source.mediaType, label: label || 'document' };
      }
    }
    if (opts.contentRoot !== undefined) H.contentRoot = opts.contentRoot;
    if (opts.openReader !== undefined) H.openReaderFn = opts.openReader;
    return H;
  };

  H.openReader = function () {
    if (typeof H.openReaderFn === 'function') return H.openReaderFn();
    if (typeof activateDocumentMode === 'function') return activateDocumentMode();
    return undefined;
  };

  H.canOpenReader = function () {
    return typeof H.openReaderFn === 'function' || typeof activateDocumentMode === 'function';
  };

  // ── content.js helpers, with fallbacks ─────────────────────────
  H.applyBionic = function (html) {
    if (typeof applyBionicReading === 'function') return applyBionicReading(html);
    return html;
  };

  H.feedbackStrip = function (container, sec) {
    if (typeof injectFeedbackStrip === 'function') injectFeedbackStrip(container, sec);
  };

  /** content.js's base stylesheet, or a small subset the panel needs. */
  H.injectBaseStyles = function () {
    if (typeof injectStyles === 'function') {
      if (!document.getElementById('synapse-styles')) injectStyles();
      return;
    }
    if (document.getElementById('synapse-host-styles')) return;
    const c = H.C;
    const st = document.createElement('style');
    st.id = 'synapse-host-styles';
    st.textContent = `
#synapse-explain-panel .sp-logo{font-size:14px;font-weight:700;color:${c.green};display:block}
#synapse-explain-panel .sp-sub{font-size:11px;color:${c.g400};display:block;margin-top:1px}
#synapse-explain-panel .sp-difficulty-label{font-size:10px;font-weight:600;color:${c.g400};letter-spacing:.06em;text-transform:uppercase;display:block}
#synapse-explain-panel .sp-difficulty-opts{display:flex;gap:5px}
#synapse-explain-panel .sp-diff-btn,#synapse-explain-panel .sp-tool-btn{flex:1;padding:6px 4px;border-radius:7px;border:1px solid ${c.g200};
background:${c.white};font-size:11px;font-weight:500;color:${c.g600};cursor:pointer}
#synapse-explain-panel .sp-diff-btn.s-active,#synapse-explain-panel .sp-tool-btn.s-on{background:${c.green};border-color:${c.green};color:white}
#synapse-explain-panel .sc-spinner{width:26px;height:26px;border:2.5px solid ${c.greenLight};border-top-color:${c.green};border-radius:50%;
animation:synapse-host-spin .7s linear infinite}
@keyframes synapse-host-spin{to{transform:rotate(360deg)}}
#synapse-explain-panel .sc-loading-text{font-size:12px;color:${c.g400}}
#synapse-explain-panel .sc-body{font-size:.9rem;line-height:1.6;color:#333;display:block}
#synapse-explain-panel .sc-body h1,#synapse-explain-panel .sc-body h2,#synapse-explain-panel .sc-body h3{font-size:1rem;font-weight:700;color:${c.g900};margin:10px 0 6px}
#synapse-explain-panel .sc-body p{margin:0 0 8px}
#synapse-explain-panel .sc-body ul,#synapse-explain-panel .sc-body ol{padding-left:1.2rem;margin:0 0 9px}
#synapse-explain-panel .sc-body mark{background:${c.greenLight};color:${c.greenDeep};border-radius:3px;padding:0 2px}
#synapse-explain-panel .sc-body a{color:${c.green}}
`;
    (document.head || document.documentElement).appendChild(st);
  };
})();

/*
 * HOSTING THE EXPLAIN SCRIPTS ON AN EXTENSION PAGE (e.g. viewer/viewer.html)
 * ------------------------------------------------------------------------
 * Content scripts do not run on chrome-extension:// pages, so the page loads
 * the scripts itself, in this order, WITHOUT content.js:
 *
 *   <script src="../purify.min.js"></script>
 *   <script src="../lib/geometry.js"></script>
 *   <script src="../explain/host.js"></script>
 *   <script src="../explain/core.js"></script>
 *   <script src="../explain/context.js"></script>
 *   <script src="../explain/panel.js"></script>
 *   <script src="../explain/highlight.js"></script>
 *   <script src="../explain/circle.js"></script>
 *   <script src="../explain/main.js"></script>
 *   <script src="viewer-init.js"></script>   <!-- MV3 CSP: no inline scripts -->
 *
 * viewer-init.js then calls, once the PDF URL is known:
 *
 *   SynapseExplain.init({
 *     document: { url: 'https://example.com/paper.pdf', mediaType: 'application/pdf', title: 'Paper' },
 *     contentRoot: document.getElementById('viewerContainer'), // pdf.js text layers live here
 *     openReader: () => {...}                                  // optional "Read this document"
 *   });
 *
 * - `document.url` is used for history, green-highlight restore, the
 *   request's page_url and as the document-context key. It must be the
 *   original PDF URL, never the viewer URL.
 * - `contentRoot` limits highlight/circle text extraction and page context
 *   to the rendered document. Selections outside it get no bubble.
 * - With `document` set, explains carry document context: the background
 *   uploads the PDF once (PREPARE_DOCUMENT_CONTEXT / POST /explain/context)
 *   and reuses the context_id. Call SynapseExplain.prepareDocument() early
 *   to warm it up.
 * - On content-script pages, main.js initialises itself; init() is only
 *   needed on extension pages. Calling it again just reconfigures.
 * - There is no FAB on the viewer unless the page adds #synapse-fab before
 *   init(). Wire the viewer's own toolbar buttons to
 *   SynapseExplain.startCircle('click') and SynapseExplain.togglePanel().
 * - Alt+S (circle) and Alt+Shift+E (explain selection) work as on web pages.
 */
