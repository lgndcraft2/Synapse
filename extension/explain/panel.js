// ================================================================
// SYNAPSE EXPLAIN — bottom-right panel: current explanation, settings
// (Bionic, reading feel), and history for this hostname.
// ================================================================
(function () {
  'use strict';
  const SX = globalThis.SynapseExplain;
  if (!SX || SX.openPanel) return;
  const G = SX.G;
  const H = SX.H;
  const S = H.S;
  const CX = globalThis.SynapseContext;
  const st = SX.state;

  let panel = null;
  // { kind, snippet, status: 'loading'|'done'|'error', html?, error?, entryId?,
  //   actions?: [{ label, onClick, secondary? }], contextUsed?, contextNote?,
  //   versions?: [{ mode, request?, html }] (index 0 is the original), vi?,
  //   request?: what a re-explain resends, entrySource?, relookId?,
  //   redoing?, redoError?, askOpen?, askDraft?, reexplainStatus?, shownAt? }
  let current = null;
  const expanded = new Set();

  // History entries the user already rated. One opinion per explanation, so
  // "Clearer" stays gone when the entry is reopened or re-rendered.
  const RATED_KEY = 'explainFeedbackGiven';
  const RATED_MAX = 300;
  let rated = new Set();
  try {
    chrome.storage.local.get(RATED_KEY, (res) => {
      const ids = res && Array.isArray(res[RATED_KEY]) ? res[RATED_KEY] : [];
      for (const id of ids) rated.add(id);
    });
  } catch (_) { /* extension reloaded */ }

  function feedbackGiven(view) {
    return !!view.feedbackGiven || (view.entryId != null && rated.has(String(view.entryId)));
  }

  function markFeedbackGiven(view) {
    view.feedbackGiven = true;
    if (view.entryId == null) return;
    rated.add(String(view.entryId));
    rated = new Set([...rated].slice(-RATED_MAX));
    try { chrome.storage.local.set({ [RATED_KEY]: [...rated] }); } catch (_) { /* extension reloaded */ }
  }

  const KIND_LABEL = { text: 'Text', image: 'Circle' };
  const MODE_LABEL = { simpler: 'Simpler', more_detail: 'More detail', specific: 'Your request' };
  const ASK_MAX = 300;

  /** [{ mode, request, html }] with the original first, from an entry's fields. */
  function versionsFrom(originalHtml, extra) {
    const list = [{ mode: null, request: null, html: originalHtml }];
    for (const v of Array.isArray(extra) ? extra : []) {
      if (v && v.result_html) list.push({ mode: v.mode, request: v.request || null, html: v.result_html });
    }
    return list;
  }

  /** The newest version of a history entry: what the user last asked for. */
  function latestHtml(entry) {
    const extra = Array.isArray(entry.versions) ? entry.versions : [];
    return extra.length ? extra[extra.length - 1].result_html : entry.result_html;
  }

  function shownHtml(view) {
    const v = view.versions && view.versions[view.vi || 0];
    return v ? v.html : view.html;
  }
  const ICON_TEXT = 'Aa';
  const ICON_IMAGE = '◎';

  function el(sel) { return panel ? panel.querySelector(sel) : null; }

  function renderHTML(target, raw) {
    const safe = DOMPurify.sanitize(String(raw || ''));
    target.innerHTML = DOMPurify.sanitize(S.bionicReading ? H.applyBionic(safe) : safe);
    target.classList.toggle('s-bionic', !!S.bionicReading);
  }

  function snippetOf(text, n = 140) {
    return G.truncate(G.normalizeText(text), n);
  }

  // ── Build ──────────────────────────────────────────────────────
  SX.ensurePanel = function () {
    if (panel && panel.isConnected) return panel;
    H.injectBaseStyles();
    SX.injectStyles();
    panel = document.createElement('div');
    panel.id = 'synapse-explain-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Synapse explanations');
    panel.innerHTML = `
      <div class="sxp-head">
        <div class="sxp-brand">
          <span class="sp-logo">Synapse</span>
          <span class="sp-sub">Explain</span>
        </div>
        <button class="sxp-close" type="button" aria-label="Close Synapse panel">✕</button>
      </div>
      <div class="sxp-controls">
        <div class="sxp-feel" role="group" aria-label="Today's reading feel">
          <span class="sp-difficulty-label">Today's reading feel</span>
          <div class="sp-difficulty-opts">
            <button class="sp-diff-btn" type="button" data-diff="hard">Hard day</button>
            <button class="sp-diff-btn" type="button" data-diff="normal">Normal</button>
            <button class="sp-diff-btn" type="button" data-diff="easy">Flowing</button>
          </div>
        </div>
        <button class="sp-tool-btn sxp-bionic" type="button" aria-pressed="false" title="Bold the start of each word">Bionic</button>
      </div>
      <div class="sxp-context">
        <button type="button" class="sxp-switch sxp-ctx-global" role="switch" aria-checked="true"
          title="Send this page's headings and main text with each explanation so it fits the page. A text explanation with page or document context counts as 4.">
          <span class="sxp-track" aria-hidden="true"></span><span>Use page context</span>
        </button>
        <div class="sxp-site synapse-hide">
          <span class="sxp-site-note" aria-live="polite"></span>
          <button type="button" class="sxp-switch sxp-ctx-site" role="switch" aria-checked="false">
            <span class="sxp-track" aria-hidden="true"></span><span>Use page context on this site</span>
          </button>
        </div>
      </div>
      <div class="sxp-scroll">
        <section class="sxp-current synapse-hide" aria-live="polite">
          <div class="sxp-current-head">
            <span class="sxp-kind"></span>
            <span class="sxp-snippet"></span>
          </div>
          <div class="sxp-loading synapse-hide">
            <div class="sc-spinner"></div>
            <span class="sc-loading-text">Explaining…</span>
          </div>
          <div class="sxp-error synapse-hide" role="alert"></div>
          <div class="sxp-actions synapse-hide"></div>
          <div class="sxp-versions synapse-hide" role="group" aria-label="Versions of this explanation"></div>
          <div class="sc-body s-ready sxp-result synapse-hide"></div>
          <span class="sxp-ctx-used synapse-hide"></span>
          <div class="sxp-tools synapse-hide"></div>
        </section>
        <section class="sxp-history">
          <div class="sxp-history-head">
            <span class="sxp-label">On this site</span>
            <span class="sxp-clear-wrap"></span>
          </div>
          <ul class="sxp-list"></ul>
          <p class="sxp-empty"></p>
        </section>
      </div>`;
    document.body.appendChild(panel);

    el('.sxp-close').addEventListener('click', () => SX.closePanel({ restoreFocus: true }));
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); SX.closePanel({ restoreFocus: true }); }
    });

    panel.querySelectorAll('.sp-diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        S.sessionDifficulty = btn.dataset.diff;
        syncControls();
      });
    });

    el('.sxp-bionic').addEventListener('click', () => {
      S.bionicReading = !S.bionicReading;
      syncControls();
      renderCurrent();
      renderHistory();
    });

    el('.sxp-ctx-global').addEventListener('click', () => {
      const cur = st.contextSettings;
      SX.saveContextSettings({ ...cur, usePageContext: !cur.usePageContext });
      syncContextControls();
    });

    el('.sxp-ctx-site').addEventListener('click', () => {
      const cur = st.contextSettings;
      const overrides = { ...(cur.siteOverrides || {}) };
      if (overrides[st.hostname] === true) delete overrides[st.hostname];
      else overrides[st.hostname] = true;
      SX.saveContextSettings({ ...cur, siteOverrides: overrides });
      syncContextControls();
    });

    syncControls();
    syncContextControls();
    SX.loadContextSettings?.().then(syncContextControls);
    renderCurrent();
    renderHistory();
    return panel;
  };

  function syncContextControls() {
    if (!panel || !SX.contextPolicy) return;
    const settings = st.contextSettings;
    const policy = SX.contextPolicy();
    el('.sxp-ctx-global').setAttribute('aria-checked', String(settings.usePageContext !== false));
    const site = el('.sxp-site');
    site.classList.toggle('synapse-hide', !policy.sensitive);
    if (policy.sensitive) {
      el('.sxp-site-note').textContent = policy.override === true
        ? 'Page context is on for this site.'
        : 'Page context is off on this site (email, messaging or banking). Only the text near your selection is sent.';
      el('.sxp-ctx-site').setAttribute('aria-checked', String(policy.override === true));
    }
  }
  SX.onContextSettingsChanged = syncContextControls;

  function syncControls() {
    if (!panel) return;
    panel.querySelectorAll('.sp-diff-btn').forEach(b => {
      const on = b.dataset.diff === S.sessionDifficulty;
      b.classList.toggle('s-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const bionic = el('.sxp-bionic');
    bionic.classList.toggle('s-on', !!S.bionicReading);
    bionic.setAttribute('aria-pressed', String(!!S.bionicReading));
  }

  // ── Open / close ───────────────────────────────────────────────
  SX.isPanelOpen = () => !!(panel && panel.classList.contains('s-visible'));

  SX.openPanel = function (opts) {
    SX.ensurePanel();
    const wasOpen = SX.isPanelOpen();
    panel.classList.add('s-visible');
    SX.onPanelToggle?.(true);
    if (!wasOpen && !(opts && opts.skipRefresh)) SX.loadHistory?.({ repaint: true });
    if (opts && opts.focus) setTimeout(() => el('.sxp-close')?.focus({ preventScroll: true }), 30);
  };

  SX.closePanel = function (opts) {
    if (!panel) return;
    panel.classList.remove('s-visible');
    SX.onPanelToggle?.(false);
    if (opts && opts.restoreFocus) document.getElementById('synapse-fab')?.focus({ preventScroll: true });
  };

  SX.togglePanel = function () {
    if (SX.isPanelOpen()) SX.closePanel({ restoreFocus: true });
    else SX.openPanel({ focus: true });
  };

  // ── Current explanation ────────────────────────────────────────
  function renderCurrent() {
    if (!panel) return;
    const section = el('.sxp-current');
    section.classList.toggle('synapse-hide', !current);
    if (!current) return;

    el('.sxp-kind').textContent = KIND_LABEL[current.kind] || 'Explain';
    el('.sxp-snippet').textContent = current.snippet || (current.kind === 'image' ? 'Circled area' : '');
    el('.sxp-loading').classList.toggle('synapse-hide', current.status !== 'loading');

    const err = el('.sxp-error');
    err.classList.toggle('synapse-hide', current.status !== 'error');
    err.textContent = current.status === 'error' ? current.error : '';

    const actions = el('.sxp-actions');
    actions.innerHTML = '';
    const acts = current.status === 'error' && Array.isArray(current.actions) ? current.actions : [];
    actions.classList.toggle('synapse-hide', !acts.length);
    for (const a of acts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sxp-action' + (a.secondary ? ' s-secondary' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => a.onClick());
      actions.appendChild(b);
    }

    const used = el('.sxp-ctx-used');
    const usedText = current.status === 'done' ? contextUsedLabel(current.contextUsed, current.contextNote) : '';
    used.textContent = usedText;
    used.classList.toggle('synapse-hide', !usedText);

    const body = el('.sxp-result');
    const done = current.status === 'done';
    body.classList.toggle('synapse-hide', !done);
    if (done) renderHTML(body, shownHtml(current));
    else body.innerHTML = '';
    renderVersions(done);
    renderTools(done);
  }

  function button(className, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ── Versions ───────────────────────────────────────────────────
  function renderVersions(done) {
    const bar = el('.sxp-versions');
    bar.innerHTML = '';
    const view = current;
    const versions = done && view.versions ? view.versions : [];
    bar.classList.toggle('synapse-hide', versions.length < 2);
    versions.forEach((v, i) => {
      const label = i === 0 ? 'Original' : `${i + 1} · ${MODE_LABEL[v.mode] || 'Re-explained'}`;
      const b = button('sxp-ver', label, () => {
        view.vi = i;
        renderCurrent();
        el(`.sxp-ver[data-i="${i}"]`)?.focus({ preventScroll: true });
      });
      b.dataset.i = String(i);
      b.setAttribute('aria-pressed', String((view.vi || 0) === i));
      if (v.request) b.title = v.request;
      bar.appendChild(b);
    });
  }

  // ── "Clearer" and re-explain ───────────────────────────────────
  // "Clearer" is the only rating: one per explanation, and it is what the
  // long-term loop learns from (with the re-explains that led to the version
  // the user accepted). Re-explain requests themselves only shape the next
  // version; they are never logged as feedback.
  function renderTools(done) {
    const tools = el('.sxp-tools');
    tools.innerHTML = '';
    tools.classList.toggle('synapse-hide', !done);
    if (!done) return;
    const view = current;

    const rate = document.createElement('div');
    rate.className = 'sxp-tools-row';
    if (feedbackGiven(view)) {
      const thanks = document.createElement('span');
      thanks.className = 'sxp-thanks';
      thanks.textContent = 'Thanks. Synapse will remember what worked for you.';
      rate.appendChild(thanks);
    } else {
      const clear = button('sxp-chip s-good sxp-clearer', '✓ Clearer', () => rateClearer(view));
      clear.title = 'This version made sense to me';
      rate.appendChild(clear);
    }
    tools.appendChild(rate);

    if (!view.request) return; // nothing to resend (e.g. an entry with no source text)

    const label = document.createElement('span');
    label.className = 'sxp-tools-label';
    label.textContent = 'Not quite? Re-explain it';
    label.title = `The first ${view.reexplainStatus?.free_limit || 10} re-explains each day are free.`;
    tools.appendChild(label);

    const row = document.createElement('div');
    row.className = 'sxp-tools-row';
    const simpler = button('sxp-chip sxp-redo-simpler', 'Simpler', () => reexplain(view, 'simpler'));
    const deeper = button('sxp-chip sxp-redo-detail', 'More detail', () => reexplain(view, 'more_detail'));
    const ask = button('sxp-chip sxp-redo-ask', 'Ask something specific', () => {
      view.askOpen = !view.askOpen;
      renderCurrent();
      if (view.askOpen) el('.sxp-ask-input')?.focus({ preventScroll: true });
    });
    ask.setAttribute('aria-expanded', String(!!view.askOpen));
    for (const b of [simpler, deeper, ask]) { b.disabled = !!view.redoing; row.appendChild(b); }
    tools.appendChild(row);

    if (view.askOpen) {
      const form = document.createElement('div');
      form.className = 'sxp-ask';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sxp-ask-input';
      input.maxLength = ASK_MAX;
      input.placeholder = 'e.g. use a cooking analogy';
      input.setAttribute('aria-label', 'What should the next explanation do differently?');
      input.value = view.askDraft || '';
      input.disabled = !!view.redoing;
      const send = button('sxp-action sxp-ask-send', 'Re-explain', () => submitAsk(view, input));
      send.disabled = !!view.redoing;
      input.addEventListener('input', () => { view.askDraft = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAsk(view, input); }
        if (e.key === 'Escape') {
          e.stopPropagation();
          view.askOpen = false;
          renderCurrent();
          el('.sxp-redo-ask')?.focus({ preventScroll: true });
        }
      });
      form.append(input, send);
      tools.appendChild(form);
    }

    if (view.redoing) {
      const busy = document.createElement('div');
      busy.className = 'sxp-redo';
      busy.setAttribute('role', 'status');
      busy.innerHTML = '<div class="sc-spinner"></div><span>Re-explaining…</span>';
      tools.appendChild(busy);
    }

    const noteText = view.redoError || reexplainNote(view);
    if (noteText) {
      const note = document.createElement('span');
      note.className = 'sxp-note' + (view.redoError ? ' s-error' : '');
      if (view.redoError) note.setAttribute('role', 'alert');
      note.textContent = noteText;
      tools.appendChild(note);
    }
  }

  function reexplainNote(view) {
    const parts = [];
    if (view.relookFellBack) parts.push('The circled image is only kept for an hour, so this used the text in the circle.');
    const status = view.reexplainStatus;
    if (status && !status.free) parts.push('Free re-explains are used up for today, so this one counted as a normal explain.');
    else if (status && status.free_remaining != null) {
      const n = status.free_remaining;
      parts.push(`${n} free re-explain${n === 1 ? '' : 's'} left today.`);
    }
    return parts.join(' ');
  }

  function submitAsk(view, input) {
    const text = String(input.value || '').trim().slice(0, ASK_MAX);
    if (!text) { input.focus({ preventScroll: true }); return; }
    reexplain(view, 'specific', text);
  }

  function rateClearer(view) {
    if (feedbackGiven(view)) return;
    // The re-explains that led to the version on screen, oldest first.
    const path = (view.versions || []).slice(1, (view.vi || 0) + 1).map(v => v.mode).filter(Boolean);
    SX.send({
      type: 'FEEDBACK',
      entry: {
        ts: Date.now(),
        reaction: 'clearer',
        note: '',
        timeSpentSeconds: view.shownAt ? Math.round((Date.now() - view.shownAt) / 1000) : null,
        readProgress: null,
        sessionDifficulty: S.sessionDifficulty,
        sectionTitle: 'Explain',
        reexplainPath: path
      }
    });
    markFeedbackGiven(view);
    if (current === view) renderCurrent();
  }

  /** Asks for another version of the explanation on screen. Counts only for that version. */
  async function reexplain(view, mode, requestText) {
    if (view.redoing || !view.request) return;
    const req = view.request;
    const previous = view.versions[view.vi || 0];
    view.redoing = true;
    view.redoError = '';
    if (mode === 'specific') view.askOpen = false;
    if (current === view) renderCurrent();

    const res = await SX.send({
      type: 'EXPLAIN',
      requestId: ++st.requestSeq,
      kind: view.kind,
      text: req.text || '',
      anchor: req.anchor || null,
      pageUrl: req.pageUrl || H.pageUrl(),
      pageTitle: req.pageTitle || H.pageTitle(),
      sessionDifficulty: S.sessionDifficulty,
      context: req.context || null,
      document: req.localOnly ? null : (req.document || null),
      localOnly: !!req.localOnly,
      reexplain: {
        mode,
        request: requestText || null,
        previousHtml: previous.html,
        entryId: view.entryId || null,
        entrySource: view.entrySource || null,
        relookId: view.relookId || view.entryId || null
      }
    });

    view.redoing = false;
    if (res && res.ok) {
      view.versions.push({ mode, request: requestText || null, html: res.html });
      view.vi = view.versions.length - 1;
      view.reexplainStatus = res.reexplain || view.reexplainStatus || null;
      view.relookFellBack = view.kind === 'image' && res.kind === 'text';
      view.askDraft = '';
      const entry = res.historyEntry || res.localEntry || null;
      if (entry) {
        // A paid entry deleted meanwhile comes back as a new entry; follow it.
        view.entryId = entry.id;
        view.entrySource = entry.source || view.entrySource;
        SX.upsertHistory(entry, { skipPaint: true });
      }
    } else {
      view.redoError = (res && res.error) || "Couldn't re-explain that. Try again.";
    }
    if (current === view) {
      renderCurrent();
      if (res && res.ok) el(`.sxp-ver[data-i="${view.vi}"]`)?.focus({ preventScroll: true });
    }
  }

  function contextUsedLabel(used, note) {
    if (used === 'document') return 'Explained with the whole document as context';
    if (used === 'page') return 'Explained with page context';
    if (used !== 'local') return '';
    if (note === 'document_unavailable') return "Document context wasn't available, so only nearby text was used";
    if (note === 'sensitive') return 'Page context is off on this site, so only nearby text was used';
    if (note === 'setting') return 'Page context is off, so only nearby text was used';
    if (note === 'fallback') return 'Explained without page context';
    return 'Explained with nearby text';
  }

  SX.showCurrent = function (view) {
    current = view;
    SX.ensurePanel();
    renderCurrent();
    el('.sxp-scroll').scrollTop = 0;
    if (view && view.status === 'error' && view.actions && view.actions.length) {
      setTimeout(() => el('.sxp-action')?.focus({ preventScroll: true }), 30);
    }
  };

  /** Shows a saved entry without any API call (e.g. clicking a green highlight). */
  SX.showEntry = function (entry) {
    if (!entry) return;
    const versions = versionsFrom(entry.result_html, entry.versions);
    SX.showCurrent({
      kind: entry.kind, snippet: snippetOf(entry.source_text || entry.page_title || ''),
      status: 'done', html: entry.result_html, entryId: entry.id,
      entrySource: entry.source || null,
      versions, vi: versions.length - 1,
      // The original page or document context isn't kept with history, so a
      // re-explain from history sends the source text (and the kept crop).
      request: entry.source_text || entry.kind === 'image'
        ? { text: entry.source_text || '', anchor: entry.anchor || null, pageUrl: entry.url || '', pageTitle: entry.page_title || '' }
        : null,
      relookId: entry.id,
      shownAt: Date.now()
    });
    SX.openPanel({ skipRefresh: true });
  };

  // ── Request flow ───────────────────────────────────────────────
  /**
   * Sends EXPLAIN and drives the panel. Never cancels: an older request that
   * finishes after a newer one still lands in history, it just doesn't take
   * over the "current" slot.
   *
   * payload: { kind?, text, anchor, captureId?, capture?, context?, document?, localOnly? }
   * opts: { snippet, onResult?(res, entry), onRetry?() }
   */
  SX.requestExplain = async function (payload, opts = {}) {
    const requestId = ++st.requestSeq;
    st.currentRequestId = requestId;
    const kind = payload.kind || (payload.capture || payload.captureId ? 'image' : 'text');

    SX.showCurrent({ kind, snippet: opts.snippet || '', status: 'loading' });
    SX.openPanel({ skipRefresh: true });

    const res = await SX.send({
      type: 'EXPLAIN',
      requestId,
      kind,
      text: payload.text || '',
      anchor: payload.anchor || null,
      pageUrl: H.pageUrl(),
      pageTitle: H.pageTitle(),
      sessionDifficulty: S.sessionDifficulty,
      context: payload.context || null,
      document: payload.localOnly ? null : (payload.document || null),
      localOnly: !!payload.localOnly,
      ...(payload.captureId ? { captureId: payload.captureId } : {}),
      ...(payload.capture ? { capture: payload.capture } : {})
    });

    if (res && res.ok && res.contextUsed === 'document') st.documentContextReady = true;
    const entry = res && res.ok ? (res.historyEntry || res.localEntry || null) : null;
    if (entry) SX.upsertHistory(entry, { skipPaint: true });
    opts.onResult?.(res, entry);

    if (requestId === st.currentRequestId) {
      if (res && res.ok) {
        SX.showCurrent({
          kind: res.kind || kind, snippet: opts.snippet || '', status: 'done',
          html: res.html, entryId: entry?.id, entrySource: entry?.source || null,
          contextUsed: res.contextUsed, contextNote: payload.localOnly ? 'fallback' : res.contextNote,
          versions: [{ mode: null, request: null, html: res.html }], vi: 0,
          // Kept so a re-explain sends the same source and context again.
          request: {
            text: payload.text || '', anchor: payload.anchor || null,
            context: payload.context || null, document: payload.localOnly ? null : (payload.document || null),
            localOnly: !!payload.localOnly, pageUrl: H.pageUrl(), pageTitle: H.pageTitle()
          },
          relookId: res.relookId || null,
          shownAt: Date.now()
        });
      } else {
        SX.showCurrent({
          kind, snippet: opts.snippet || '', status: 'error',
          error: (res && res.error) || 'Something went wrong. Try again.',
          actions: errorActions(res, payload, opts)
        });
      }
    }
    return { res, entry };
  };

  function errorActions(res, payload, opts) {
    const code = res && res.code;
    // Offered once: the local-only resend can itself hit a plain 429, whose
    // message is shown as-is with no second fallback.
    if (code === 'QUOTA_INSUFFICIENT_FOR_CONTEXT' && !payload.localOnly) {
      return [{
        label: 'Explain without page context',
        onClick: () => SX.requestExplain({
          ...payload,
          context: CX ? CX.localOnly(payload.context) : null,
          document: null,
          localOnly: true
        }, opts)
      }];
    }
    if (code === 'CAPTURE_EXPIRED' && opts.onRetry) {
      return [{ label: 'Retry', onClick: () => opts.onRetry() }];
    }
    return [];
  }

  // ── History ────────────────────────────────────────────────────
  function sameSite(entry) {
    return entry && (entry.hostname || G.hostnameOf(entry.url)) === st.hostname;
  }

  function sortHistory() {
    st.history.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  SX.setHistory = function (entries, source) {
    st.history = (entries || []).filter(sameSite);
    st.historySource = source || 'local';
    sortHistory();
    renderHistory();
    SX.onHistoryChanged?.();
  };

  SX.upsertHistory = function (entry, opts) {
    if (!sameSite(entry)) return;
    const i = st.history.findIndex(e => e.id === entry.id);
    if (i >= 0) st.history[i] = { ...st.history[i], ...entry };
    else st.history.push(entry);
    sortHistory();
    renderHistory();
    SX.onHistoryChanged?.();
    if (!(opts && opts.skipPaint)) SX.paintEntry?.(entry);
  };

  function isOnThisPage(entry) {
    return G.pageKey(entry.url) === st.pageKey;
  }

  function renderHistory() {
    if (!panel) return;
    const list = el('.sxp-list');
    const empty = el('.sxp-empty');
    list.innerHTML = '';
    const entries = st.history;

    if (!entries.length) {
      empty.classList.remove('synapse-hide');
      empty.innerHTML = 'Select text and press the Synapse bubble, or hold <kbd>Alt</kbd>+<kbd>S</kbd> and trace around anything to get an explanation. Your explanations for this site appear here.';
    } else {
      empty.classList.add('synapse-hide');
    }
    renderClearControl(entries.length);

    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'sxp-item';
      li.dataset.id = entry.id;
      const open = expanded.has(entry.id);
      li.classList.toggle('s-open', open);

      const row = document.createElement('div');
      row.className = 'sxp-item-row';

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'sxp-item-main';
      const onPage = isOnThisPage(entry);
      main.setAttribute('aria-expanded', String(open));
      main.title = onPage ? 'Show explanation and jump to the source' : `Open ${entry.page_title || entry.url}`;

      const thumb = document.createElement('span');
      thumb.className = 'sxp-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      if (entry.kind === 'image' && entry.thumbnail_url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = entry.thumbnail_url;
        img.addEventListener('error', () => { img.remove(); thumb.textContent = ICON_IMAGE; });
        thumb.appendChild(img);
      } else {
        thumb.textContent = entry.kind === 'image' ? ICON_IMAGE : ICON_TEXT;
      }

      const textWrap = document.createElement('span');
      textWrap.className = 'sxp-item-text';
      const snip = document.createElement('span');
      snip.className = 'sxp-item-snippet';
      snip.textContent = snippetOf(entry.source_text) || (entry.kind === 'image' ? 'Circled area' : 'Explanation');
      const meta = document.createElement('span');
      meta.className = 'sxp-item-meta';
      const versionCount = 1 + (Array.isArray(entry.versions) ? entry.versions.length : 0);
      const bits = [KIND_LABEL[entry.kind] || 'Text', G.relativeTime(entry.created_at)];
      if (versionCount > 1) bits.push(`${versionCount} versions`);
      if (!onPage) bits.push(`on ${entry.page_title ? G.truncate(entry.page_title, 40) : 'another page'} ↗`);
      meta.textContent = bits.filter(Boolean).join(' · ');
      textWrap.append(snip, meta);
      main.append(thumb, textWrap);
      main.addEventListener('click', () => onItemClick(entry));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sxp-item-del';
      del.setAttribute('aria-label', 'Delete this explanation');
      del.title = 'Delete';
      del.textContent = '✕';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteEntry(entry); });

      row.append(main, del);
      li.appendChild(row);

      if (open) {
        const body = document.createElement('div');
        body.className = 'sc-body s-ready sxp-item-body';
        renderHTML(body, latestHtml(entry));
        li.appendChild(body);
      }
      list.appendChild(li);
    }
  }

  function renderClearControl(count) {
    const wrap = el('.sxp-clear-wrap');
    wrap.innerHTML = '';
    if (!count) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sxp-link';
    btn.textContent = 'Clear this site';
    btn.addEventListener('click', () => {
      wrap.innerHTML = '';
      const row = document.createElement('span');
      row.className = 'sxp-confirm-row';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'sxp-link s-confirm';
      yes.textContent = `Delete ${count}`;
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'sxp-link';
      no.textContent = 'Cancel';
      yes.addEventListener('click', clearSite);
      no.addEventListener('click', () => renderClearControl(st.history.length));
      row.append(no, yes);
      wrap.appendChild(row);
      no.focus({ preventScroll: true });
    });
    wrap.appendChild(btn);
  }

  async function deleteEntry(entry) {
    const res = await SX.send({ type: 'DELETE_EXPLAIN_HISTORY', id: entry.id, source: entry.source });
    if (!res.ok) { showInlineError(res.error || 'Could not delete that entry.'); return; }
    st.history = st.history.filter(e => e.id !== entry.id);
    expanded.delete(entry.id);
    SX.removeHighlight(entry.id);
    if (current && current.entryId === entry.id) current = null;
    renderCurrent();
    renderHistory();
    SX.onHistoryChanged?.();
  }

  async function clearSite() {
    const res = await SX.send({ type: 'DELETE_EXPLAIN_HISTORY', hostname: st.hostname });
    if (!res.ok) { showInlineError(res.error || 'Could not clear this site.'); }
    st.history = [];
    expanded.clear();
    SX.clearHighlights();
    current = null;
    renderCurrent();
    renderHistory();
    SX.onHistoryChanged?.();
  }

  function showInlineError(message) {
    SX.showCurrent({ kind: current?.kind || 'text', snippet: '', status: 'error', error: message });
  }

  function onItemClick(entry) {
    if (!isOnThisPage(entry)) {
      if (entry.url && /^https?:/i.test(entry.url)) location.assign(entry.url);
      // Local files open through the background: the viewer (an extension
      // page) can't navigate to file://, and local PDFs belong in the viewer.
      else if (entry.url && /^file:/i.test(entry.url)) {
        SX.send({ type: 'OPEN_LOCAL_FILE', url: entry.url }).then((res) => {
          if (!res || !res.ok) SX.showTip((res && res.error) || "Couldn't open that file.", { message: true, duration: 3200 });
        });
      }
      return;
    }
    const opening = !expanded.has(entry.id);
    if (opening) expanded.add(entry.id); else expanded.delete(entry.id);
    renderHistory();
    if (opening) {
      const source = SX.resolveEntrySource(entry);
      if (source) SX.revealSource(source);
      panel.querySelector(`.sxp-item[data-id="${CSS.escape(entry.id)}"] .sxp-item-main`)?.focus({ preventScroll: true });
    }
  }

  SX.findEntry = (id) => st.history.find(e => e.id === id) || null;
})();
