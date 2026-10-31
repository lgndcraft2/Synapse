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
  const CANDIDATES = 'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"][aria-multiline="true"]';
  // Any box an answer could be typed into, single-line inputs included.
  const ANSWER_BOXES = 'textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
  const SEARCH_RADIUS = 900; // px from the source; further boxes are probably unrelated
  const MAX_CHOICES = 12;    // boxes offered to the model at most
  const CONTACT_INPUT_TYPES = new Set(['email', 'url', 'tel']);
  // The structural walk stops below these: everything on the page sits in
  // them, so one box inside (a newsletter sign-up) says nothing about the
  // selection.
  const PAGE_ROOTS = 'body, main, [role="main"]';

  // Boxes a reply never belongs in: search and filter bars, recipient and
  // subject lines. Single-line inputs are judged by their labels too
  // ("Search mail"); for multi-line boxes "query" or "find" may be a real
  // message field ("Your query"), so only the narrower words count.
  const INPUT_AVOID = /search|find|filter|query|look ?up|\bto\b|\bcc\b|\bbcc\b|recipient|subject/i;
  const MULTILINE_AVOID = /search|filter|\bto\b|\bcc\b|\bbcc\b|recipient|subject/i;
  const LABEL_ATTRS = ['name', 'id', 'placeholder', 'aria-label', 'title'];

  /** The deepest focused element, through open shadow roots. */
  function deepTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path[0] && path[0].nodeType === 1 ? path[0] : e.target;
  }

  /** The editable root for an element: the input itself, or the top contenteditable host. */
  function editableRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA') return el.disabled || el.readOnly ? null : el;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly ? el : null;
    }
    if (el.isContentEditable) {
      // A designMode iframe makes <html> editable too; its body is the editor.
      const body = el.ownerDocument.body;
      let root = el;
      while (root !== body && root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return null;
  }

  /** The iframe elements between `el`'s document and the top page, innermost first. */
  function frameChain(el) {
    const frames = [];
    let win = el.ownerDocument.defaultView;
    try {
      while (win && win !== window && win.frameElement) {
        frames.push(win.frameElement);
        win = win.parent;
      }
    } catch (_) { /* cross-origin parent: stop */ }
    return frames;
  }

  /**
   * The element whose box stands for `el` on screen: an iframe editor's body
   * can be 0px tall while empty, so the frame it fills is measured instead.
   */
  function boxOf(el) {
    const frame = el === el.ownerDocument.body ? frameChain(el)[0] : null;
    return frame || el;
  }

  /** `el`'s rect in the top page's viewport, counting the iframes it sits in. */
  function topRect(target) {
    const el = boxOf(target);
    const r = el.getBoundingClientRect();
    let { left, top } = r;
    for (const frame of frameChain(el)) {
      const fr = frame.getBoundingClientRect();
      left += fr.left + frame.clientLeft;
      top += fr.top + frame.clientTop;
    }
    return { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height };
  }

  function shown(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isVisible(el) {
    if (!el || !el.isConnected || !shown(boxOf(el))) return false;
    return frameChain(el).every((frame) => frame.isConnected && shown(frame));
  }

  function isEmpty(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return !el.value.trim();
    return !(el.innerText || '').trim();
  }

  function labelsMatch(el, pattern) {
    const frame = frameChain(el)[0];
    // An iframe editor's own body rarely carries labels; its frame often does.
    const sources = frame && el === el.ownerDocument.body ? [el, frame] : [el];
    return sources.some((node) => LABEL_ATTRS.some((attr) => pattern.test(node.getAttribute(attr) || '')));
  }

  /** True for search, filter, recipient and subject boxes. */
  function isSearchLike(el) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'searchbox' || role === 'combobox') return true;
    if (el.closest('[role="search"]')) return true;
    if (el.tagName === 'INPUT') {
      if ((el.getAttribute('type') || '').toLowerCase() === 'search') return true;
      return labelsMatch(el, INPUT_AVOID);
    }
    return labelsMatch(el, MULTILINE_AVOID);
  }

  // ── Same-origin iframes (rich-text composers often live in one) ─
  // The content script runs in the top page only; these frames are reached
  // through contentDocument. Cross-origin frames throw or return null and are
  // skipped.
  const watchedDocs = new WeakSet();

  function frameDocs(root, depth = 0, out = []) {
    for (const frame of root.querySelectorAll('iframe, frame')) {
      let doc = null;
      try { doc = frame.contentDocument; } catch (_) { doc = null; }
      if (!doc || !doc.documentElement) continue;
      out.push(doc);
      if (depth < 1) frameDocs(doc, depth + 1, out);
    }
    return out;
  }

  /** Every document Insert can reach: the page and its same-origin frames. */
  function reachableDocs() {
    const docs = [document, ...frameDocs(document)];
    docs.forEach(watch);
    return docs;
  }

  // ── Last focused editable ──────────────────────────────────────
  let lastEditable = null;
  // Still the user's working box: focus has stayed in it or only moved to
  // Synapse's own buttons. Clicking or selecting anywhere else on the page
  // clears it, so a search typed earlier doesn't catch the next draft.
  let lastEditableCurrent = false;
  let lastEditableAt = 0;

  function onFocusIn(e) {
    const el = editableRoot(deepTarget(e));
    if (el && !SX.isSynapseUI(el)) {
      lastEditable = el;
      lastEditableCurrent = true;
      lastEditableAt = Date.now();
    }
  }

  function onFocusOut(e) {
    if (!lastEditable || editableRoot(deepTarget(e)) !== lastEditable) return;
    lastEditableCurrent = !!(e.relatedTarget && SX.isSynapseUI(e.relatedTarget));
  }

  function watch(doc) {
    if (watchedDocs.has(doc)) return;
    watchedDocs.add(doc);
    doc.addEventListener('focusin', onFocusIn, true);
    doc.addEventListener('focusout', onFocusOut, true);
  }

  watch(document);

  // Watch frames as they appear, so a composer clicked into before Insert is
  // remembered. A new iframe's document is replaced on load, hence both hooks.
  function watchFrame(frame) {
    const attach = () => { try { if (frame.contentDocument) watch(frame.contentDocument); } catch (_) {} };
    attach();
    frame.addEventListener('load', attach);
  }
  document.querySelectorAll('iframe').forEach(watchFrame);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IFRAME') watchFrame(node);
        else if (node.firstElementChild) node.querySelectorAll('iframe').forEach(watchFrame);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  function rectCenter(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function distance(a, r) {
    const dx = Math.max(r.left - a.x, 0, a.x - r.right);
    const dy = Math.max(r.top - a.y, 0, a.y - r.bottom);
    return Math.hypot(dx, dy);
  }

  function sourceRect(source) {
    try {
      if (source && typeof source.getBoundingClientRect === 'function') return source.getBoundingClientRect();
      if (source) return { left: source.x, top: source.y, right: source.x + source.width, bottom: source.y + source.height, width: source.width, height: source.height };
    } catch (_) { /* detached range */ }
    return null;
  }

  /** The body of a same-origin iframe that is itself an editor, else null. */
  function frameEditor(frame) {
    let doc = null;
    try { doc = frame.contentDocument; } catch (_) { doc = null; }
    if (!doc || !doc.body) return null;
    if (doc.designMode === 'on' || doc.body.isContentEditable) {
      watch(doc);
      return doc.body;
    }
    return null;
  }

  /** A box Insert may fill without the user pointing at it. */
  function answerable(el) {
    if (!el || SX.isSynapseUI(el) || !isVisible(el) || isSearchLike(el)) return false;
    // Sign-up and contact fields, never where an answer goes.
    return !(el.tagName === 'INPUT' && CONTACT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase()));
  }

  /**
   * Answerable boxes under `root` (an element or document), single-line
   * inputs included, plus editors in same-origin iframes inside it.
   */
  function boxesWithin(root) {
    const found = new Set();
    for (const node of root.querySelectorAll(ANSWER_BOXES)) {
      const el = editableRoot(node);
      if (el) found.add(el);
    }
    for (const frame of root.querySelectorAll('iframe, frame')) {
      const body = frameEditor(frame);
      if (body) found.add(body);
      else {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_) { doc = null; }
        if (doc && doc.documentElement) boxesWithin(doc).forEach((el) => found.add(el));
      }
    }
    return [...found].filter(answerable);
  }

  /** Multi-line boxes a draft could go in, across reachable documents. */
  function multilineCandidates() {
    const found = new Set();
    for (const doc of reachableDocs()) {
      // A designMode document is one big editor with no contenteditable attribute.
      if (doc !== document && doc.body && (doc.designMode === 'on' || doc.body.isContentEditable)) {
        found.add(doc.body);
      }
      for (const node of doc.querySelectorAll(CANDIDATES)) {
        const el = editableRoot(node);
        if (el) found.add(el);
      }
    }
    return [...found].filter((el) => el.tagName !== 'INPUT' && answerable(el));
  }

  /**
   * The box the page itself ties to the selection, or the boxes it can't
   * choose between. A question inside a <label> belongs to that label's
   * control. Otherwise the smallest container around the selection that
   * holds exactly one answerable box decides it: a quiz item, a form row, a
   * message with its reply box. If the walk first reaches a container with
   * several boxes, those are the choices.
   * Returns { target } or { choices } (possibly empty).
   */
  function structuralMatch(range) {
    let start = range && range.commonAncestorContainer;
    if (start && start.nodeType !== 1) start = start.parentElement;
    if (!start || start.ownerDocument !== document) return { choices: [] };

    const label = start.closest('label');
    const control = label && label.control ? editableRoot(label.control) : null;
    if (control && answerable(control)) return { target: control };

    const from = rectCenter(range.getBoundingClientRect());
    for (let el = start; el && !el.matches(PAGE_ROOTS); el = el.parentElement) {
      const boxes = boxesWithin(el);
      if (boxes.length > 1) return { choices: boxes };
      if (boxes.length === 1) {
        // A lone box far away shares a wrapper, not a question.
        return distance(from, topRect(boxes[0])) <= SEARCH_RADIUS ? { target: boxes[0] } : { choices: [] };
      }
    }
    return { choices: [] };
  }

  /** Nearest-first multi-line guess, used when the page structure doesn't say. */
  function nearestTarget(source) {
    const candidates = multilineCandidates();
    if (!candidates.length) return null;

    const rect = sourceRect(source);
    const from = rect ? rectCenter(rect) : null;
    let best = null, bestScore = Infinity;
    for (const el of candidates) {
      const d = from ? distance(from, topRect(el)) : 0;
      if (d > SEARCH_RADIUS) continue;
      // Any empty box beats any filled one; distance breaks ties.
      const score = (isEmpty(el) ? 0 : 1e6) + d;
      if (score < bestScore) { best = el; bestScore = score; }
    }
    // A composer opened in its own pane can sit far from the email. When it
    // is the only box there is, it is the one meant.
    if (!best && candidates.length === 1) best = candidates[0];
    return best;
  }

  /** The box the user is typing in, or clicked into and went straight to Insert from. */
  function currentEditable() {
    return lastEditable && lastEditableCurrent && isVisible(lastEditable) ? lastEditable : null;
  }

  /** A box the user last used that isn't a search bar, even if they clicked away since. */
  function recentEditable() {
    return lastEditable && isVisible(lastEditable) && !isSearchLike(lastEditable) ? lastEditable : null;
  }

  /**
   * Where a draft should go. `source` is the selection Range or a viewport
   * rect {x, y, width, height}. In order: the box the user's cursor is in;
   * the box the page ties to the selection; the box the user last used;
   * then the nearest multi-line box, empty before filled. Search, filter,
   * recipient and subject boxes are never picked on their own; they get the
   * draft only when the user clicked into one and went straight to Insert.
   * Returns an element or null.
   */
  SX.findInsertTarget = function (source) {
    return SX.planInsert(source).target;
  };

  /**
   * findInsertTarget plus the boxes it couldn't choose between, for the
   * model to pick from: { target, choices }. `choices` is empty unless the
   * page structure left two or more boxes in play, and holds at most
   * MAX_CHOICES, nearest first.
   */
  SX.planInsert = function (source) {
    const current = currentEditable();
    if (current) return { target: current, choices: [] };

    const isRange = !!(source && typeof source.commonAncestorContainer !== 'undefined');
    const match = isRange ? structuralMatch(source) : { choices: [] };
    if (match.target) return { target: match.target, choices: [] };

    const target = recentEditable() || nearestTarget(source);
    let choices = match.choices || [];
    if (choices.length > 1) {
      const rect = sourceRect(source);
      const from = rect ? rectCenter(rect) : null;
      if (from) choices = choices.map((el) => [el, distance(from, topRect(el))]).sort((a, b) => a[1] - b[1]).map(([el]) => el);
      choices = choices.slice(0, MAX_CHOICES);
    } else {
      choices = [];
    }
    return { target, choices };
  };

  /** The box the user clicked into after `since` (ms), if they're still on it. */
  SX.editableChosenSince = function (since) {
    return lastEditableAt > since ? currentEditable() : null;
  };

  // ── Describing boxes for the model ─────────────────────────────
  // Only what a sighted user reads around a box: its label and the question
  // or heading near it. Never what is typed in this or any other box.

  function textOutsideBoxes(root, limit) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, noscript, textarea, select, option, [contenteditable]:not([contenteditable="false"])')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (SX.isSynapseUI(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let out = '';
    for (let node = walker.nextNode(); node && out.length < limit; node = walker.nextNode()) {
      out += ' ' + node.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function labelOf(el) {
    const host = boxOf(el);
    const doc = el.ownerDocument;
    const parts = [];
    if (el.labels && el.labels.length) parts.push(...[...el.labels].map((l) => textOutsideBoxes(l, 120)));
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    for (const id of labelledBy) {
      const ref = doc.getElementById(id);
      if (ref) parts.push(textOutsideBoxes(ref, 120));
    }
    for (const node of host === el ? [el] : [el, host]) {
      for (const attr of ['aria-label', 'placeholder', 'title']) {
        const v = node.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    if (!parts.length && el.getAttribute('name')) parts.push(el.getAttribute('name'));
    return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(' / ').slice(0, 160);
  }

  /** The nearest readable text around a box: usually the question it answers. */
  function promptNear(el) {
    let node = boxOf(el).parentElement;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) {
      const text = textOutsideBoxes(node, 240);
      if (text.length >= 15) return text;
    }
    return '';
  }

  function boxKind(el) {
    if (el.tagName === 'INPUT') return 'single-line';
    return 'multi-line';
  }

  /** [{ label, prompt, kind, empty }] for each box, in order. */
  SX.describeInsertChoices = function (boxes) {
    return boxes.map((el) => ({
      label: labelOf(el),
      prompt: promptNear(el),
      kind: boxKind(el),
      empty: isEmpty(el)
    }));
  };

  /** True while `el` can still take the draft. */
  SX.insertTargetUsable = function (el) {
    return !!(el && el.isConnected && editableRoot(el) === el && isVisible(el));
  };

  /**
   * Types `text` into `el` at its end, as the user would. Uses insertText so
   * Ctrl+Z undoes it and editors (React, Gmail, Outlook) see a real input.
   * Works for boxes inside same-origin iframes, so commands and events go to
   * the box's own document and window. Returns true when the text landed.
   */
  SX.insertText = function (el, text) {
    if (!SX.insertTargetUsable(el) || !text) return false;
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    // Focus has to reach the frame before the editor inside it.
    frameChain(el).reverse().forEach((frame) => { try { frame.focus({ preventScroll: true }); } catch (_) {} });
    el.focus({ preventScroll: false });

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const value = el.tagName === 'INPUT' ? text.replace(/\s*\n+\s*/g, ' ') : text;
      const before = el.value;
      const end = before.length;
      el.setSelectionRange(end, end);
      const sep = before && !/\s$/.test(before) ? (el.tagName === 'INPUT' ? ' ' : '\n') : '';
      let ok = false;
      try { ok = doc.execCommand('insertText', false, sep + value); } catch (_) { ok = false; }
      if (!ok || el.value === before) {
        el.setRangeText(sep + value, end, end, 'end');
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return el.value !== before;
    }

    // contenteditable: caret to the end, then insert line by line so each
    // paragraph becomes the editor's own line break.
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const before = el.innerText;
    const lines = text.split('\n');
    let ok = true;
    try {
      lines.forEach((line, i) => {
        if (i > 0) ok = doc.execCommand('insertLineBreak') && ok;
        if (line) ok = doc.execCommand('insertText', false, line) && ok;
      });
    } catch (_) { ok = false; }
    if (!ok && el.innerText === before) {
      // Editors that refuse execCommand: plain text nodes, then an input event.
      const frag = doc.createDocumentFragment();
      lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(doc.createElement('br'));
        frag.appendChild(doc.createTextNode(line));
      });
      range.insertNode(frag);
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return el.innerText !== before;
  };
})();
