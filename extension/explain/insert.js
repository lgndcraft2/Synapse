// ================================================================
// SYNAPSE EXPLAIN — Insert: puts a Respond draft into a text box on the page.
// Only ever on the user's click. Never presses Enter, submits a form or
// clicks send; the user reviews and sends it themselves.
// Loaded after explain/core.js.
// ================================================================
(function () {
  'use strict';
  const SX = globalThis.SynapseExplain;
  if (!SX || SX.insertText) return;

  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number']);
  const CANDIDATES = 'textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
  const SEARCH_RADIUS = 900; // px from the source; further boxes are probably unrelated

  /** The deepest focused element, through open shadow roots. */
  function deepTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path[0] instanceof Element ? path[0] : e.target;
  }

  /** The editable root for an element: the input itself, or the top contenteditable host. */
  function editableRoot(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.tagName === 'TEXTAREA') return el.disabled || el.readOnly ? null : el;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly ? el : null;
    }
    if (el.isContentEditable) {
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isEmpty(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return !el.value.trim();
    return !(el.innerText || '').trim();
  }

  // ── Last focused editable ──────────────────────────────────────
  let lastEditable = null;
  document.addEventListener('focusin', (e) => {
    const el = editableRoot(deepTarget(e));
    if (el && !SX.isSynapseUI(el)) lastEditable = el;
  }, true);

  function rectCenter(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function distance(a, r) {
    const dx = Math.max(r.left - a.x, 0, a.x - r.right);
    const dy = Math.max(r.top - a.y, 0, a.y - r.bottom);
    return Math.hypot(dx, dy);
  }

  /**
   * Where a draft should go. `source` is the selection Range or a viewport
   * rect {x, y, width, height}. Prefers the box the user last typed in, then
   * the nearest empty visible text box. Returns an element or null.
   */
  SX.findInsertTarget = function (source) {
    if (lastEditable && isVisible(lastEditable)) return lastEditable;

    let rect = null;
    try {
      rect = source && typeof source.getBoundingClientRect === 'function'
        ? source.getBoundingClientRect()
        : source ? { left: source.x, top: source.y, right: source.x + source.width, bottom: source.y + source.height, width: source.width, height: source.height } : null;
    } catch (_) { rect = null; }
    if (!rect) return null;
    const from = rectCenter(rect);

    let best = null, bestDist = Infinity;
    for (const node of document.querySelectorAll(CANDIDATES)) {
      const el = editableRoot(node);
      if (!el || SX.isSynapseUI(el) || !isVisible(el) || !isEmpty(el)) continue;
      const d = distance(from, el.getBoundingClientRect());
      if (d < bestDist && d <= SEARCH_RADIUS) { best = el; bestDist = d; }
    }
    return best;
  };

  /** True while `el` can still take the draft. */
  SX.insertTargetUsable = function (el) {
    return !!(el && el.isConnected && editableRoot(el) === el && isVisible(el));
  };

  /**
   * Types `text` into `el` at its end, as the user would. Uses insertText so
   * Ctrl+Z undoes it and editors (React, Gmail, Outlook) see a real input.
   * Returns true when the text landed.
   */
  SX.insertText = function (el, text) {
    if (!SX.insertTargetUsable(el) || !text) return false;
    el.focus({ preventScroll: false });

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const value = el.tagName === 'INPUT' ? text.replace(/\s*\n+\s*/g, ' ') : text;
      const before = el.value;
      const end = before.length;
      el.setSelectionRange(end, end);
      const sep = before && !/\s$/.test(before) ? (el.tagName === 'INPUT' ? ' ' : '\n') : '';
      let ok = false;
      try { ok = document.execCommand('insertText', false, sep + value); } catch (_) { ok = false; }
      if (!ok || el.value === before) {
        el.setRangeText(sep + value, end, end, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return el.value !== before;
    }

    // contenteditable: caret to the end, then insert line by line so each
    // paragraph becomes the editor's own line break.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const before = el.innerText;
    const lines = text.split('\n');
    let ok = true;
    try {
      lines.forEach((line, i) => {
        if (i > 0) ok = document.execCommand('insertLineBreak') && ok;
        if (line) ok = document.execCommand('insertText', false, line) && ok;
      });
    } catch (_) { ok = false; }
    if (!ok && el.innerText === before) {
      // Editors that refuse execCommand: plain text nodes, then an input event.
      const frag = document.createDocumentFragment();
      lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(line));
      });
      range.insertNode(frag);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return el.innerText !== before;
  };
})();
