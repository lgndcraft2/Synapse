// ================================================================
// SYNAPSE EXPLAIN — highlight-to-explain
// A bubble appears next to a text selection; clicking it (or Alt+Shift+E)
// explains the selection and paints it Synapse green with the CSS Custom
// Highlight API. Clicking an already-green passage reopens its saved
// explanation without an API call.
// Selections inside the document reader's content are allowed (explained
// against the original document); on a host page with a content root, only
// selections inside that root are.
// ================================================================
(function () {
  'use strict';
  const SX = globalThis.SynapseExplain;
  if (!SX || SX.explainSelection) return;
  const G = SX.G;
  const st = SX.state;

  const SHORTCUT_LABEL = 'Alt+Shift+E';
  const BULB = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`;

  let bubble = null;
  let pending = null;  // { range, text }
  let evalTimer = null;
  let rafPending = false;

  /** The current selection if it is explainable, else null. */
  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    if (SX.focusInEditable()) return null;
    const range = sel.getRangeAt(0);
    for (const node of [range.commonAncestorContainer, range.startContainer, range.endContainer]) {
      if (SX.isSynapseUI(node) || SX.isEditable(node) || !SX.inContentRoot(node)) return null;
    }
    return { range: range.cloneRange(), text };
  }

  function ensureBubble() {
    if (bubble && bubble.isConnected) return bubble;
    SX.injectStyles();
    bubble = document.createElement('button');
    bubble.id = 'synapse-bubble';
    bubble.type = 'button';
    bubble.setAttribute('aria-label', `Explain selection with Synapse (${SHORTCUT_LABEL})`);
    bubble.title = `Explain with Synapse (${SHORTCUT_LABEL})`;
    bubble.innerHTML = BULB;
    // Keep the page selection alive: a mousedown on a button would collapse it.
    bubble.addEventListener('mousedown', (e) => e.preventDefault());
    bubble.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); SX.explainSelection(); });
    bubble.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideBubble(); });
    document.body.appendChild(bubble);
    return bubble;
  }

  function positionBubble() {
    if (!bubble || !pending) return;
    const rects = pending.range.getClientRects();
    const last = rects[rects.length - 1] || pending.range.getBoundingClientRect();
    if (!last || (last.width === 0 && last.height === 0)) { hideBubble(); return; }
    const size = 34;
    let left = last.right + 6;
    let top = last.bottom + 4;
    if (left + size > window.innerWidth - 8) left = Math.max(8, last.right - size);
    if (top + size > window.innerHeight - 8) {
      const first = rects[0] || last;
      top = first.top - size - 6;
    }
    if (top < 0 || top > window.innerHeight || last.bottom < 0) { bubble.style.setProperty('display', 'none', 'important'); return; }
    bubble.style.removeProperty('display');
    bubble.style.setProperty('left', `${Math.round(left)}px`, 'important');
    bubble.style.setProperty('top', `${Math.round(top)}px`, 'important');
  }

  function showBubble(sel) {
    pending = sel;
    ensureBubble();
    positionBubble();
  }

  function hideBubble() {
    pending = null;
    if (bubble) { bubble.remove(); bubble = null; }
  }
  SX.hideBubble = hideBubble;

  function evaluate() {
    if (SX.isCircling?.()) { hideBubble(); return; }
    const sel = readSelection();
    if (sel) showBubble(sel); else if (document.activeElement !== bubble) hideBubble();
  }

  function schedule() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(evaluate, 160);
  }

  function onScroll() {
    if (!pending || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionBubble(); });
  }

  /** Explains the current (or last bubbled) selection. */
  SX.explainSelection = function () {
    const sel = readSelection() || pending;
    hideBubble();
    if (!sel) return false;

    const text = G.normalizeText(sel.text) ? sel.text.trim() : '';
    if (!text) return false;
    const range = sel.range;
    const anchor = SX.anchorFromRange(range) || SX.fitAnchor({ quote: G.normalizeText(text), prefix: '', suffix: '' });
    const key = `pending-${st.requestSeq + 1}`;

    // Context is read before the selection is cleared and the page repaints.
    const policy = SX.contextPolicy ? SX.contextPolicy() : { allowed: false };
    const docSrc = SX.documentForExplain ? SX.documentForExplain(range.startContainer) : null;
    let context = null;
    try {
      context = SX.collectContext ? SX.collectContext({ range, includePage: policy.allowed && !docSrc }) : null;
    } catch (_) { context = null; }

    SX.addHighlight(key, range);
    window.getSelection()?.removeAllRanges(); // let the green show instead of the selection colour

    SX.requestExplain(
      {
        kind: 'text',
        text: G.truncate(text, 100000),
        anchor,
        context,
        document: policy.allowed ? docSrc : null
      },
      {
        snippet: G.truncate(G.normalizeText(text), 140),
        onResult(res, entry) {
          if (res && res.ok && entry) {
            SX.renameHighlight(key, entry.id);
            SX.repaintHighlights();
            SX.pulseRange(range);
          } else if (res && res.ok) {
            SX.pulseRange(range); // explained but not saved anywhere; keep it green for this visit
          } else {
            SX.removeHighlight(key);
          }
        }
      }
    );
    return true;
  };

  // ── Paint saved text entries ───────────────────────────────────
  /** Paints one entry's quote if it is on this page. Returns true when painted. */
  SX.paintEntry = function (entry, idx) {
    if (!entry || entry.kind === 'image' || !entry.anchor || !entry.anchor.quote) return false;
    if (G.pageKey(entry.url) !== st.pageKey) return false;
    if (st.highlights.has(entry.id)) return true;
    const range = SX.findAnchorRange(entry.anchor, idx);
    if (!range) return false;
    SX.addHighlight(entry.id, range);
    return true;
  };

  /** Paints every text entry for this page. Returns entries that couldn't be found. */
  SX.paintAllEntries = function () {
    const candidates = st.history.filter(e => e.kind !== 'image' && G.pageKey(e.url) === st.pageKey && !st.highlights.has(e.id));
    if (!candidates.length) return [];
    const idx = SX.buildTextIndex();
    return candidates.filter(e => !SX.paintEntry(e, idx));
  };

  // ── Click on a green passage reopens its explanation ───────────
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  function pointInRects(range, x, y) {
    for (const r of range.getClientRects()) {
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
    }
    return false;
  }

  function onDocumentClick(e) {
    if (e.button !== 0 || !st.highlights.size) return;
    if (SX.isSynapseUI(e.target) || SX.isCircling?.()) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // the user was selecting, not clicking
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret) return;
    for (const [key, range] of st.highlights) {
      if (key.startsWith('pending-')) continue;
      let inside = false;
      try { inside = range.isPointInRange(caret.node, caret.offset); } catch (_) { inside = false; }
      if (!inside || !pointInRects(range, e.clientX, e.clientY)) continue;
      const entry = SX.findEntry(key);
      if (entry) { SX.showEntry(entry); SX.pulseRange(range); }
      return;
    }
  }

  function onKeydown(e) {
    if (e.code === 'KeyE' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.repeat || SX.focusInEditable()) return;
      if (readSelection() || pending) {
        e.preventDefault();
        SX.explainSelection();
      }
    }
  }

  SX.initHighlight = function () {
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', schedule, true);
    document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift' || e.key.startsWith('Arrow')) schedule(); }, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  };
})();
