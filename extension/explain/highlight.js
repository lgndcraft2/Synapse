// ================================================================
// SYNAPSE EXPLAIN — highlight-to-explain
// A bubble appears next to a text selection; clicking it (or Alt+Shift+E)
// explains the selection and paints it Synapse green with the CSS Custom
// Highlight API. Clicking an already-green passage reopens its saved
// explanation without an API call. A Respond button beside it (or
// Alt+Shift+R) suggests a reply, answer or tips instead; it leads when the
// selection looks like it expects one.
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
  const RESPOND_SHORTCUT_LABEL = 'Alt+Shift+R';
  const REPLY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>';
  const QUESTION_START = /^(who|what|when|where|why|how|which|whose|whom|can|could|would|will|shall|should|do|does|did|is|are|was|were|have|has|may|might|please|kindly)\b/i;
  // The Synapse mark, as on the FAB (content.js); own mask ids so the two
  // never collide when both are on the page.
  const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="4.8">` +
    `<mask id="synapse-bubble-cut-1" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff" stroke="none"/><path d="M7.2 8 16.8 4.4" stroke="#000" stroke-width="5.7"/></mask>` +
    `<mask id="synapse-bubble-cut-2" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff" stroke="none"/><path d="M7.2 12.5 16.8 14.6" stroke="#000" stroke-width="5.7"/></mask>` +
    `<path d="M7.2 19.6 16.8 17" mask="url(#synapse-bubble-cut-2)"/>` +
    `<path d="M7.2 12.5 16.8 14.6" mask="url(#synapse-bubble-cut-1)"/>` +
    `<path d="M7.2 8 16.8 4.4"/></svg>`;

  let bubble = null;
  let respondBubble = null;
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
    bubble.innerHTML = MARK;
    // Keep the page selection alive: a mousedown on a button would collapse it.
    bubble.addEventListener('mousedown', (e) => e.preventDefault());
    bubble.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); SX.explainSelection(); });
    bubble.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideBubble(); });
    document.body.appendChild(bubble);

    respondBubble = document.createElement('button');
    respondBubble.id = 'synapse-respond-bubble';
    respondBubble.type = 'button';
    respondBubble.setAttribute('aria-label', `Suggest a reply, answer or tips with Synapse (${RESPOND_SHORTCUT_LABEL})`);
    respondBubble.title = `Respond: suggest a reply, answer or tips (${RESPOND_SHORTCUT_LABEL})`;
    respondBubble.innerHTML = REPLY_ICON;
    respondBubble.addEventListener('mousedown', (e) => e.preventDefault());
    respondBubble.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); SX.respondSelection(); });
    respondBubble.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideBubble(); });
    document.body.appendChild(respondBubble);
    return bubble;
  }

  /**
   * Local guess that the selection wants a reply or an answer: a question, a
   * mail or messaging site, or an empty text box or choice nearby. Only
   * decides which button leads; both always work.
   */
  SX.looksLikeItExpectsReply = function (sel) {
    const text = String(sel && sel.text || '').trim();
    if (!text) return false;
    if (/\?\s*$/.test(text) || QUESTION_START.test(text)) return true;
    const CX = globalThis.SynapseContext;
    if (CX && CX.isSensitiveHost && CX.isSensitiveHost(st.hostname)) return true;
    let el = sel.range.commonAncestorContainer;
    if (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (el.querySelector && el.querySelector('input[type="radio"],input[type="checkbox"],select')) return true;
    }
    return !!(SX.findInsertTarget && SX.findInsertTarget(sel.range));
  };

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
    if (left + size * 2 + 6 > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - size * 2 - 6);
    const both = [bubble, respondBubble].filter(Boolean);
    if (top < 0 || top > window.innerHeight || last.bottom < 0) {
      both.forEach(b => b.style.setProperty('display', 'none', 'important'));
      return;
    }
    // The suggested action sits first, nearest the selection.
    const [first, second] = pending.expectsReply && respondBubble ? [respondBubble, bubble] : [bubble, respondBubble];
    both.forEach(b => b.style.removeProperty('display'));
    first.style.setProperty('left', `${Math.round(left)}px`, 'important');
    first.style.setProperty('top', `${Math.round(top)}px`, 'important');
    if (second) {
      second.style.setProperty('left', `${Math.round(left + size + 6)}px`, 'important');
      second.style.setProperty('top', `${Math.round(top)}px`, 'important');
    }
  }

  function showBubble(sel) {
    // Same selection as before (selectionchange fires often): keep the guess.
    const same = pending && pending.text === sel.text;
    sel.expectsReply = same ? pending.expectsReply : SX.looksLikeItExpectsReply(sel);
    pending = sel;
    ensureBubble();
    respondBubble?.classList.toggle('s-suggested', !!sel.expectsReply);
    bubble.classList.toggle('s-quiet', !!sel.expectsReply);
    positionBubble();
  }

  function hideBubble() {
    pending = null;
    if (bubble) { bubble.remove(); bubble = null; }
    if (respondBubble) { respondBubble.remove(); respondBubble = null; }
  }
  SX.hideBubble = hideBubble;

  function evaluate() {
    if (SX.isCircling?.()) { hideBubble(); return; }
    const sel = readSelection();
    if (sel) showBubble(sel);
    else if (document.activeElement !== bubble && document.activeElement !== respondBubble) hideBubble();
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

  /** Text, anchor and context for a selection, read before it is cleared. */
  function gather(sel) {
    const text = G.normalizeText(sel.text) ? sel.text.trim() : '';
    if (!text) return null;
    const range = sel.range;
    const anchor = SX.anchorFromRange(range) || SX.fitAnchor({ quote: G.normalizeText(text), prefix: '', suffix: '' });
    const policy = SX.contextPolicy ? SX.contextPolicy() : { allowed: false };
    const docSrc = SX.documentForExplain ? SX.documentForExplain(range.startContainer) : null;
    let context = null;
    try {
      context = SX.collectContext ? SX.collectContext({ range, includePage: policy.allowed && !docSrc }) : null;
    } catch (_) { context = null; }
    return { text, range, anchor, context, document: policy.allowed ? docSrc : null };
  }

  /** Suggests a reply, answer or tips for the current (or last bubbled) selection. */
  SX.respondSelection = function () {
    const sel = readSelection() || pending;
    hideBubble();
    if (!sel) return false;
    const g = gather(sel);
    if (!g) return false;
    // Where an Insert would go, found while the page is as the user saw it.
    // When the page leaves several boxes in play, the model picks among them,
    // but only where page context may be sent (their labels are page content).
    const plan = SX.planInsert ? SX.planInsert(g.range) : { target: null, choices: [] };
    const policy = SX.contextPolicy ? SX.contextPolicy() : { allowed: false };
    const choices = policy.allowed ? plan.choices : [];
    // Not painted green: respond results aren't saved, so there'd be nothing to reopen.
    SX.requestExplain(
      {
        kind: 'text', text: G.truncate(g.text, 100000), anchor: g.anchor, context: g.context, document: g.document, mode: 'respond',
        ...(choices.length ? { answerFields: SX.describeInsertChoices(choices) } : {})
      },
      { snippet: G.truncate(G.normalizeText(g.text), 140), insertSource: g.range, insertTarget: plan.target, insertChoices: choices }
    );
    return true;
  };

  /** Explains the current (or last bubbled) selection. */
  SX.explainSelection = function () {
    const sel = readSelection() || pending;
    hideBubble();
    if (!sel) return false;

    const g = gather(sel);
    if (!g) return false;
    const { text, range, anchor, context } = g;
    const key = `pending-${st.requestSeq + 1}`;

    SX.addHighlight(key, range);
    window.getSelection()?.removeAllRanges(); // let the green show instead of the selection colour

    SX.requestExplain(
      {
        kind: 'text',
        text: G.truncate(text, 100000),
        anchor,
        context,
        document: g.document
      },
      {
        snippet: G.truncate(G.normalizeText(text), 140),
        // Kept so "Draft a reply" on this explanation can Insert near it.
        insertSource: range,
        insertTarget: SX.findInsertTarget ? SX.findInsertTarget(range) : null,
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
    if (!(e.altKey && e.shiftKey) || e.ctrlKey || e.metaKey) return;
    const action = e.code === 'KeyE' ? SX.explainSelection : e.code === 'KeyR' ? SX.respondSelection : null;
    if (!action || e.repeat || SX.focusInEditable()) return;
    if (readSelection() || pending) {
      e.preventDefault();
      action();
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
