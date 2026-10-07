// ================================================================
// SYNAPSE EXPLAIN — shared core
// Namespace, DOM text index (for quote anchoring), green highlights via the
// CSS Custom Highlight API, source emphasis + return-to-source, and styles.
// Loaded after lib/geometry.js and explain/host.js. Everything content.js
// used to provide (S, C, Z, base styles) comes through SynapseExplainHost.
// ================================================================
(function () {
  'use strict';
  if (globalThis.SynapseExplain) return;

  const G = globalThis.SynapseGeometry;
  const H = globalThis.SynapseExplainHost;
  const C = H.C, Z = H.Z;
  const SX = globalThis.SynapseExplain = {};
  SX.G = G;
  SX.H = H;

  SX.state = {
    hostname: G.hostnameOf(H.pageUrl()),
    pageKey: G.pageKey(H.pageUrl()),
    history: [],            // entries for this hostname, newest first
    historySource: 'local',
    highlights: new Map(),  // entry id (or `pending-<n>`) -> live Range
    requestSeq: 0,
    currentRequestId: 0,
    contextSettings: { usePageContext: true, siteOverrides: {} },
    documentContextReady: false, // background holds a context_id for this document
  };

  /** Re-reads hostname/pageKey from the host (after configure() or an SPA URL change). */
  SX.refreshPageIdentity = function () {
    SX.state.hostname = G.hostnameOf(H.pageUrl());
    SX.state.pageKey = G.pageKey(H.pageUrl());
  };

  // Everything Synapse injects. Used to keep our own UI out of selections,
  // circle text extraction, and click handling.
  SX.UI_SELECTOR = [
    '#synapse-fab', '#synapse-panel', '#synapse-dock', '.synapse-card', '.synapse-badge',
    '#synapse-fullpage-bar', '#synapse-reader-overlay', '#synapse-explain-panel',
    '#synapse-fab-menu', '#synapse-history-btn', '#synapse-bubble',
    '#synapse-circle-overlay', '#synapse-circle-tip', '.synapse-emphasis', '#synapse-styles',
    '#synapse-explain-styles', '#synapse-confirm-bar', '#synapse-circle-outline', '#synapse-host-styles'
  ].join(',');

  // The one piece of Synapse UI the user may highlight or circle: the
  // document reader's rebuilt content (explained against the original document).
  SX.CONTENT_EXCEPTION = '#synapse-reader-overlay .synapse-reader-content';
  const READER_CHROME = '.synapse-reader-topbar,.synapse-reader-loading';

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'SELECT', 'OPTION', 'HEAD']);

  // ── Small helpers ──────────────────────────────────────────────
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  SX.isSynapseUI = function (node) {
    const el = elementOf(node);
    if (!el || !el.closest) return false;
    if (el.closest(SX.CONTENT_EXCEPTION)) return false;
    return !!el.closest(SX.UI_SELECTOR);
  };

  /** True inside the document reader's rebuilt content. */
  SX.inReaderContent = function (node) {
    const el = elementOf(node);
    return !!(el && el.closest && el.closest(SX.CONTENT_EXCEPTION));
  };

  /** The open reader's content element, or null. */
  SX.readerContent = function () {
    const overlay = document.getElementById('synapse-reader-overlay');
    if (!overlay || !overlay.classList.contains('s-visible')) return null;
    const content = overlay.querySelector('.synapse-reader-content');
    return content && content.offsetParent !== null ? content : null;
  };

  /**
   * Where circle extraction and context look for text: the open reader
   * (it covers the page), else the host's content root (body on web pages).
   */
  SX.activeTextRoot = function () {
    return SX.readerContent() || H.getContentRoot();
  };

  /** False when the host limits selection to a content root and node is outside it. */
  SX.inContentRoot = function (node) {
    if (!H.contentRoot) return true;
    // The reader's rebuilt content sits outside the host's root but is
    // explained against the same document (e.g. the PDF viewer's reader).
    if (SX.inReaderContent(node)) return true;
    const root = H.getContentRoot();
    const el = elementOf(node);
    return !!(root && el && root.contains(el));
  };

  SX.isEditable = function (node) {
    const el = elementOf(node);
    if (!el) return false;
    if (el.isContentEditable) return true;
    return !!el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  };

  /** True when keyboard focus is somewhere the user types (including inside open shadow roots). */
  SX.focusInEditable = function () {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
  };

  SX.reducedMotion = function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  };

  SX.escapeHTML = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  };

  SX.nextFrames = function (n = 2) {
    return new Promise(resolve => {
      const step = (left) => left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
      step(n);
    });
  };

  /** chrome.runtime.sendMessage as a promise that never rejects. */
  SX.send = function (msg) {
    return new Promise(resolve => {
      try {
        if (!chrome.runtime?.id) throw new Error('invalidated');
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'Synapse lost its connection. Reload the page and try again.' });
          } else {
            resolve(res || { ok: false, error: 'No response from Synapse.' });
          }
        });
      } catch (_) {
        resolve({ ok: false, error: 'Synapse was updated. Reload the page to keep using it.' });
      }
    });
  };

  // ── DOM text index ─────────────────────────────────────────────
  // All page text nodes concatenated, whitespace-normalised, with a map back
  // to (node, offset). Quotes are anchored against this normalised text so
  // reflowed whitespace does not break matching.

  SX.collectTextNodes = function (rootEl) {
    const root = rootEl || H.getContentRoot();
    const nodes = [];
    if (!root) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (node.id === 'synapse-reader-overlay') return NodeFilter.FILTER_SKIP; // descend to its content only
          if (node.matches(READER_CHROME)) return NodeFilter.FILTER_REJECT;
          if (node.id && node.id.startsWith('synapse-') && node.matches(SX.UI_SELECTOR)) return NodeFilter.FILTER_REJECT;
          if (node.classList && (node.classList.contains('synapse-card') || node.classList.contains('synapse-emphasis'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return node.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  };

  SX.buildTextIndex = function (rootEl) {
    const nodes = SX.collectTextNodes(rootEl);
    const starts = new Array(nodes.length);
    let raw = '';
    for (let i = 0; i < nodes.length; i++) {
      starts[i] = raw.length;
      raw += nodes[i].data;
    }
    const { text, map } = G.normalizeWithMap(raw);
    return { nodes, starts, raw, text, map };
  };

  function lowerBound(arr, value) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Normalised [start, end) -> live Range, or null. */
  SX.rangeFromIndex = function (idx, start, end) {
    if (!idx || start >= end || end > idx.map.length) return null;
    const rawStart = idx.map[start];
    const rawEndChar = idx.map[end - 1];
    const si = G.upperBoundIndex(idx.starts, rawStart);
    const ei = G.upperBoundIndex(idx.starts, rawEndChar);
    if (si < 0 || ei < 0) return null;
    try {
      const range = document.createRange();
      range.setStart(idx.nodes[si], rawStart - idx.starts[si]);
      range.setEnd(idx.nodes[ei], rawEndChar - idx.starts[ei] + 1);
      return range;
    } catch (_) {
      return null;
    }
  };

  /** Live Range -> normalised {start, end} in the index, or null. */
  SX.offsetsFromRange = function (idx, range) {
    if (!idx || !range) return null;
    let rawStart = -1, rawEnd = -1;
    for (let i = 0; i < idx.nodes.length; i++) {
      const node = idx.nodes[i];
      let hit = false;
      try { hit = range.intersectsNode(node); } catch (_) { hit = false; }
      if (!hit) continue;
      const s = node === range.startContainer ? idx.starts[i] + range.startOffset : idx.starts[i];
      const e = node === range.endContainer ? idx.starts[i] + range.endOffset : idx.starts[i] + node.data.length;
      if (e <= s) continue;
      if (rawStart < 0) rawStart = s;
      rawEnd = e;
    }
    if (rawStart < 0) return null;
    let start = lowerBound(idx.map, rawStart);
    const end = lowerBound(idx.map, rawEnd);
    while (start < end && idx.text[start] === ' ') start++;
    let e2 = end;
    while (e2 > start && idx.text[e2 - 1] === ' ') e2--;
    return e2 > start ? { start, end: e2 } : null;
  };

  /** Keeps a serialised anchor comfortably under the backend's 4 KB cap. */
  SX.fitAnchor = function (anchor, maxBytes = 3800) {
    const enc = new TextEncoder();
    const size = a => enc.encode(JSON.stringify(a)).length;
    const a = { ...anchor };
    if (a.selector && a.selector.length > 400) delete a.selector;
    while (a.quote && size(a) > maxBytes) {
      if (!a.quote_end) {
        a.quote_end = a.quote.slice(-60);
        a.quote_length = a.quote.length;
      }
      a.quote = a.quote.slice(0, Math.floor(a.quote.length / 2));
      if (a.quote.length < 20) { delete a.quote; delete a.quote_end; delete a.quote_length; }
    }
    return a;
  };

  /** Anchor {quote, prefix, suffix} for a live range, or null when it maps to no page text. */
  SX.anchorFromRange = function (range, opts) {
    const idx = SX.buildTextIndex();
    const off = SX.offsetsFromRange(idx, range);
    if (!off) return null;
    return SX.fitAnchor(G.buildTextAnchor(idx.text, off.start, off.end, opts));
  };

  /** Finds a text anchor on the current page; returns a live Range or null. */
  SX.findAnchorRange = function (anchor, idx) {
    if (!anchor || !anchor.quote) return null;
    const index = idx || SX.buildTextIndex();
    const hit = G.findTextAnchor(index.text, anchor);
    return hit ? SX.rangeFromIndex(index, hit.start, hit.end) : null;
  };

  // ── Green highlights (CSS Custom Highlight API, no DOM wrapping) ──
  SX.highlightSupported = function () {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  };

  SX.repaintHighlights = function () {
    if (!SX.highlightSupported()) return;
    const ranges = Array.from(SX.state.highlights.values());
    if (!ranges.length) CSS.highlights.delete('synapse-explained');
    else CSS.highlights.set('synapse-explained', new Highlight(...ranges));
  };

  SX.addHighlight = function (key, range) {
    if (!range) return;
    SX.state.highlights.set(key, range);
    SX.repaintHighlights();
  };

  SX.renameHighlight = function (fromKey, toKey) {
    const r = SX.state.highlights.get(fromKey);
    if (!r) return;
    SX.state.highlights.delete(fromKey);
    SX.state.highlights.set(toKey, r);
  };

  SX.removeHighlight = function (key) {
    if (SX.state.highlights.delete(key)) SX.repaintHighlights();
  };

  SX.clearHighlights = function () {
    SX.state.highlights.clear();
    SX.repaintHighlights();
  };

  let pulseTimers = [];
  /** Briefly intensifies the green on one range. Reduced motion: one static emphasis. */
  SX.pulseRange = function (range) {
    if (!range || !SX.highlightSupported()) return;
    pulseTimers.forEach(clearTimeout);
    pulseTimers = [];
    const on = () => CSS.highlights.set('synapse-explained-pulse', new Highlight(range));
    const off = () => CSS.highlights.delete('synapse-explained-pulse');
    on();
    if (SX.reducedMotion()) {
      pulseTimers.push(setTimeout(off, 1600));
      return;
    }
    [300, 520, 820, 1040, 1400].forEach((t, i) => pulseTimers.push(setTimeout(i % 2 ? on : off, t)));
  };

  // ── Emphasis outline (absolute, so it scrolls with the page) ───
  SX.emphasizeViewportRect = function (rect, opts) {
    if (!rect || rect.width <= 0 || rect.height <= 0 || !document.body) return;
    const pad = (opts && opts.pad) ?? 6;
    const box = document.createElement('div');
    box.className = 'synapse-emphasis' + (SX.reducedMotion() ? ' s-static' : '');
    box.setAttribute('aria-hidden', 'true');
    box.style.setProperty('left', `${rect.x + window.scrollX - pad}px`, 'important');
    box.style.setProperty('top', `${rect.y + window.scrollY - pad}px`, 'important');
    box.style.setProperty('width', `${rect.width + pad * 2}px`, 'important');
    box.style.setProperty('height', `${rect.height + pad * 2}px`, 'important');
    document.body.appendChild(box);
    setTimeout(() => box.classList.add('s-out'), 1700);
    setTimeout(() => box.remove(), 2100);
  };

  SX.emphasizeDocRect = function (docRect) {
    if (!docRect) return;
    SX.emphasizeViewportRect({
      x: docRect.x - window.scrollX, y: docRect.y - window.scrollY,
      width: docRect.width, height: docRect.height
    });
  };

  function viewportRectOf(target) {
    if (!target) return null;
    if (target.docRect) {
      const d = target.docRect;
      return { x: d.x - window.scrollX, y: d.y - window.scrollY, width: d.width, height: d.height };
    }
    const r = (target.element || target.range).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** Mostly visible = at least 60% of the rect's height (capped at the viewport) is on screen. */
  SX.isMostlyVisible = function (rect) {
    if (!rect) return false;
    const visibleH = Math.min(rect.y + rect.height, window.innerHeight) - Math.max(rect.y, 0);
    const visibleW = Math.min(rect.x + rect.width, window.innerWidth) - Math.max(rect.x, 0);
    if (visibleH <= 0 || visibleW <= 0) return false;
    return visibleH >= Math.min(rect.height, window.innerHeight) * 0.6;
  };

  function waitForScroll() {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; window.removeEventListener('scrollend', finish); resolve(); } };
      window.addEventListener('scrollend', finish, { once: true });
      setTimeout(finish, 700);
    });
  }

  /**
   * Brings a source into view (only if it isn't already) and emphasises it.
   * target: { element } | { range, highlightKey? } | { docRect }.
   */
  SX.revealSource = async function (target) {
    if (!target) return false;
    const rect = viewportRectOf(target);
    if (!rect || (rect.width === 0 && rect.height === 0 && !target.docRect)) return false;
    const behavior = SX.reducedMotion() ? 'auto' : 'smooth';

    if (!SX.isMostlyVisible(rect)) {
      if (target.element) {
        target.element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
      } else if (target.range) {
        const host = elementOf(target.range.startContainer);
        // Nested scroll containers first, then centre the exact range.
        host?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
        const r = target.range.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 2 + r.height / 2, behavior });
      } else {
        const d = target.docRect;
        window.scrollTo({ top: d.y - window.innerHeight / 2 + d.height / 2, left: window.scrollX, behavior });
      }
      if (behavior === 'smooth') await waitForScroll();
    }

    if (target.range) {
      SX.pulseRange(target.range);
      if (!SX.highlightSupported()) SX.emphasizeViewportRect(viewportRectOf(target));
    } else {
      SX.emphasizeViewportRect(viewportRectOf(target));
    }
    return true;
  };

  /**
   * Finds where an entry came from on the current page.
   * Returns { range } | { element } | { docRect } | null.
   */
  SX.resolveEntrySource = function (entry, idx) {
    const anchor = entry && entry.anchor;
    if (!anchor) return null;
    if (entry.kind !== 'image') {
      const range = SX.state.highlights.get(entry.id) || SX.findAnchorRange(anchor, idx);
      return range ? { range } : null;
    }
    if (anchor.selector) {
      try {
        const el = document.querySelector(anchor.selector);
        if (el && !SX.isSynapseUI(el)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { element: el };
        }
      } catch (_) { /* invalid selector on this page */ }
    }
    if (anchor.quote) {
      const range = SX.findAnchorRange(anchor, idx);
      if (range) return { range };
    }
    if (anchor.rect && anchor.scroll && G.pageKey(entry.url) === SX.state.pageKey) {
      return {
        docRect: {
          x: anchor.rect.x + anchor.scroll.x, y: anchor.rect.y + anchor.scroll.y,
          width: anchor.rect.width, height: anchor.rect.height
        }
      };
    }
    return null;
  };

  /** A reasonably stable CSS selector for an element (id-rooted or nth-of-type path). */
  SX.cssPath = function (el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body && cur !== document.documentElement && depth < 10) {
      if (cur.id && !cur.id.startsWith('synapse-')) {
        const sel = `#${esc(cur.id)}`;
        try {
          if (document.querySelectorAll(sel).length === 1) { parts.unshift(sel); return parts.join(' > '); }
        } catch (_) { /* fall through */ }
      }
      const tag = cur.tagName.toLowerCase();
      let nth = 1;
      let sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) nth++;
      parts.unshift(`${tag}:nth-of-type(${nth})`);
      cur = cur.parentElement;
      depth++;
    }
    if (cur !== document.body) return null; // too deep to be worth storing
    parts.unshift('body');
    return parts.join(' > ');
  };

  // ── Gentle toast (shared with circle mode's instruction tip) ───
  let toastTimer = null;
  SX.showTip = function (text, opts) {
    let tip = document.getElementById('synapse-circle-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'synapse-circle-tip';
      tip.setAttribute('role', 'status');
      tip.setAttribute('aria-live', 'polite');
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.classList.toggle('s-message', !!(opts && opts.message));
    tip.classList.add('s-visible');
    clearTimeout(toastTimer);
    if (opts && opts.duration) toastTimer = setTimeout(SX.hideTip, opts.duration);
    return tip;
  };

  SX.hideTip = function () {
    clearTimeout(toastTimer);
    const tip = document.getElementById('synapse-circle-tip');
    if (!tip) return;
    tip.classList.remove('s-visible');
    setTimeout(() => { if (!tip.classList.contains('s-visible')) tip.remove(); }, 220);
  };

  // ── Styles ─────────────────────────────────────────────────────
  SX.injectStyles = function () {
    if (document.getElementById('synapse-explain-styles')) return;
    const st = document.createElement('style');
    st.id = 'synapse-explain-styles';
    const ROOTS = '#synapse-explain-panel,#synapse-fab-menu,#synapse-history-btn,#synapse-bubble,#synapse-circle-overlay,#synapse-circle-tip,.synapse-emphasis,#synapse-confirm-bar,#synapse-circle-outline';
    const FONT = "-apple-system,'Segoe UI',system-ui,sans-serif";
    st.textContent = `
${ROOTS}{all:initial;box-sizing:border-box;font-family:${FONT}}
:is(${ROOTS}) *,:is(${ROOTS}) *::before,:is(${ROOTS}) *::after{box-sizing:inherit}

/* Green source highlight */
::highlight(synapse-explained){background-color:rgba(29,158,117,.22);color:inherit;
text-decoration:underline 2px ${C.green};text-underline-offset:3px}
::highlight(synapse-explained-pulse){background-color:rgba(29,158,117,.5);color:inherit}
:root.synapse-capture-hide ::highlight(synapse-explained),
:root.synapse-capture-hide ::highlight(synapse-explained-pulse){background-color:transparent;text-decoration:none}
:root.synapse-capture-hide :is(${SX.UI_SELECTOR}){visibility:hidden!important}
/* The reader's content can be circled, so it stays in the screenshot. */
:root.synapse-capture-hide #synapse-reader-overlay,:root.synapse-capture-hide #synapse-reader-overlay *{visibility:visible!important}

/* FAB states for the explain flow */
#synapse-fab:focus-visible{outline:3px solid ${C.greenMid}!important;outline-offset:3px!important}
#synapse-fab.s-circling{background:${C.greenDeep}!important;box-shadow:0 0 0 6px rgba(29,158,117,.25)!important}

/* History button attached to the FAB */
#synapse-history-btn{position:fixed!important;right:90px!important;bottom:38px!important;
width:32px!important;height:32px!important;border-radius:50%!important;background:${C.white}!important;
border:1px solid ${C.g200}!important;box-shadow:0 2px 10px rgba(0,0,0,.12)!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;z-index:${Z.menu}!important;
opacity:0!important;visibility:hidden!important;transform:translateX(10px) scale(.85)!important;
transition:opacity .16s ease .4s,transform .16s ease .4s,visibility 0s linear .56s!important}
#synapse-history-btn svg{width:16px!important;height:16px!important;fill:${C.green}!important;display:block!important}
#synapse-history-btn .sxh-count{position:absolute!important;top:-5px!important;right:-5px!important;min-width:16px!important;
height:16px!important;padding:0 4px!important;border-radius:8px!important;background:${C.green}!important;color:white!important;
font:700 9.5px/16px ${FONT}!important;text-align:center!important;display:block!important}
#synapse-history-btn .sxh-count:empty{display:none!important}
#synapse-fab:hover~#synapse-history-btn,#synapse-fab:focus-visible~#synapse-history-btn,
#synapse-history-btn:hover,#synapse-history-btn:focus-visible,#synapse-history-btn.s-has-history{
opacity:1!important;visibility:visible!important;transform:none!important;
transition:opacity .16s ease,transform .16s ease,visibility 0s!important}
#synapse-history-btn:hover{border-color:${C.greenMid}!important;background:${C.greenLight}!important}
#synapse-history-btn:focus-visible{outline:3px solid ${C.greenMid}!important;outline-offset:2px!important}
#synapse-history-btn.s-suppressed{display:none!important}

/* FAB prompt (document pages) */
#synapse-fab-menu{position:fixed!important;right:92px!important;bottom:28px!important;z-index:${Z.menu}!important;
background:${C.white}!important;border:1px solid ${C.g200}!important;border-radius:14px!important;padding:6px!important;
box-shadow:0 8px 32px rgba(0,0,0,.14)!important;display:flex!important;flex-direction:column!important;gap:2px!important;
min-width:196px!important;animation:synapse-pop .18s cubic-bezier(.16,1,.3,1)!important}
@keyframes synapse-pop{from{opacity:0;transform:translateX(8px) scale(.96)}to{opacity:1;transform:none}}
#synapse-fab-menu .sxm-label{font:700 10px/1 ${FONT}!important;letter-spacing:.08em!important;text-transform:uppercase!important;
color:${C.g400}!important;padding:8px 10px 6px!important;display:block!important}
#synapse-fab-menu button{all:unset;box-sizing:border-box!important;display:flex!important;align-items:center!important;gap:10px!important;
width:100%!important;padding:10px!important;border-radius:9px!important;cursor:pointer!important;
font:600 13px/1.2 ${FONT}!important;color:${C.g900}!important}
#synapse-fab-menu button:hover,#synapse-fab-menu button:focus-visible{background:${C.greenLight}!important;color:${C.greenDeep}!important}
#synapse-fab-menu button:focus-visible{outline:2px solid ${C.green}!important;outline-offset:-2px!important}
#synapse-fab-menu .sxm-ico{width:26px!important;height:26px!important;border-radius:8px!important;background:${C.greenLight}!important;
color:${C.green}!important;display:flex!important;align-items:center!important;justify-content:center!important;
font:700 14px/1 ${FONT}!important;flex-shrink:0!important}
#synapse-fab-menu .sxm-sub{display:block!important;font:400 11px/1.3 ${FONT}!important;color:${C.g600}!important;margin-top:2px!important}

/* Highlight bubble */
#synapse-bubble{position:fixed!important;z-index:${Z.bubble}!important;width:34px!important;height:34px!important;
border-radius:50%!important;background:${C.green}!important;border:2px solid ${C.white}!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;
box-shadow:0 3px 14px rgba(29,158,117,.4)!important;animation:synapse-bubble-pulse 2s ease-out infinite!important;
transition:transform .15s ease!important}
#synapse-bubble:hover{transform:scale(1.08)!important;background:${C.greenDark}!important}
#synapse-bubble:focus-visible{outline:3px solid ${C.greenMid}!important;outline-offset:2px!important}
#synapse-bubble svg{width:17px!important;height:17px!important;fill:white!important;display:block!important}
@keyframes synapse-bubble-pulse{0%{box-shadow:0 3px 14px rgba(29,158,117,.4),0 0 0 0 rgba(29,158,117,.45)}
70%{box-shadow:0 3px 14px rgba(29,158,117,.4),0 0 0 10px rgba(29,158,117,0)}
100%{box-shadow:0 3px 14px rgba(29,158,117,.4),0 0 0 0 rgba(29,158,117,0)}}

/* Circle overlay */
#synapse-circle-overlay{position:fixed!important;inset:0!important;z-index:${Z.overlay}!important;cursor:crosshair!important;
touch-action:none!important;background:rgba(17,17,17,.04)!important;display:block!important;user-select:none!important}
#synapse-circle-overlay svg{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;
display:block!important;overflow:visible!important}
#synapse-circle-overlay polyline{fill:rgba(29,158,117,.08)!important;stroke:${C.green}!important;stroke-width:3px!important;
stroke-linecap:round!important;stroke-linejoin:round!important}
#synapse-circle-tip{position:fixed!important;top:18px!important;left:50%!important;z-index:${Z.overlay}!important;
transform:translate(-50%,-6px)!important;opacity:0!important;max-width:min(520px,calc(100vw - 32px))!important;
background:${C.g900}!important;color:${C.white}!important;font:500 12.5px/1.45 ${FONT}!important;
padding:9px 16px!important;border-radius:999px!important;box-shadow:0 6px 24px rgba(0,0,0,.2)!important;
pointer-events:none!important;text-align:center!important;display:block!important;
transition:opacity .18s ease,transform .18s ease!important}
#synapse-circle-tip.s-visible{opacity:1!important;transform:translate(-50%,0)!important}
#synapse-circle-tip.s-message{background:${C.white}!important;color:${C.g900}!important;border:1px solid ${C.g200}!important}

/* Emphasis outline */
.synapse-emphasis{position:absolute!important;z-index:${Z.card}!important;pointer-events:none!important;display:block!important;
border:3px solid ${C.green}!important;border-radius:10px!important;background:rgba(29,158,117,.06)!important;
box-shadow:0 0 0 4px rgba(29,158,117,.16)!important;animation:synapse-emph .9s ease-out 2!important;
transition:opacity .35s ease!important;opacity:1!important}
.synapse-emphasis.s-out{opacity:0!important}
@keyframes synapse-emph{0%{box-shadow:0 0 0 0 rgba(29,158,117,.45)}100%{box-shadow:0 0 0 14px rgba(29,158,117,0)}}

/* Explain panel */
#synapse-explain-panel{position:fixed!important;right:28px!important;bottom:92px!important;
width:min(372px,calc(100vw - 32px))!important;max-height:min(620px,calc(100vh - 116px))!important;
display:flex!important;flex-direction:column!important;background:${C.white}!important;color:${C.g900}!important;
border:1px solid ${C.g200}!important;border-radius:18px!important;z-index:${Z.panel}!important;overflow:hidden!important;
box-shadow:0 8px 40px rgba(0,0,0,.12)!important;transform-origin:bottom right!important;
transform:scale(.94) translateY(12px)!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;
transition:transform .24s cubic-bezier(.16,1,.3,1),opacity .18s ease,visibility 0s linear .24s!important}
#synapse-explain-panel.s-visible{transform:none!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important;
transition:transform .24s cubic-bezier(.16,1,.3,1),opacity .18s ease!important}
#synapse-explain-panel button{font-family:inherit!important}
#synapse-explain-panel .sxp-head{display:flex!important;align-items:center!important;gap:10px!important;
padding:14px 14px 10px 18px!important;border-bottom:1px solid ${C.g100}!important}
#synapse-explain-panel .sxp-brand{display:block!important;flex:1!important;min-width:0!important}
#synapse-explain-panel .sxp-close{all:unset;width:28px!important;height:28px!important;border-radius:50%!important;
background:${C.g100}!important;color:${C.g600}!important;cursor:pointer!important;display:flex!important;
align-items:center!important;justify-content:center!important;font:14px/1 ${FONT}!important;flex-shrink:0!important}
#synapse-explain-panel .sxp-close:hover{background:${C.g200}!important}
#synapse-explain-panel .sxp-close:focus-visible{outline:2px solid ${C.green}!important;outline-offset:2px!important}
#synapse-explain-panel .sxp-controls{display:flex!important;align-items:flex-end!important;gap:10px!important;
padding:10px 18px 12px!important;border-bottom:1px solid ${C.g100}!important}
#synapse-explain-panel .sxp-feel{flex:1!important;display:block!important;min-width:0!important}
#synapse-explain-panel .sxp-feel .sp-difficulty-label{margin-bottom:6px!important}
#synapse-explain-panel .sxp-controls .sp-tool-btn{flex:0 0 auto!important;padding:6px 12px!important;height:29px!important}
#synapse-explain-panel .sp-tool-btn:focus-visible,#synapse-explain-panel .sp-diff-btn:focus-visible{outline:2px solid ${C.green}!important;outline-offset:1px!important}
#synapse-explain-panel .sxp-scroll{flex:1 1 auto!important;overflow-y:auto!important;display:block!important;
scrollbar-width:thin!important;scrollbar-color:${C.greenMid} transparent!important;overscroll-behavior:contain!important}
#synapse-explain-panel .sxp-current{display:block!important;border-bottom:1px solid ${C.g100}!important}
#synapse-explain-panel .sxp-current-head{display:flex!important;align-items:center!important;gap:8px!important;
padding:12px 18px 0!important}
#synapse-explain-panel .sxp-kind{font:700 10px/1 ${FONT}!important;letter-spacing:.08em!important;text-transform:uppercase!important;
color:${C.green}!important;background:${C.greenLight}!important;padding:4px 7px!important;border-radius:6px!important;
display:inline-block!important;flex-shrink:0!important}
#synapse-explain-panel .sxp-snippet{font:400 12px/1.4 ${FONT}!important;color:${C.g600}!important;display:block!important;
overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;min-width:0!important}
#synapse-explain-panel .sxp-loading{display:flex!important;flex-direction:column!important;align-items:center!important;
gap:12px!important;padding:28px 18px!important}
#synapse-explain-panel .sxp-error{display:block!important;margin:12px 18px 14px!important;padding:10px 12px!important;
border-radius:10px!important;background:#fff3f3!important;border:1px solid #fcd2d2!important;color:#b42318!important;
font:500 12.5px/1.5 ${FONT}!important}
#synapse-explain-panel .sc-body{max-height:none!important;overflow:visible!important;padding:12px 18px 6px!important}
#synapse-explain-panel .sc-body img{max-width:100%!important;height:auto!important}
#synapse-explain-panel .sc-feedback{padding:10px 18px 14px!important}
#synapse-explain-panel .sxp-history{display:block!important;padding:4px 0 10px!important}
#synapse-explain-panel .sxp-history-head{display:flex!important;align-items:center!important;justify-content:space-between!important;
gap:8px!important;padding:12px 18px 6px!important}
#synapse-explain-panel .sxp-label{font:700 10px/1 ${FONT}!important;letter-spacing:.08em!important;text-transform:uppercase!important;
color:${C.g400}!important;display:block!important}
#synapse-explain-panel .sxp-link{all:unset;cursor:pointer!important;font:600 11px/1 ${FONT}!important;color:${C.g600}!important;
padding:4px 6px!important;border-radius:6px!important}
#synapse-explain-panel .sxp-link:hover{color:${C.red}!important;background:#fff3f3!important}
#synapse-explain-panel .sxp-link.s-confirm{color:${C.white}!important;background:${C.red}!important}
#synapse-explain-panel .sxp-link:focus-visible{outline:2px solid ${C.green}!important}
#synapse-explain-panel .sxp-confirm-row{display:flex!important;gap:4px!important;align-items:center!important}
#synapse-explain-panel .sxp-list{list-style:none!important;margin:0!important;padding:0 8px!important;display:block!important}
#synapse-explain-panel .sxp-item{display:block!important;border-radius:12px!important;margin:2px 0!important;position:relative!important}
#synapse-explain-panel .sxp-item.s-open{background:${C.g50}!important}
#synapse-explain-panel .sxp-item-row{display:flex!important;align-items:center!important;gap:4px!important}
#synapse-explain-panel .sxp-item-main{all:unset;box-sizing:border-box!important;flex:1!important;min-width:0!important;
display:flex!important;align-items:center!important;gap:10px!important;padding:8px 10px!important;border-radius:10px!important;cursor:pointer!important}
#synapse-explain-panel .sxp-item-main:hover{background:${C.greenLight}!important}
#synapse-explain-panel .sxp-item-main:focus-visible{outline:2px solid ${C.green}!important;outline-offset:-2px!important}
#synapse-explain-panel .sxp-thumb{width:38px!important;height:38px!important;border-radius:8px!important;flex-shrink:0!important;
background:${C.greenLight}!important;color:${C.green}!important;display:flex!important;align-items:center!important;
justify-content:center!important;overflow:hidden!important;font:700 15px/1 ${FONT}!important}
#synapse-explain-panel .sxp-thumb img{width:100%!important;height:100%!important;object-fit:cover!important;display:block!important;
max-width:none!important;margin:0!important;border:0!important}
#synapse-explain-panel .sxp-item-text{display:block!important;min-width:0!important;flex:1!important}
#synapse-explain-panel .sxp-item-snippet{display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important;
overflow:hidden!important;font:500 12.5px/1.4 ${FONT}!important;color:${C.g900}!important;word-break:break-word!important}
#synapse-explain-panel .sxp-item-meta{display:block!important;font:400 11px/1.3 ${FONT}!important;color:${C.g400}!important;margin-top:3px!important}
#synapse-explain-panel .sxp-item-del{all:unset;width:26px!important;height:26px!important;border-radius:50%!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;color:${C.g400}!important;
font:13px/1 ${FONT}!important;flex-shrink:0!important;margin-right:4px!important}
#synapse-explain-panel .sxp-item-del:hover{background:#fee2e2!important;color:${C.red}!important}
#synapse-explain-panel .sxp-item-del:focus-visible{outline:2px solid ${C.green}!important}
#synapse-explain-panel .sxp-item-body{padding:4px 12px 10px 58px!important}
#synapse-explain-panel .sxp-empty{display:block!important;margin:0!important;padding:8px 18px 14px!important;
font:400 12px/1.55 ${FONT}!important;color:${C.g600}!important}
#synapse-explain-panel kbd{font:600 11px/1 ui-monospace,Consolas,monospace!important;background:${C.g100}!important;
border:1px solid ${C.g200}!important;border-bottom-width:2px!important;border-radius:5px!important;padding:2px 5px!important;color:${C.g900}!important}

/* Page-context setting + per-site override */
#synapse-explain-panel .sxp-context{display:block!important;padding:8px 18px 10px!important;border-bottom:1px solid ${C.g100}!important}
#synapse-explain-panel .sxp-switch{all:unset;box-sizing:border-box!important;display:flex!important;align-items:center!important;gap:8px!important;
cursor:pointer!important;font:500 12px/1.3 ${FONT}!important;color:${C.g900}!important;padding:2px 0!important;border-radius:6px!important}
#synapse-explain-panel .sxp-switch:focus-visible{outline:2px solid ${C.green}!important;outline-offset:2px!important}
#synapse-explain-panel .sxp-track{position:relative!important;width:28px!important;height:16px!important;border-radius:8px!important;
background:${C.g200}!important;flex-shrink:0!important;display:block!important;transition:background .15s ease!important}
#synapse-explain-panel .sxp-track::after{content:""!important;position:absolute!important;top:2px!important;left:2px!important;width:12px!important;
height:12px!important;border-radius:50%!important;background:${C.white}!important;box-shadow:0 1px 2px rgba(0,0,0,.2)!important;
transition:transform .15s ease!important}
#synapse-explain-panel .sxp-switch[aria-checked="true"] .sxp-track{background:${C.green}!important}
#synapse-explain-panel .sxp-switch[aria-checked="true"] .sxp-track::after{transform:translateX(12px)!important}
#synapse-explain-panel .sxp-site{display:block!important;margin-top:8px!important;padding:8px 10px!important;border-radius:9px!important;
background:${C.g50}!important;border:1px solid ${C.g100}!important}
#synapse-explain-panel .sxp-site-note{display:block!important;font:400 11.5px/1.45 ${FONT}!important;color:${C.g600}!important;margin-bottom:6px!important}
#synapse-explain-panel .sxp-ctx-used{display:block!important;padding:0 18px 8px!important;font:400 11px/1.4 ${FONT}!important;color:${C.g400}!important}
#synapse-explain-panel .sxp-actions{display:flex!important;flex-wrap:wrap!important;gap:6px!important;margin:-4px 18px 14px!important}
#synapse-explain-panel .sxp-action{all:unset;box-sizing:border-box!important;cursor:pointer!important;font:600 12px/1 ${FONT}!important;
padding:8px 12px!important;border-radius:8px!important;background:${C.green}!important;color:${C.white}!important}
#synapse-explain-panel .sxp-action.s-secondary{background:${C.white}!important;color:${C.g900}!important;border:1px solid ${C.g200}!important}
#synapse-explain-panel .sxp-action:hover{filter:brightness(.95)!important}
#synapse-explain-panel .sxp-action:focus-visible{outline:2px solid ${C.greenDeep}!important;outline-offset:2px!important}

/* Versions of one explanation, "Clearer", and re-explain */
#synapse-explain-panel .sxp-versions{display:flex!important;flex-wrap:wrap!important;gap:4px!important;padding:10px 18px 0!important}
#synapse-explain-panel .sxp-ver{all:unset;box-sizing:border-box!important;cursor:pointer!important;font:600 11px/1 ${FONT}!important;
padding:5px 9px!important;border-radius:999px!important;border:1px solid ${C.g200}!important;color:${C.g600}!important;background:${C.white}!important}
#synapse-explain-panel .sxp-ver[aria-pressed="true"]{background:${C.greenLight}!important;border-color:${C.greenMid}!important;color:${C.greenDeep}!important}
#synapse-explain-panel .sxp-ver:focus-visible{outline:2px solid ${C.green}!important;outline-offset:1px!important}
#synapse-explain-panel .sxp-tools{display:block!important;padding:6px 18px 14px!important}
#synapse-explain-panel .sxp-tools-row{display:flex!important;flex-wrap:wrap!important;align-items:center!important;gap:6px!important}
#synapse-explain-panel .sxp-tools-label{font:700 10px/1 ${FONT}!important;letter-spacing:.08em!important;text-transform:uppercase!important;
color:${C.g400}!important;display:block!important;width:100%!important;margin:10px 0 2px!important}
#synapse-explain-panel .sxp-chip{all:unset;box-sizing:border-box!important;cursor:pointer!important;font:600 12px/1 ${FONT}!important;
padding:7px 11px!important;border-radius:8px!important;border:1.5px solid ${C.g200}!important;background:${C.white}!important;color:${C.g600}!important}
#synapse-explain-panel .sxp-chip:hover{border-color:${C.greenMid}!important;background:${C.greenLight}!important;color:${C.greenDeep}!important}
#synapse-explain-panel .sxp-chip:focus-visible{outline:2px solid ${C.green}!important;outline-offset:1px!important}
#synapse-explain-panel .sxp-chip.s-good{border-color:${C.green}!important;color:${C.greenDeep}!important}
#synapse-explain-panel .sxp-chip[aria-expanded="true"]{background:${C.greenLight}!important;border-color:${C.greenMid}!important;color:${C.greenDeep}!important}
#synapse-explain-panel .sxp-chip:disabled{opacity:.5!important;cursor:default!important}
#synapse-explain-panel .sxp-thanks{font:600 11.5px/1.3 ${FONT}!important;color:${C.green}!important;display:block!important}
#synapse-explain-panel .sxp-ask{display:flex!important;gap:6px!important;margin-top:8px!important}
#synapse-explain-panel .sxp-ask-input{flex:1!important;min-width:0!important;padding:7px 10px!important;border-radius:8px!important;
border:1.5px solid ${C.g200}!important;background:${C.g50}!important;font:400 12px/1.3 ${FONT}!important;color:${C.g900}!important;outline:none!important}
#synapse-explain-panel .sxp-ask-input:focus{border-color:${C.green}!important;background:${C.white}!important}
#synapse-explain-panel .sxp-ask .sxp-action{padding:7px 11px!important}
#synapse-explain-panel .sxp-redo{display:flex!important;align-items:center!important;gap:8px!important;margin-top:10px!important;
font:500 12px/1.3 ${FONT}!important;color:${C.g600}!important}
#synapse-explain-panel .sxp-redo .sc-spinner{width:16px!important;height:16px!important;border-width:2px!important}
#synapse-explain-panel .sxp-note{display:block!important;margin-top:8px!important;font:400 11px/1.4 ${FONT}!important;color:${C.g400}!important}
#synapse-explain-panel .sxp-note.s-error{color:#b42318!important}

/* Circle confirm step: outline of the circled hull + the confirm bar */
#synapse-circle-outline{position:absolute!important;z-index:${Z.panel}!important;pointer-events:none!important;display:block!important;overflow:visible!important}
#synapse-circle-outline svg{display:block!important;width:100%!important;height:100%!important;overflow:visible!important}
#synapse-circle-outline polygon{fill:rgba(29,158,117,.07)!important;stroke:${C.green}!important;stroke-width:2.5px!important;
stroke-dasharray:7 5!important;stroke-linejoin:round!important}
#synapse-confirm-bar{position:absolute!important;z-index:${Z.overlay}!important;display:flex!important;align-items:center!important;gap:12px!important;
background:${C.white}!important;color:${C.g900}!important;border:1px solid ${C.g200}!important;border-radius:14px!important;padding:10px!important;
box-shadow:0 8px 32px rgba(0,0,0,.16)!important;max-width:calc(100vw - 16px)!important;animation:synapse-pop .18s cubic-bezier(.16,1,.3,1)!important}
#synapse-confirm-bar .sxc-preview{width:96px!important;height:72px!important;border-radius:8px!important;border:1px solid ${C.g200}!important;
background:${C.g50}!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow:hidden!important;flex-shrink:0!important}
#synapse-confirm-bar .sxc-preview img{max-width:100%!important;max-height:100%!important;object-fit:contain!important;display:block!important}
#synapse-confirm-bar .sxc-snippet{display:-webkit-box!important;-webkit-line-clamp:4!important;-webkit-box-orient:vertical!important;overflow:hidden!important;
font:400 11px/1.35 ${FONT}!important;color:${C.g600}!important;padding:6px!important;word-break:break-word!important}
#synapse-confirm-bar .sxc-main{display:flex!important;flex-direction:column!important;gap:8px!important;min-width:0!important}
#synapse-confirm-bar .sxc-title{display:block!important;font:600 12.5px/1.35 ${FONT}!important;color:${C.g900}!important}
#synapse-confirm-bar .sxc-title.s-error{color:#b42318!important}
#synapse-confirm-bar .sxc-actions{display:flex!important;gap:6px!important;flex-wrap:wrap!important}
#synapse-confirm-bar button{all:unset;box-sizing:border-box!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;gap:6px!important;
font:600 12.5px/1 ${FONT}!important;padding:8px 10px!important;border-radius:8px!important;border:1px solid ${C.g200}!important;
background:${C.white}!important;color:${C.g900}!important}
#synapse-confirm-bar button:hover{background:${C.g50}!important}
#synapse-confirm-bar button.s-primary{background:${C.green}!important;border-color:${C.green}!important;color:${C.white}!important}
#synapse-confirm-bar button.s-primary:hover{background:${C.greenDark}!important}
#synapse-confirm-bar button:focus-visible{outline:3px solid ${C.greenMid}!important;outline-offset:2px!important}
#synapse-confirm-bar kbd{font:600 10px/1 ui-monospace,Consolas,monospace!important;padding:2px 4px!important;border-radius:4px!important;
background:rgba(0,0,0,.08)!important;color:inherit!important;display:inline-block!important}
#synapse-confirm-bar button.s-primary kbd{background:rgba(255,255,255,.22)!important}
#synapse-confirm-bar .sxc-live{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;
clip:rect(0 0 0 0)!important;white-space:nowrap!important}

@media (max-width:480px){
#synapse-explain-panel{right:16px!important;width:calc(100vw - 32px)!important}
}
@media (prefers-reduced-motion:reduce){
#synapse-bubble,.synapse-emphasis,#synapse-fab-menu,#synapse-confirm-bar{animation:none!important}
#synapse-explain-panel,#synapse-explain-panel.s-visible,#synapse-circle-tip,#synapse-history-btn{transition:none!important}
}

/* Utility: must beat the display rules above */
:is(${ROOTS}) .synapse-hide.synapse-hide,.synapse-hide.synapse-hide{display:none!important}
`;
    (document.head || document.documentElement).appendChild(st);
  };
})();
