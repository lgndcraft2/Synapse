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
  //   actions?: [{ label, onClick, secondary? }], contextUsed?, contextNote? }
  let current = null;
  const expanded = new Set();

  // History entries the user already rated. One opinion per explanation, so
  // the feedback strip stays gone when the entry is reopened or re-rendered.
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
          <div class="sc-body s-ready sxp-result synapse-hide"></div>
          <span class="sxp-ctx-used synapse-hide"></span>
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
    section.querySelector('.sc-feedback')?.remove();
    if (done) {
      renderHTML(body, current.html);
      // The existing feedback strip feeds the same learning loop as section cards.
      if (!feedbackGiven(current)) {
        const view = current;
        H.feedbackStrip(section, {
          title: 'Explain', readProgress: null, onFeedback: () => markFeedbackGiven(view)
        });
      }
    } else {
      body.innerHTML = '';
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
    SX.showCurrent({
      kind: entry.kind, snippet: snippetOf(entry.source_text || entry.page_title || ''),
      status: 'done', html: entry.result_html, entryId: entry.id
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
          html: res.html, entryId: entry?.id,
          contextUsed: res.contextUsed, contextNote: payload.localOnly ? 'fallback' : res.contextNote
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
      const bits = [KIND_LABEL[entry.kind] || 'Text', G.relativeTime(entry.created_at)];
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
        renderHTML(body, entry.result_html);
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
