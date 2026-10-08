// ================================================================
// SYNAPSE PDF VIEWER — rendering (ES module)
// A small continuous-scroll viewer on pdf.js's core API: pages are laid out
// as placeholders, canvases render lazily (and are released far from the
// viewport), and every page gets a real pdf.js TextLayer so native selection,
// Ctrl+F, highlight-to-explain and green highlights work.
//
// The DOCUMENT (window) scrolls, not an inner container. The explain scripts
// measure geometry against the window (circle outline, confirm bar, emphasis,
// return-to-source), so they work here unchanged.
// Synapse wiring lives in viewer-init.js (globalThis.SynapseViewerHost).
// ================================================================
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const host = globalThis.SynapseViewerHost || {};
const fileUrl = host.fileUrl || null;

const PDF_TO_CSS = 96 / 72;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const AUTO_MAX_SCALE = 1.25;      // "fit width" never upscales past this on open
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const PAGE_GAP = 16;
const SIDE_MARGIN = 24;
const MAX_CANVAS_PIXELS = 16_777_216; // 4096²; HiDPI is capped per page beyond this
const EAGER_TEXT_PAGES = 400;     // text layers for the whole doc (find, highlights, return-to-source)
const RENDER_MARGIN = '150% 0px'; // render this far beyond the viewport

const $ = (id) => document.getElementById(id);
const els = {
  title: $('docTitle'), pageNumber: $('pageNumber'), pageCount: $('pageCount'),
  zoomOut: $('zoomOut'), zoomIn: $('zoomIn'), zoomLevel: $('zoomLevel'), fitWidth: $('fitWidth'),
  openOriginal: $('openOriginal'), viewer: $('viewer'), loading: $('loading'), loadingText: $('loadingText'),
  passwordForm: $('passwordForm'), passwordInput: $('passwordInput'), passwordError: $('passwordError'),
  passwordCancel: $('passwordCancel'), errorBox: $('errorBox'), errorTitle: $('errorTitle'), errorText: $('errorText'),
  fileAccessSteps: $('fileAccessSteps'), openExtSettings: $('openExtSettings'), retryLoad: $('retryLoad'),
  errorOpenOriginal: $('errorOpenOriginal'), docNote: $('docNote'), docNoteText: $('docNoteText'), toolbar: $('toolbar')
};

const state = {
  pdf: null,
  worker: null,       // pdfjsLib.PDFWorker, owned here (see startWorker)
  pages: [],          // PageView[]
  scale: 1,           // user scale (1 = 100%)
  zoomMode: 'auto',   // 'auto' | 'fit' | 'custom'
  baseWidth: 612,     // page 1 width in PDF units (for fit width)
  currentPage: 1,
  observer: null,
  renderQueue: new Set(),
  rendering: false,
  textQueue: [],
  textPumping: false,
  textPagesDone: 0,
  pagesWithText: 0,
  destroyed: false
};

// ── Errors, loading, password ───────────────────────────────────
function setOriginalLinks() {
  for (const a of [els.openOriginal, els.errorOpenOriginal]) {
    if (!a) continue;
    if (fileUrl) {
      a.href = fileUrl;
      a.removeAttribute('aria-disabled');
    } else {
      a.removeAttribute('href');
      a.setAttribute('aria-disabled', 'true');
      a.hidden = a === els.errorOpenOriginal;
    }
  }
  // Extension pages can't navigate to file:// with a plain link click.
  for (const a of [els.openOriginal, els.errorOpenOriginal]) {
    a?.addEventListener('click', (e) => {
      if (!fileUrl) { e.preventDefault(); return; }
      if (fileUrl.startsWith('file:') && chrome?.tabs?.update) {
        e.preventDefault();
        chrome.tabs.update({ url: fileUrl });
      }
    });
  }
}

function showLoading(text) {
  els.loading.hidden = false;
  els.loadingText.textContent = text;
}

function hideLoading() {
  els.loading.hidden = true;
}

function showError(title, text, opts = {}) {
  hideLoading();
  els.passwordForm.hidden = true;
  els.errorTitle.textContent = title;
  els.errorText.textContent = text;
  els.fileAccessSteps.hidden = !opts.fileAccess;
  els.openExtSettings.hidden = !opts.fileAccess;
  els.retryLoad.hidden = !opts.retry;
  els.errorBox.hidden = false;
  els.title.textContent = host.fileName || 'PDF';
  document.title = `${host.fileName || 'PDF'} – Synapse`;
  (opts.fileAccess ? els.openExtSettings : els.errorOpenOriginal)?.focus?.({ preventScroll: true });
}

