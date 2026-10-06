// ================================================================
// SYNAPSE EXPLAIN — circle-to-explain
// Chord mode: hold Alt+S, move the pointer (no button) to trace, release
//             either key to finish.
// FAB mode:   click the floating button, then click to start, trace, and
//             click again to finish (press-and-drag-release also works).
// Escape, window blur, tab hide, or scrolling cancel either mode.
//
// Confirm step: when tracing ends the background captures and masks the
// crop but sends nothing. A bar next to the circle previews exactly what
// would be sent: Confirm (Enter) explains it, Retry (R) traces again,
// Cancel (Esc) discards it. No API call and no quota before Confirm.
// ================================================================
(function () {
  'use strict';
  const SX = globalThis.SynapseExplain;
  if (!SX || SX.startCircle) return;
  const G = SX.G;

  const MIN_AREA = 400;       // px², hull area below this is treated as a stray flick
  const MIN_STEP = 2;         // px between recorded points
  const MAX_POINTS = 4000;
  const DRAG_FINISH_DIST = 12;

  let mode = null;            // null | 'chord' | 'click'
  let phase = null;           // 'armed' | 'tracing'
  let points = [];
  let overlay = null;
  let polyline = null;
  let drawQueued = false;
  let pointerDown = false;
  let downAt = null;
  let lastPointer = null;
  let captureFallback = null;
  let captureToken = 0;       // ignores capture results for an abandoned circle
  let confirmState = null;    // the open confirm bar, see showConfirm()
  let focusBefore = null;     // focus to restore on cancel
  let pendingCapture = false; // screenshot in flight, bar not shown yet

  SX.isCircling = () => mode !== null || confirmState !== null || pendingCapture;
  SX.isConfirming = () => confirmState !== null;

  // Tracks the pointer so a chord trace can start from where the pointer is.
  document.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });

  // ── Overlay ────────────────────────────────────────────────────
  function buildOverlay() {
    SX.injectStyles();
    overlay = document.createElement('div');
    overlay.id = 'synapse-circle-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><polyline points=""></polyline></svg>';
    polyline = overlay.querySelector('polyline');
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });
    document.body.appendChild(overlay);
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    polyline = null;
  }

  function draw() {
    drawQueued = false;
    if (!polyline) return;
    polyline.setAttribute('points', points.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' '));
  }

  function addPoint(x, y) {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - x) < MIN_STEP && Math.abs(last.y - y) < MIN_STEP) return;
    if (points.length >= MAX_POINTS) return;
    points.push({ x, y });
    if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); }
  }

  // ── Pointer handling ───────────────────────────────────────────
  function onPointerMove(e) {
    if (!mode) return;
    if (mode === 'chord' || phase === 'tracing') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (events.length ? events : [e])) addPoint(ev.clientX, ev.clientY);
    }
  }

  function onPointerDown(e) {
    if (mode !== 'click') { e.preventDefault(); return; }
    e.preventDefault();
    if (phase === 'armed') {
      phase = 'tracing';
      points = [];
      addPoint(e.clientX, e.clientY);
      pointerDown = true;
      downAt = { x: e.clientX, y: e.clientY };
      try { overlay.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      SX.showTip('Trace around it, then click to finish. Esc cancels.');
    } else if (phase === 'tracing') {
      addPoint(e.clientX, e.clientY);
      finish();
    }
  }

  function onPointerUp(e) {
    if (mode !== 'click' || phase !== 'tracing' || !pointerDown) return;
    pointerDown = false;
    // Press-and-drag: releasing after a real drag finishes the trace.
    const dist = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 0;
    if (points.length >= 3 && (dist > DRAG_FINISH_DIST || G.polygonArea(G.convexHull(points)) >= MIN_AREA)) {
      addPoint(e.clientX, e.clientY);
      finish();
    }
  }

  // ── Keyboard + cancellation ────────────────────────────────────
  function onKeyDown(e) {
    if (confirmState && onConfirmKey(e)) return;
    if (mode && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.code !== 'KeyS' || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (SX.focusInEditable()) return;
    e.preventDefault(); // keep Alt+S / Option+S from typing or reaching menus
    if (e.repeat || mode) return;
    if (confirmState) teardownConfirm({ discard: true });
    SX.startCircle('chord');
  }

  function onKeyUp(e) {
    if (mode !== 'chord') return;
    if (e.code === 'KeyS' || e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
      e.preventDefault();
      finish();
    }
  }

  function onCancelEvent() { if (mode) cancel(); }
  function onVisibility() { if (document.hidden && mode) cancel(); }
  function onScroll(e) {
    if (!mode) return;
    if (e.target && SX.isSynapseUI(e.target)) return;
    cancel();
  }

  function attachSessionListeners() {
    window.addEventListener('blur', onCancelEvent);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  }

  function detachSessionListeners() {
    window.removeEventListener('blur', onCancelEvent);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('scroll', onScroll, { capture: true });
  }

  function endSession() {
    mode = null;
    phase = null;
    pointerDown = false;
    downAt = null;
    detachSessionListeners();
    removeOverlay();
    document.getElementById('synapse-fab')?.classList.remove('s-circling');
  }

  function cancel() {
    endSession();
    points = [];
    captureToken++;
    pendingCapture = false;
    SX.onCaptureDone();
    SX.hideTip();
    if (confirmState) teardownConfirm({ discard: true });
  }
  SX.cancelCircle = cancel;

  // ── Start ──────────────────────────────────────────────────────
  SX.startCircle = function (how) {
    if (mode || confirmState || pendingCapture) cancel();
    if (!focusBefore || !focusBefore.isConnected) {
      const active = document.activeElement;
      focusBefore = active && active !== document.body ? active : null;
    }
    SX.hideBubble?.();
    SX.closeFabMenu?.();
    mode = how === 'chord' ? 'chord' : 'click';
    points = [];
    buildOverlay();
    attachSessionListeners();
    document.getElementById('synapse-fab')?.classList.add('s-circling');

    if (mode === 'chord') {
      phase = 'tracing';
      if (lastPointer) addPoint(lastPointer.x, lastPointer.y);
      SX.showTip('Keep holding Alt+S and move the pointer around what you want explained. Let go to finish.');
    } else {
      phase = 'armed';
      SX.showTip('Click where you want to start, trace around it, then click again. Esc cancels.');
    }
  };

  // ── Finish: hull, text, anchor, capture (no send) ──────────────
  function finish() {
    if (!mode) return;
    const how = mode;
    const trace = points.slice();
    endSession();
    points = [];

    const hull = G.convexHull(trace);
    if (hull.length < 3 || G.polygonArea(hull) < MIN_AREA) {
      SX.showTip('That circle was too small. Try a bigger loop around what you want explained.', { message: true, duration: 2800 });
      return;
    }
    SX.hideTip();

    const box = G.bbox(hull);
    const extracted = extractTextInHull(hull, box);
    const anchor = buildAnchor(hull, box, extracted);
    const sel = { how, hull, box, text: extracted.text, anchor, ...circleContext(hull, box, extracted) };
    prepareCapture(sel);
  }

  /** Local (and, when allowed, page or document) context for the circled area. */
  function circleContext(hull, box, extracted) {
    let context = null, doc = null;
    try {
      const target = SX.circleTarget ? SX.circleTarget(hull, box, extracted.pieces) : { element: null, interactive: false };
      let range = null;
      if (extracted.pieces.length) {
        range = document.createRange();
        range.setStart(extracted.pieces[0].node, extracted.pieces[0].start);
        const last = extracted.pieces[extracted.pieces.length - 1];
        range.setEnd(last.node, last.end);
      }
      const policy = SX.contextPolicy ? SX.contextPolicy() : { allowed: false };
      const focusNode = target.element || (range && range.startContainer) || null;
      const src = focusNode && SX.documentForExplain ? SX.documentForExplain(focusNode) : (SX.H.documentSource() || null);
      doc = policy.allowed ? src : null;
      if (SX.collectContext) {
        context = SX.collectContext({
          range,
          element: target.element,
          interactive: target.interactive ? target.element : null,
          includePage: policy.allowed && !src
        });
      }
    } catch (_) { /* context is best effort */ }
    return { context, document: doc };
  }

  /**
   * Text inside the hull. Text nodes whose boxes fall wholly inside are kept
   * whole; nodes straddling the edge are tested word by word (cheap enough
   * below a few thousand characters), longer ones per line box.
   */
  function extractTextInHull(hull, box) {
    const pieces = [];
    const range = document.createRange();
    const inside = (r) => G.pointInPolygon({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, hull);
    const cornersInside = (r) =>
      G.pointInPolygon({ x: r.left, y: r.top }, hull) && G.pointInPolygon({ x: r.right, y: r.top }, hull) &&
      G.pointInPolygon({ x: r.left, y: r.bottom }, hull) && G.pointInPolygon({ x: r.right, y: r.bottom }, hull);

    for (const node of SX.collectTextNodes(SX.activeTextRoot())) {
      const data = node.data;
      if (!data.trim()) continue;
      range.selectNodeContents(node);
      const b = range.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (!G.rectsIntersect({ x: b.left, y: b.top, width: b.width, height: b.height }, box)) continue;

      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      if (rects.every(cornersInside)) {
        pieces.push({ node, start: 0, end: data.length, text: data });
        continue;
      }
      if (data.length <= 4000) {
        const re = /\S+/g;
        let m, s = -1, e = -1;
        const words = [];
        while ((m = re.exec(data))) {
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const wr = range.getBoundingClientRect();
          if (wr.width === 0 && wr.height === 0) continue;
          if (inside(wr)) {
            words.push(m[0]);
            if (s < 0) s = m.index;
            e = m.index + m[0].length;
          }
        }
        if (words.length) pieces.push({ node, start: s, end: e, text: words.join(' ') });
      } else if (rects.some(inside)) {
        pieces.push({ node, start: 0, end: data.length, text: data });
      }
    }

    const text = G.truncate(G.normalizeText(pieces.map(p => p.text).join(' ')), 20000);
    return { text, pieces };
  }

  /** The element that best matches the circled box, if any, for return-to-source. */
  function mainElement(hull, box) {
    const c = G.centroid(hull);
    let candidates = [];
    try { candidates = document.elementsFromPoint(c.x, c.y); } catch (_) { candidates = []; }
    const boxArea = Math.max(1, box.width * box.height);
    const rootEl = SX.activeTextRoot();
    for (const el of candidates) {
      if (el === document.body || el === document.documentElement || SX.isSynapseUI(el)) continue;
      if (rootEl && rootEl !== document.body && !rootEl.contains(el)) continue; // under the reader / outside the viewer root
      const r = el.getBoundingClientRect();
      const rr = { x: r.left, y: r.top, width: r.width, height: r.height };
      const covered = G.intersectionArea(rr, box) / boxArea;
      if (covered >= 0.6 && rr.width * rr.height <= boxArea * 4) return el;
    }
    return null;
  }

  function buildAnchor(hull, box, extracted) {
    const anchor = {
      rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    };
    const el = mainElement(hull, box);
    const selector = el ? SX.cssPath(el) : null;
    if (selector) anchor.selector = selector;

    const { pieces } = extracted;
    if (pieces.length) {
      try {
        const r = document.createRange();
        r.setStart(pieces[0].node, pieces[0].start);
        const last = pieces[pieces.length - 1];
        r.setEnd(last.node, last.end);
        const idx = SX.buildTextIndex();
        const off = SX.offsetsFromRange(idx, r);
        if (off) Object.assign(anchor, G.buildTextAnchor(idx.text, off.start, off.end, { maxQuote: 300, endLen: 60 }));
      } catch (_) { /* text anchor is optional for circles */ }
    }
    return SX.fitAnchor(anchor);
  }

  function hideSynapseUI() {
    document.documentElement.classList.add('synapse-capture-hide');
    clearTimeout(captureFallback);
    captureFallback = setTimeout(SX.onCaptureDone, 3000);
  }

  SX.onCaptureDone = function () {
    clearTimeout(captureFallback);
    document.documentElement.classList.remove('synapse-capture-hide');
  };

  /** Screenshot + crop + mask in the background, kept there until Confirm. */
  async function prepareCapture(sel) {
    const token = ++captureToken;
    pendingCapture = true;
    SX.hideBubble?.();
    hideSynapseUI();
    // The overlay is already gone; let the page repaint before the screenshot.
    await SX.nextFrames(2);
    const res = await SX.send({
      type: 'CAPTURE_REGION',
      capture: {
        rect: { x: sel.box.x, y: sel.box.y, width: sel.box.width, height: sel.box.height },
        hull: sel.hull,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      }
    });
    SX.onCaptureDone();
    if (token !== captureToken) {
      // The user moved on (cancelled, retried, navigated): drop the crop.
      if (res && res.captureId) SX.send({ type: 'DISCARD_CAPTURE', captureId: res.captureId });
      return;
    }
    pendingCapture = false;
    const hasImage = !!(res && res.ok && res.hasImage && res.captureId);
    showConfirm({
      ...sel,
      captureId: hasImage ? res.captureId : null,
      hasImage,
      preview: hasImage ? res.preview : null,
      docRect: { x: sel.box.x + window.scrollX, y: sel.box.y + window.scrollY, width: sel.box.width, height: sel.box.height }
    });
  }

  // ── Confirm bar ────────────────────────────────────────────────
  function buildOutline(sel) {
    const pad = 4;
    const wrap = document.createElement('div');
    wrap.id = 'synapse-circle-outline';
    wrap.setAttribute('aria-hidden', 'true');
    const w = sel.box.width + pad * 2;
    const h = sel.box.height + pad * 2;
    wrap.style.setProperty('left', `${sel.docRect.x - pad}px`, 'important');
    wrap.style.setProperty('top', `${sel.docRect.y - pad}px`, 'important');
    wrap.style.setProperty('width', `${w}px`, 'important');
    wrap.style.setProperty('height', `${h}px`, 'important');
    const pts = sel.hull.map(p => `${Math.round(p.x - sel.box.x + pad)},${Math.round(p.y - sel.box.y + pad)}`).join(' ');
    wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}"><polygon points="${pts}"></polygon></svg>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  function button(label, key, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.append(document.createTextNode(label));
    const k = document.createElement('kbd');
    k.textContent = key;
    k.setAttribute('aria-hidden', 'true');
    b.append(k);
    b.setAttribute('aria-keyshortcuts', key === 'Esc' ? 'Escape' : key);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  /** Viewport position next to the circle, inside the viewport. */
  function placeBar(bar, box) {
    const gap = 12, m = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const fits = (x, y) => x >= m && y >= m && x + w <= vw - m && y + h <= vh - m;
    const clampX = (x) => Math.max(m, Math.min(x, vw - w - m));
    const clampY = (y) => Math.max(m, Math.min(y, vh - h - m));
    const options = [
      [box.x + box.width + gap, clampY(box.y)],                // right
      [box.x - w - gap, clampY(box.y)],                         // left
      [clampX(box.x), box.y + box.height + gap],                // below
      [clampX(box.x), box.y - h - gap]                          // above
    ];
    let pos = options.find(([x, y]) => fits(x, y));
    if (!pos) pos = [clampX(box.x + box.width + gap), clampY(box.y + box.height + gap)];
    bar.style.setProperty('left', `${Math.round(pos[0] + window.scrollX)}px`, 'important');
    bar.style.setProperty('top', `${Math.round(pos[1] + window.scrollY)}px`, 'important');
  }

  function showConfirm(sel) {
    SX.injectStyles();
    const canConfirm = sel.hasImage || !!sel.text;
    const outline = buildOutline(sel);

    const bar = document.createElement('div');
    bar.id = 'synapse-confirm-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-modal', 'false');
    bar.setAttribute('aria-labelledby', 'synapse-confirm-title');
    bar.style.setProperty('visibility', 'hidden', 'important');
    bar.style.setProperty('left', '0px', 'important');
    bar.style.setProperty('top', '0px', 'important');

    if (canConfirm) {
      const preview = document.createElement('div');
      preview.className = 'sxc-preview';
      if (sel.hasImage && sel.preview) {
        const img = document.createElement('img');
        img.src = sel.preview;
        img.alt = 'Preview of the circled area that will be sent';
        preview.appendChild(img);
      } else {
        const snip = document.createElement('span');
        snip.className = 'sxc-snippet';
        snip.textContent = G.truncate(sel.text, 220);
        preview.appendChild(snip);
      }
      bar.appendChild(preview);
    }

    const main = document.createElement('div');
    main.className = 'sxc-main';
    const title = document.createElement('span');
    title.id = 'synapse-confirm-title';
    title.className = 'sxc-title' + (canConfirm ? '' : ' s-error');
    title.textContent = !canConfirm ? "Couldn't read that area, try circling again."
      : sel.hasImage ? 'Explain this circled area?' : 'Explain the text in this area?';
    const actions = document.createElement('div');
    actions.className = 'sxc-actions';
    if (canConfirm) actions.appendChild(button('Confirm', 'Enter', 's-primary sxc-confirm', confirmCircle));
    actions.appendChild(button('Retry', 'R', 'sxc-retry', retryCircle));
    actions.appendChild(button('Cancel', 'Esc', 'sxc-cancel', () => cancelConfirm()));
    const live = document.createElement('span');
    live.className = 'sxc-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    main.append(title, actions, live);
    bar.appendChild(main);
    document.body.appendChild(bar);

    placeBar(bar, sel.box);
    bar.style.removeProperty('visibility');
    confirmState = { ...sel, canConfirm, bar, outline };

    const first = bar.querySelector(canConfirm ? '.sxc-confirm' : '.sxc-retry');
    first?.focus({ preventScroll: true });
    setTimeout(() => {
      if (!live.isConnected) return;
      live.textContent = canConfirm
        ? 'Circled area ready. Press Enter to explain it, R to circle again, or Escape to cancel.'
        : "Couldn't read that area. Press R to circle again or Escape to cancel.";
    }, 60);
  }

  function teardownConfirm(opts) {
    const c = confirmState;
    if (!c) return null;
    confirmState = null;
    c.bar?.remove();
    c.outline?.remove();
    if (opts && opts.discard && c.captureId) SX.send({ type: 'DISCARD_CAPTURE', captureId: c.captureId });
    return c;
  }

  function restoreFocus() {
    const f = focusBefore;
    focusBefore = null;
    if (f && f.isConnected && typeof f.focus === 'function') f.focus({ preventScroll: true });
  }

  function cancelConfirm() {
    teardownConfirm({ discard: true });
    SX.hideTip();
    restoreFocus();
  }

  function retryCircle() {
    const c = teardownConfirm({ discard: true });
    restartIn(c ? c.how : 'click');
  }

  function restartIn(how) {
    if (how === 'chord') {
      // Hold-to-draw needs the keys held, so wait for the chord again.
      SX.showTip('Hold Alt+S and trace around what you want explained.', { message: true, duration: 4000 });
    } else {
      SX.startCircle('click');
    }
  }

  /** Keys while the bar is open. Returns true when handled. */
  function onConfirmKey(e) {
    if (SX.focusInEditable()) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cancelConfirm();
      return true;
    }
    if (e.code === 'KeyR' && !e.shiftKey) {
      if (e.repeat) return true;
      e.preventDefault(); e.stopPropagation();
      retryCircle();
      return true;
    }
    if (e.key === 'Enter') {
      // A focused bar button activates itself natively.
      if (confirmState.bar.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON') return true;
      e.preventDefault(); e.stopPropagation();
      if (confirmState.canConfirm) confirmCircle();
      return true;
    }
    return false;
  }

  /** Sends the stored crop (by id) and text. Never takes a second screenshot. */
  function confirmCircle() {
    const c = teardownConfirm({ discard: false });
    if (!c || !c.canConfirm) return;
    focusBefore = null;
    const snippet = c.text ? G.truncate(c.text, 140) : 'Circled area';
    const payload = {
      kind: c.hasImage ? 'image' : 'text',
      text: c.text,
      anchor: c.anchor,
      context: c.context,
      document: c.document,
      ...(c.hasImage ? { captureId: c.captureId } : {})
    };
    SX.requestExplain(payload, {
      snippet,
      onRetry: () => restartIn(c.how),
      onResult(res) {
        if (!res || !res.ok) return;
        let target = null;
        if (c.anchor.selector) {
          try {
            const el = document.querySelector(c.anchor.selector);
            if (el) target = { element: el };
          } catch (_) { /* ignore */ }
        }
        SX.revealSource(target || { docRect: c.docRect });
      }
    });
  }

  SX.initCircle = function () {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  };
})();