els.openExtSettings?.addEventListener('click', () => {
  try { chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); } catch (_) { /* ignore */ }
});
els.retryLoad?.addEventListener('click', () => location.reload());

function askPassword(updatePassword, reason) {
  hideLoading();
  els.errorBox.hidden = true;
  els.passwordForm.hidden = false;
  const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
  els.passwordError.textContent = incorrect ? 'That password is not right. Try again.' : '';
  els.passwordInput.setAttribute('aria-invalid', String(incorrect));
  els.passwordInput.value = '';
  els.passwordInput.focus();

  els.passwordForm.onsubmit = (e) => {
    e.preventDefault();
    const pw = els.passwordInput.value;
    if (!pw) {
      els.passwordError.textContent = 'Enter the password.';
      els.passwordInput.setAttribute('aria-invalid', 'true');
      els.passwordInput.focus();
      return;
    }
    els.passwordForm.hidden = true;
    showLoading('Unlocking PDF…');
    updatePassword(pw);
  };
  els.passwordCancel.onclick = () => {
    els.passwordForm.hidden = true;
    showError('This PDF is password protected', 'Synapse needs the password to show it. You can still open the original.', { retry: true });
  };
}

// ── Fetching ────────────────────────────────────────────────────
function isFileAccessAllowed() {
  return new Promise((resolve) => {
    try { chrome.extension.isAllowedFileSchemeAccess((ok) => resolve(!!ok)); } catch (_) { resolve(true); }
  });
}

class LoadError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/** file:// needs XHR: Chrome's fetch() rejects the file scheme, even on extension pages. */
function readLocalFile(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response && (xhr.status === 0 || xhr.status === 200))
      ? resolve(new Uint8Array(xhr.response))
      : reject(new LoadError('file-missing', 'File not found.'));
    xhr.onerror = () => reject(new LoadError('file-missing', 'File could not be read.'));
    xhr.send();
  });
}

async function fetchPdf(url) {
  if (url.startsWith('file:')) {
    if (!(await isFileAccessAllowed())) throw new LoadError('file-access', 'File access is off.');
    return readLocalFile(url);
  }
  let res;
  try {
    // Extension pages fetch cross-origin with the extension's host permissions.
    res = await fetch(url, { credentials: 'include' });
  } catch (_) {
    throw new LoadError('network', 'Network error.');
  }
  if (!res.ok) throw new LoadError('http', `HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── PDF engine (pdf.js worker) ──────────────────────────────────
// pdf.js waits for its worker's handshake with no timeout: a worker that
// neither starts nor fires `error` leaves getDocument() pending forever, and the
// viewer on its spinner. So the worker is started here, given a deadline, and
// retried once on a fresh worker before giving up with an error.
const WORKER_START_TIMEOUT_MS = 8000;
const WORKER_START_ATTEMPTS = 2;

async function startWorker() {
  for (let attempt = 1; ; attempt++) {
    const worker = new pdfjsLib.PDFWorker();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LoadError('worker', 'The PDF engine did not start.')), WORKER_START_TIMEOUT_MS);
    });
    try {
      await Promise.race([worker.promise, deadline]);
      if (state.destroyed) { worker.destroy(); throw new LoadError('worker', 'Viewer closed.'); }
      return worker;
    } catch (err) {
      worker.destroy();
      if (state.destroyed || attempt >= WORKER_START_ATTEMPTS) {
        throw err instanceof LoadError ? err : new LoadError('worker', String(err?.message || err));
      }
      console.warn('Synapse viewer: PDF engine did not start, retrying', err?.message || err);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Page views ──────────────────────────────────────────────────
class PageView {
  constructor(index, width, height) {
    this.index = index;          // 0-based
    this.number = index + 1;
    this.width = width;          // PDF units at scale 1, rotation applied
    this.height = height;
    this.pdfPage = null;
    this.canvas = null;
    this.renderTask = null;
    this.renderedScale = 0;      // CSS scale the canvas was rendered at (0 = none)
    this.textLayer = null;
    this.textState = 'none';     // 'none' | 'pending' | 'done' | 'error'
    this.hasText = null;
    this.visible = false;

    const div = this.div = document.createElement('div');
    div.className = 'vw-page';
    div.dataset.pageNumber = String(this.number);
    div.setAttribute('role', 'region');
    div.setAttribute('aria-label', `Page ${this.number} of ${state.pdf.numPages}`);
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'vw-canvas';
    this.wrapper.setAttribute('aria-hidden', 'true');
    this.textDiv = document.createElement('div');
    this.textDiv.className = 'textLayer';
    div.append(this.wrapper, this.textDiv);
    this.textDiv.addEventListener('mousedown', () => this.textDiv.classList.add('selecting'));
    this.applySize();
  }

  async page() {
    if (!this.pdfPage) this.pdfPage = await state.pdf.getPage(this.number);
    return this.pdfPage;
  }

  viewport(scale = state.scale) {
    return this.pdfPage.getViewport({ scale: scale * PDF_TO_CSS });
  }

  applySize() {
    const s = state.scale * PDF_TO_CSS;
    this.div.style.width = `${Math.floor(this.width * s)}px`;
    this.div.style.height = `${Math.floor(this.height * s)}px`;
    this.div.style.setProperty('--scale-factor', String(s));
  }

  /** Real size once the page object is known (placeholders start at page 1's size). */
  setNaturalSize(w, h) {
    if (Math.abs(w - this.width) < 0.5 && Math.abs(h - this.height) < 0.5) return false;
    this.width = w;
    this.height = h;
    this.applySize();
    return true;
  }

  needsCanvas() {
    return this.renderedScale !== state.scale || !this.canvas;
  }

  async renderCanvas() {
    const page = await this.page();
    if (state.destroyed) return;
    const scale = state.scale;
    const viewport = this.viewport(scale);
    const out = new pdfjsLib.OutputScale();
    out.limitCanvas(viewport.width, viewport.height, MAX_CANVAS_PIXELS, -1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * out.sx));
    canvas.height = Math.max(1, Math.floor(viewport.height * out.sy));
    const ctx = canvas.getContext('2d', { alpha: false });
    this.renderTask?.cancel();
    const task = this.renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: out.scaled ? [out.sx, 0, 0, out.sy, 0, 0] : null
    });
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }
    // Swap in the new bitmap only when it's complete (no blank flash on zoom).
    this.wrapper.replaceChildren(canvas);
    this.canvas = canvas;
    this.renderedScale = scale;
  }

  releaseCanvas() {
    this.renderTask?.cancel();
    this.renderTask = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.renderedScale = 0;
  }

  async renderText() {
    if (this.textState !== 'none') return;
    this.textState = 'pending';
    try {
      const page = await this.page();
      if (state.destroyed) return;
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: this.textDiv,
        viewport: this.viewport()
      });
      this.textLayer = textLayer;
      await textLayer.render();
      const end = document.createElement('div');
      end.className = 'endOfContent';
      this.textDiv.append(end);
      this.hasText = textLayer.textContentItemsStr.some(s => s && s.trim());
      this.textState = 'done';
      onTextLayerDone(this);
    } catch (err) {
      this.textState = 'error';
      this.hasText = false;
      onTextLayerDone(this);
    }
  }

  updateTextLayer() {
    if (this.textLayer && this.textState === 'done') this.textLayer.update({ viewport: this.viewport() });
  }
}

// ── Text layers: eager in the background, visible pages first ────
function onTextLayerDone(pv) {
  state.textPagesDone++;
  if (pv.hasText) state.pagesWithText++;
  pv.div.classList.toggle('s-no-text', !pv.hasText);
  if (!pv.hasText) pv.div.setAttribute('aria-label', `Page ${pv.number} of ${state.pdf.numPages}, no selectable text`);
  host.textLayerRendered?.(pv.number);
  updateDocNote();
}

let docNoteDismissed = false;
$('docNoteClose')?.addEventListener('click', () => { docNoteDismissed = true; els.docNote.hidden = true; });

function updateDocNote() {
  if (docNoteDismissed) return;
  const total = Math.min(state.pages.length, EAGER_TEXT_PAGES);
  if (state.textPagesDone < total) return;
  if (state.pagesWithText === 0) {
    els.docNoteText.textContent = 'This PDF has no selectable text (it may be scanned). Use Circle to explain any part of it.';
    els.docNote.hidden = false;
  } else if (state.pagesWithText < total) {
    els.docNoteText.textContent = "Some pages have no selectable text. They're marked; use Circle to explain them.";
    els.docNote.hidden = false;
  }
}

function queueText(pv, front = false) {
  if (pv.textState !== 'none') return;
  if (front) state.textQueue.unshift(pv); else state.textQueue.push(pv);
  pumpText();
}

async function pumpText() {
  if (state.textPumping) return;
  state.textPumping = true;
  try {
    while (state.textQueue.length && !state.destroyed) {
      const pv = state.textQueue.shift();
      if (pv.textState !== 'none') continue;
      await pv.renderText();
      // Yield between pages so scrolling stays smooth on long documents.
      await new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 200 }) : setTimeout(r, 16)));
    }
  } finally {
    state.textPumping = false;
  }
}

// ── Canvas rendering: nearest visible page first ─────────────────
function scheduleRender() {
  for (const pv of state.pages) if (pv.visible && pv.needsCanvas()) state.renderQueue.add(pv);
  pumpRender();
}

function viewportCenterDistance(pv) {
  const r = pv.div.getBoundingClientRect();
  const mid = window.innerHeight / 2;
  return Math.abs((r.top + r.bottom) / 2 - mid);
}

async function pumpRender() {
  if (state.rendering) return;
  state.rendering = true;
  try {
    while (state.renderQueue.size && !state.destroyed) {
      const next = Array.from(state.renderQueue).sort((a, b) => viewportCenterDistance(a) - viewportCenterDistance(b))[0];
      state.renderQueue.delete(next);
      if (!next.visible || !next.needsCanvas()) continue;
      queueText(next, true);
      try {
        await next.renderCanvas();
      } catch (err) {
        console.warn('Synapse viewer: page render failed', next.number, err);
      }
    }
  } finally {
    state.rendering = false;
  }
}

function onIntersect(entries) {
  for (const e of entries) {
    const pv = state.pages[Number(e.target.dataset.pageNumber) - 1];
    if (!pv) continue;
    pv.visible = e.isIntersecting;
    if (!pv.visible) {
      state.renderQueue.delete(pv);
      pv.releaseCanvas();
    }
  }
  scheduleRender();
}

// ── Layout, zoom, page tracking ─────────────────────────────────
function availableWidth() {
  return Math.max(200, document.documentElement.clientWidth - SIDE_MARGIN * 2);
}

function fitWidthScale() {
  return clampScale(availableWidth() / (state.baseWidth * PDF_TO_CSS));
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function toolbarHeight() {
  return els.toolbar ? els.toolbar.getBoundingClientRect().height : 0;
}

/** { page, fraction } at the top of the visible area, to keep it in place across zoom. */
function readingPosition() {
  const top = toolbarHeight();
  for (const pv of state.pages) {
    const r = pv.div.getBoundingClientRect();
    if (r.bottom > top) return { pv, fraction: Math.max(0, (top - r.top) / r.height) };
  }
  return null;
}

function restoreReadingPosition(pos) {
  if (!pos) return;
  const r = pos.pv.div.getBoundingClientRect();
  const y = window.scrollY + r.top + pos.fraction * r.height - toolbarHeight();
  window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
}

function setScale(scale, mode) {
  const next = clampScale(scale);
  state.zoomMode = mode;
  els.fitWidth.setAttribute('aria-pressed', String(mode !== 'custom'));
  updateZoomControls(next);
  if (Math.abs(next - state.scale) < 0.001) return;
  const pos = readingPosition();
  state.scale = next;
  host.layoutChanged?.();
  for (const pv of state.pages) {
    pv.applySize();
    pv.updateTextLayer();
  }
  restoreReadingPosition(pos);
  scheduleRender();
}

function updateZoomControls(scale = state.scale) {
  els.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
  els.zoomOut.disabled = scale <= MIN_SCALE + 0.001;
  els.zoomIn.disabled = scale >= MAX_SCALE - 0.001;
}

function zoomStep(dir) {
  const cur = state.scale;
  let next;
  if (dir > 0) next = ZOOM_STEPS.find(z => z > cur + 0.001) ?? MAX_SCALE;
  else next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.001) ?? MIN_SCALE;
  setScale(next, 'custom');
}

function applyAutoScale() {
  if (state.zoomMode === 'auto') setScale(Math.min(AUTO_MAX_SCALE, fitWidthScale()), 'auto');
  else if (state.zoomMode === 'fit') setScale(fitWidthScale(), 'fit');
}

let pageTrackQueued = false;
function trackCurrentPage() {
  if (pageTrackQueued) return;
  pageTrackQueued = true;
  requestAnimationFrame(() => {
    pageTrackQueued = false;
    const probe = toolbarHeight() + (window.innerHeight - toolbarHeight()) / 3;
    let current = state.currentPage;
    for (const pv of state.pages) {
      const r = pv.div.getBoundingClientRect();
      if (r.top <= probe && r.bottom + PAGE_GAP >= probe) { current = pv.number; break; }
      if (r.top > probe) break;
    }
    if (current !== state.currentPage) {
      state.currentPage = current;
      if (document.activeElement !== els.pageNumber) els.pageNumber.value = String(current);
    }
  });
}

function scrollToPage(n) {
  const pv = state.pages[Math.min(Math.max(1, n), state.pages.length) - 1];
  if (!pv) return;
  const y = window.scrollY + pv.div.getBoundingClientRect().top - toolbarHeight() - 8;
  window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
  state.currentPage = pv.number;
  els.pageNumber.value = String(pv.number);
}

// ── Toolbar ─────────────────────────────────────────────────────
function enableToolbar() {
  els.pageNumber.disabled = false;
  els.pageNumber.max = String(state.pages.length);
  els.pageCount.textContent = `of ${state.pages.length}`;
  els.zoomIn.disabled = false;
  els.zoomOut.disabled = false;
  els.fitWidth.disabled = false;
  updateZoomControls();

  els.pageNumber.addEventListener('change', () => {
    const n = parseInt(els.pageNumber.value, 10);
    if (Number.isFinite(n)) scrollToPage(n); else els.pageNumber.value = String(state.currentPage);
  });
  els.pageNumber.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.pageNumber.dispatchEvent(new Event('change')); els.pageNumber.select(); }
    if (e.key === 'Escape') { els.pageNumber.value = String(state.currentPage); els.pageNumber.blur(); }
  });
  els.pageNumber.addEventListener('focus', () => els.pageNumber.select());
  els.zoomIn.addEventListener('click', () => zoomStep(1));
  els.zoomOut.addEventListener('click', () => zoomStep(-1));
  els.fitWidth.addEventListener('click', () => setScale(fitWidthScale(), 'fit'));

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomStep(1); }
    else if (e.key === '-') { e.preventDefault(); zoomStep(-1); }
    else if (e.key === '0') { e.preventDefault(); setScale(fitWidthScale(), 'fit'); }
  });
  window.addEventListener('scroll', trackCurrentPage, { passive: true });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { applyAutoScale(); trackCurrentPage(); }, 120);
  });
  // Text selection: pdf.js's "selecting" class stops the selection jumping.
  document.addEventListener('mouseup', () => {
    for (const d of els.viewer.querySelectorAll('.textLayer.selecting')) d.classList.remove('selecting');
  });
}

// ── Open ────────────────────────────────────────────────────────
async function documentTitle(pdf) {
  try {
    const { info, metadata } = await pdf.getMetadata();
    const t = (metadata && metadata.get && metadata.get('dc:title')) || (info && info.Title) || '';
    if (t && String(t).trim()) return String(t).trim();
  } catch (_) { /* fall back to the file name */ }
  return host.fileName || 'PDF';
}

function initialPageFromHash(url) {
  const m = /#(?:.*&)?page=(\d+)/i.exec(url || '');
  return m ? parseInt(m[1], 10) : 1;
}

async function buildPages(pdf) {
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  state.baseWidth = vp1.width;
  state.scale = Math.min(AUTO_MAX_SCALE, fitWidthScale());
  const frag = document.createDocumentFragment();
  for (let i = 0; i < pdf.numPages; i++) {
    const pv = new PageView(i, vp1.width, vp1.height);
    if (i === 0) pv.pdfPage = first;
    state.pages.push(pv);
    frag.append(pv.div);
  }
  els.viewer.append(frag);
  state.observer = new IntersectionObserver(onIntersect, { rootMargin: RENDER_MARGIN });
  for (const pv of state.pages) state.observer.observe(pv.div);

  // Correct placeholder sizes for pages that differ from page 1 (in the background).
  (async () => {
    for (const pv of state.pages) {
      if (state.destroyed) return;
      if (pv.index === 0) continue;
      try {
        const page = await pv.page();
        const vp = page.getViewport({ scale: 1 });
        if (pv.setNaturalSize(vp.width, vp.height)) scheduleRender();
      } catch (_) { /* keep the placeholder size */ }
      if (pv.index % 20 === 0) await new Promise(r => setTimeout(r, 0));
    }
  })();

  // Text layers for the whole document (capped), after the first paint.
  setTimeout(() => {
    for (const pv of state.pages.slice(0, EAGER_TEXT_PAGES)) queueText(pv);
  }, 300);
}

function trackToolbarHeight() {
  if (!els.toolbar || typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--toolbar-h', `${Math.ceil(els.toolbar.getBoundingClientRect().height)}px`);
  }).observe(els.toolbar);
}

async function open() {
  trackToolbarHeight();
  setOriginalLinks();
  if (!fileUrl) {
    const raw = new URLSearchParams(location.search).get('file');
    showError(
      raw ? "Synapse can't open this address" : 'No PDF to show',
      raw ? 'Only web (http, https) and local file PDFs can be opened in the Synapse viewer.'
        : 'Open a PDF on the web and choose "Open in Synapse viewer" from the Synapse button.'
    );
    return;
  }
  els.title.textContent = host.fileName || 'PDF';
  showLoading('Downloading PDF…');

  // The worker boots while the PDF downloads.
  const workerReady = startWorker();
  workerReady.catch(() => {}); // handled below; a failed download must not leave it unhandled

  let data;
  try {
    data = await fetchPdf(fileUrl);
  } catch (err) {
    workerReady.then(w => w.destroy(), () => {});
    if (err.kind === 'file-access') {
      showError(
        'Synapse needs access to local files',
        'To open PDFs saved on this computer, Chrome must allow Synapse to read file URLs.',
        { fileAccess: true }
      );
    } else if (err.kind === 'file-missing') {
      showError("Couldn't read this file", 'It may have been moved, renamed or deleted.', { retry: true });
    } else if (err.kind === 'http') {
      showError("Couldn't download this PDF", `The server answered with ${err.message}. It may have moved or need you to sign in.`, { retry: true });
    } else {
      showError("Couldn't download this PDF", 'Check your connection, or open the original instead.', { retry: true });
    }
    return;
  }

  // Local files: the service worker can't read file://, so the reader and
  // document context get the bytes from here. Copied first, because pdf.js
  // transfers `data` to its worker.
  if (fileUrl.startsWith('file:')) host.setLocalBytes?.(data.slice());

  showLoading('Opening PDF…');
  try {
    state.worker = await workerReady;
  } catch (err) {
    if (state.destroyed) return;
    showError("Couldn't open this PDF", "Synapse's PDF reader didn't start. Reload to try again, or open the original.", { retry: true });
    return;
  }
  const task = pdfjsLib.getDocument({
    data,
    worker: state.worker,
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/',
    iccUrl: VENDOR + 'iccs/',
    enableXfa: false
  });
  task.onPassword = askPassword;

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    const name = err && err.name;
    if (name === 'InvalidPDFException') showError("This file isn't a readable PDF", 'It may be damaged or not a PDF at all.');
    else if (name === 'PasswordException') showError('This PDF is password protected', 'Synapse needs the password to show it.', { retry: true });
    else showError("Couldn't open this PDF", 'Something went wrong while reading it. You can still open the original.', { retry: true });
    return;
  }

  state.pdf = pdf;
  els.passwordForm.hidden = true;
  hideLoading();
  await buildPages(pdf);
  enableToolbar();
  document.body.classList.add('s-ready');

  const title = await documentTitle(pdf);
  els.title.textContent = title;
  els.title.title = title;
  document.title = `${title} – Synapse`;
  host.setTitle?.(title);
  host.documentReady?.();

  const start = initialPageFromHash(fileUrl);
  if (start > 1) scrollToPage(start);
  trackCurrentPage();
}

window.addEventListener('pagehide', () => {
  state.destroyed = true;
  state.pdf?.loadingTask?.destroy?.();
  // A worker passed to getDocument() is not destroyed with the loading task.
  state.worker?.destroy();
});

// Test/debug handle (read-only snapshot, no PDF content).
globalThis.SynapseViewer = {
  get pageCount() { return state.pages.length; },
  get scale() { return state.scale; },
  get currentPage() { return state.currentPage; },
  textLayersDone: () => state.textPagesDone,
  pagesWithoutText: () => state.pages.filter(p => p.hasText === false).map(p => p.number),
  scrollToPage
};

open();
