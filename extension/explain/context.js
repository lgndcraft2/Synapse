// ================================================================
// SYNAPSE EXPLAIN — context collection (docs/explain-api.md "Context")
//
// Local context (always): heading path, the text around the selection, and
// metadata for an interactive target (button, link, field...).
// Page context (when allowed): title, site name, description, outline, and
// a slice of the main content centred on the selection.
//
// The top half is pure (no DOM) and is also loaded by the background worker
// (importScripts) and by Node unit tests. The DOM half attaches to
// SynapseExplain only when loaded as a page script after core.js.
// ================================================================
(function (root) {
  'use strict';

  // ── Limits (mirror the backend caps in docs/explain-api.md) ────
  const LIMITS = {
    headingItems: 8, headingChars: 200,
    surrounding: 2000,
    elementChars: 300, formFields: 20,
    outlineItems: 40, outlineChars: 200,
    mainText: 8000,
    // Backend rejects serialized context over 24 KB; stay clearly below.
    maxBytes: 22 * 1024
  };

  function clean(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return n && t.length > n ? t.slice(0, n).trimEnd() : t;
  }

  function cleanOrNull(s, n) {
    const t = clean(s, n);
    return t ? t : null;
  }

  /**
   * A window of at most `max` chars of `text` centred on [start, end).
   * Edges are nudged to word boundaries when that costs little. A focus
   * longer than `max` starts at the focus. Returns { text, offset } where
   * offset is the slice's start in the original text.
   */
  function centerSlice(text, start, end, max) {
    text = String(text || '');
    if (text.length <= max) return { text, offset: 0 };
    let s = Number.isFinite(start) ? Math.max(0, Math.min(start, text.length)) : 0;
    let e = Number.isFinite(end) ? Math.max(s, Math.min(end, text.length)) : s;
    let begin;
    if (e - s >= max) begin = s;
    else begin = Math.round((s + e) / 2 - max / 2);
    begin = Math.max(0, Math.min(begin, text.length - max));
    let stop = begin + max;
    if (begin > 0) {
      const sp = text.indexOf(' ', begin);
      if (sp !== -1 && sp - begin < 40 && sp < s) begin = sp + 1;
    }
    if (stop < text.length) {
      const sp = text.lastIndexOf(' ', stop);
      if (sp > begin && stop - sp < 40 && sp >= e) stop = sp;
    }
    return { text: text.slice(begin, stop).trim(), offset: begin };
  }

  /** Outline from [{level, text}] in document order: h1-h3 only, de-duplicated, capped. */
  function buildOutline(headings, maxItems, maxChars) {
    const out = [];
    const limit = maxItems || LIMITS.outlineItems;
    for (const h of headings || []) {
      if (!h || !(h.level >= 1 && h.level <= 3)) continue;
      const t = clean(h.text, maxChars || LIMITS.outlineChars);
      if (!t) continue;
      if (out.length && out[out.length - 1].toLowerCase() === t.toLowerCase()) continue;
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Heading path from items in document order, all preceding (or containing)
   * the selection: headings {level, text} and labelled ancestor landmarks
   * {landmark: true, text}. Headings form a level stack; a landmark always
   * contains the selection, so it is kept and later headings cannot pop it.
   */
  function buildHeadingPath(items, maxItems) {
    const stack = [];
    for (const it of items || []) {
      if (!it) continue;
      const text = clean(it.text, LIMITS.headingChars);
      if (!text) continue;
      if (it.landmark) { stack.push({ landmark: true, text }); continue; }
      const level = Number(it.level) || 2;
      while (stack.length && !stack[stack.length - 1].landmark && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
    }
    const out = [];
    for (const s of stack) {
      if (out.length && out[out.length - 1].toLowerCase() === s.text.toLowerCase()) continue;
      out.push(s.text);
    }
    return out.slice(-(maxItems || LIMITS.headingItems));
  }

  /**
   * Accessible-name fallback order, approximating the accname algorithm:
   * aria-labelledby, aria-label, associated <label>, alt, button value,
   * text content, title, placeholder. Returns the first non-empty value.
   */
  const NAME_ORDER = ['labelledby', 'ariaLabel', 'label', 'alt', 'value', 'text', 'title', 'placeholder'];
  function pickAccessibleName(c, maxChars) {
    if (!c) return null;
    for (const k of NAME_ORDER) {
      const v = clean(c[k], maxChars || LIMITS.elementChars);
      if (v) return v;
    }
    return null;
  }

  // ── Sensitive sites ────────────────────────────────────────────
  // Webmail, messaging, payments and banking. On these, explains send local
  // context only unless the user turned page context on for that site.
  // Matching is by exact host or subdomain. The list is explicit; the only
  // heuristics are a host whose first label is mail/webmail/email, or any
  // label containing "bank". Both can over-match (e.g. a "bank" review site),
  // which only means less context is sent there — never more.
  const SENSITIVE_DOMAINS = [
    // Webmail
    'mail.google.com', 'inbox.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'outlook.cloud.microsoft', 'mail.yahoo.com', 'mail.aol.com', 'mail.proton.me', 'mail.protonmail.com',
    'app.fastmail.com', 'mail.zoho.com', 'mail.yandex.com', 'icloud.com', 'mail.gmx.com', 'mail.com',
    // Messaging
    'web.whatsapp.com', 'messenger.com', 'web.telegram.org', 'discord.com', 'slack.com', 'teams.microsoft.com',
    'teams.live.com', 'chat.google.com', 'messages.google.com', 'voice.google.com', 'web.skype.com', 'app.element.io',
    // Payments, banking, brokerage
    'paypal.com', 'venmo.com', 'cash.app', 'wise.com', 'revolut.com', 'dashboard.stripe.com', 'klarna.com',
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'usbank.com', 'pnc.com',
    'tdbank.com', 'ally.com', 'sofi.com', 'chime.com', 'americanexpress.com', 'discover.com', 'schwab.com',
    'fidelity.com', 'vanguard.com', 'robinhood.com', 'coinbase.com', 'monzo.com', 'starlingbank.com',
    'barclays.co.uk', 'hsbc.com', 'hsbc.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.co.uk',
    'rbcroyalbank.com', 'td.com', 'scotiabank.com'
  ];

  function isSensitiveHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    for (const d of SENSITIVE_DOMAINS) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
    const labels = host.split('.');
    if (labels.length > 2 && /^(mail|webmail|email)$/.test(labels[0])) return true;
    if (labels.slice(0, -1).some(l => l.includes('bank'))) return true;
    return false;
  }

  /**
   * Whether page/document context may be sent for `hostname`.
   * settings: { usePageContext?: boolean, siteOverrides?: { [host]: boolean } }
   * The global Off always wins. Sensitive sites need an explicit per-site On.
   */
  function pageContextAllowed(settings, hostname) {
    const s = settings || {};
    const host = String(hostname || '').toLowerCase();
    const sensitive = isSensitiveHost(host);
    const override = s.siteOverrides && Object.prototype.hasOwnProperty.call(s.siteOverrides, host)
      ? s.siteOverrides[host] : undefined;
    if (s.usePageContext === false) return { allowed: false, sensitive, override, reason: 'setting' };
    if (sensitive) return { allowed: override === true, sensitive, override, reason: override === true ? null : 'sensitive' };
    return { allowed: override !== false, sensitive, override, reason: override === false ? 'site' : null };
  }

  function byteLength(obj) {
    const json = JSON.stringify(obj);
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length;
  }

  function capElement(el) {
    if (!el || typeof el !== 'object') return null;
    const n = LIMITS.elementChars;
    const out = {};
    for (const k of ['tag', 'role', 'name', 'aria_label', 'title', 'label', 'href', 'container']) {
      out[k] = cleanOrNull(el[k], n);
    }
    if (el.form && typeof el.form === 'object') {
      const fields = (Array.isArray(el.form.fields) ? el.form.fields : [])
        .map(f => clean(f, n)).filter(Boolean).slice(0, LIMITS.formFields);
      const heading = cleanOrNull(el.form.heading, n);
      out.form = heading || fields.length ? { heading, fields } : null;
    } else {
      out.form = null;
    }
    return out;
  }

  /**
   * Trims and caps every field to the contract's limits and keeps the
   * serialized size under LIMITS.maxBytes by shrinking the long text fields.
   * Returns null when nothing is left.
   */
  function capContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const out = {};
    const l = ctx.local;
    if (l && typeof l === 'object') {
      const local = {};
      const hp = (Array.isArray(l.heading_path) ? l.heading_path : [])
        .map(h => clean(h, LIMITS.headingChars)).filter(Boolean).slice(-LIMITS.headingItems);
      if (hp.length) local.heading_path = hp;
      const st = clean(l.surrounding_text, LIMITS.surrounding);
      if (st) local.surrounding_text = st;
      const el = capElement(l.element);
      if (el) local.element = el;
      if (Object.keys(local).length) out.local = local;
    }
    const p = ctx.page;
    if (p && typeof p === 'object') {
      const page = {
        title: cleanOrNull(p.title, 300),
        site_name: cleanOrNull(p.site_name, 200),
        description: cleanOrNull(p.description, 500),
        outline: (Array.isArray(p.outline) ? p.outline : [])
          .map(h => clean(h, LIMITS.outlineChars)).filter(Boolean).slice(0, LIMITS.outlineItems),
        main_text: clean(p.main_text, LIMITS.mainText) || null
      };
      out.page = page;
    }
    if (!out.local && !out.page) return null;

    // Shrink to fit: main_text first, then the outline, then surrounding text.
    let guard = 0;
    while (byteLength(out) > LIMITS.maxBytes && guard++ < 40) {
      if (out.page && out.page.main_text && out.page.main_text.length > 500) {
        out.page.main_text = out.page.main_text.slice(0, Math.floor(out.page.main_text.length * 0.75));
      } else if (out.page && out.page.outline.length > 5) {
        out.page.outline = out.page.outline.slice(0, Math.ceil(out.page.outline.length / 2));
      } else if (out.local && out.local.surrounding_text && out.local.surrounding_text.length > 300) {
        out.local.surrounding_text = out.local.surrounding_text.slice(0, Math.floor(out.local.surrounding_text.length * 0.75));
      } else if (out.page) {
        delete out.page;
      } else {
        break;
      }
    }
    return out;
  }

  /** Drops page context (for the local-only rule and the quota fallback). */
  function localOnly(ctx) {
    if (!ctx || !ctx.local) return null;
    return { local: ctx.local };
  }

  const api = {
    LIMITS, SENSITIVE_DOMAINS,
    clean, centerSlice, buildOutline, buildHeadingPath, pickAccessibleName,
    isSensitiveHost, pageContextAllowed, capContext, localOnly, byteLength
  };
  root.SynapseContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ================================================================
  // DOM collection (page scripts only)
  // ================================================================
  if (typeof document === 'undefined' || !root.SynapseExplain || root.SynapseExplain.collectContext) return;
  const SX = root.SynapseExplain;
  const H = SX.H;
  const G = SX.G;
  const SETTINGS_KEY = 'explainContextSettings';

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="tab"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]', '[role="option"]',
    '[role="combobox"]', '[role="slider"]', '[role="treeitem"]'
  ].join(',');
  const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const LANDMARKS = 'section,[role="region"],form,[role="form"],fieldset,dialog,[role="dialog"],[role="alertdialog"],nav,[role="navigation"],aside,[role="tabpanel"],[role="group"]';
  const DIALOGS = 'dialog,[role="dialog"],[role="alertdialog"]';
  const CONTAINERS = '[role="toolbar"],[role="menu"],[role="menubar"],[role="tablist"],[role="listbox"],[role="radiogroup"],[role="tree"],[role="grid"],nav,[role="navigation"],dialog,[role="dialog"],[role="alertdialog"],[role="tabpanel"],[role="group"]';
  const BOILERPLATE = 'nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT']);

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isHidden(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (typeof el.checkVisibility === 'function') return !el.checkVisibility();
    return false;
  }

  /** Page-level header/footer (banner/contentinfo), not an article's own header. */
  function isPageChrome(el) {
    const tag = el.tagName;
    if (tag !== 'HEADER' && tag !== 'FOOTER') return false;
    return !el.parentElement || !el.parentElement.closest('article,aside,main,nav,section,[role="main"],[role="article"]');
  }

  function isBoilerplate(el) {
    return el.matches(BOILERPLATE) || isPageChrome(el);
  }

  /** Visible text of an element (img alt included), normalised and capped. */
  function textOf(el, max) {
    if (!el) return '';
    const limit = max || 2000;
    let out = '';
    const walk = (node) => {
      if (out.length > limit) return;
      if (node.nodeType === Node.TEXT_NODE) { out += node.data; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (SKIP_TAGS.has(node.tagName) || node.getAttribute('aria-hidden') === 'true' || node.hidden) return;
      if (node.tagName === 'IMG') { out += ' ' + (node.getAttribute('alt') || '') + ' '; return; }
      for (const child of node.childNodes) walk(child);
      if (/^(P|DIV|LI|BR|TR|H[1-6])$/.test(node.tagName)) out += ' ';
    };
    walk(el);
    return clean(out, limit);
  }

  function idrefsText(el, attr) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const doc = el.ownerDocument || document;
    return ids.map(id => {
      const ref = doc.getElementById(id);
      return ref ? (ref.getAttribute('aria-label') || textOf(ref, 300)) : '';
    }).filter(Boolean).join(' ');
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return null;
  }

  function isFormControl(el) {
    return /^(INPUT|SELECT|TEXTAREA|METER|PROGRESS|OUTPUT)$/.test(el.tagName);
  }

  function labelTextOf(el) {
    if (!isFormControl(el)) return '';
    const parts = [];
    if (el.labels && el.labels.length) {
      for (const l of el.labels) parts.push(textOf(l, 300));
    } else {
      const wrap = el.closest('label');
      if (wrap) parts.push(textOf(wrap, 300));
    }
    return parts.filter(Boolean).join(' ');
  }

  // Roles whose name can come from their content (accname "name from content").
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
    'checkbox', 'switch', 'radio', 'option', 'treeitem', 'heading', 'cell', 'columnheader', 'rowheader', 'tooltip']);

  function accessibleName(el) {
    const role = roleOf(el);
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const isInputButton = tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
    return pickAccessibleName({
      labelledby: idrefsText(el, 'aria-labelledby'),
      ariaLabel: el.getAttribute('aria-label'),
      label: labelTextOf(el),
      alt: (tag === 'IMG' || (tag === 'INPUT' && type === 'image')) ? el.getAttribute('alt') : '',
      value: isInputButton ? (el.value || ({ submit: 'Submit', reset: 'Reset' }[type] || '')) : '',
      text: (!isFormControl(el) && (NAME_FROM_CONTENT.has(role) || tag === 'A' || tag === 'BUTTON')) ? textOf(el, 300) : '',
      title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder')
    });
  }

  /** Label of a container/landmark: aria-labelledby, aria-label, legend, its first heading, title. */
  function containerLabel(el) {
    const legend = el.tagName === 'FIELDSET' ? el.querySelector(':scope > legend') : null;
    const isDialog = el.matches(DIALOGS);
    return pickAccessibleName({
      labelledby: idrefsText(el, 'aria-labelledby'),
      ariaLabel: el.getAttribute('aria-label'),
      label: legend ? textOf(legend, 200) : '',
      text: isDialog ? textOf(el.querySelector(HEADINGS), 200) : '',
      title: el.getAttribute('title')
    }, 200);
  }

  function containerOf(el) {
    const c = el.parentElement && el.parentElement.closest(CONTAINERS);
    if (!c || SX.isSynapseUI(c)) return null;
    let role = roleOf(c) || c.tagName.toLowerCase();
    if (c.tagName === 'NAV') role = 'navigation';
    if (c.tagName === 'DIALOG' && !c.getAttribute('role')) role = 'dialog';
    const label = containerLabel(c);
    return label ? `${role}: ${label}` : role;
  }

  function headingLevel(h) {
    const m = /^H([1-6])$/.exec(h.tagName);
    if (m) return Number(m[1]);
    const l = parseInt(h.getAttribute('aria-level'), 10);
    return Number.isFinite(l) && l > 0 ? l : 2;
  }

  /** Headings in document order, visible, outside Synapse UI (reader content allowed). */
  function headingsIn(scope) {
    return Array.from(scope.querySelectorAll(HEADINGS)).filter(h => !SX.isSynapseUI(h) && !isHidden(h));
  }

  function precedesOrContains(a, target) {
    if (a === target || a.contains(target)) return true;
    return !!(a.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function formOf(el) {
    const form = el.form || el.closest('form,[role="form"]');
    if (!form || SX.isSynapseUI(form)) return null;
    let heading = containerLabel(form);
    if (!heading) {
      const inner = form.querySelector(HEADINGS);
      heading = inner ? textOf(inner, 200) : '';
    }
    if (!heading) {
      // Nearest heading before the form, e.g. a card title above it.
      const path = headingPathFor(form, { landmarks: false });
      heading = path[path.length - 1] || '';
    }
    const fields = [];
    const seen = new Set();
    for (const f of form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),select,textarea,[role="combobox"],[role="checkbox"],[role="switch"],[role="textbox"]')) {
      if (isHidden(f)) continue;
      const name = accessibleName(f);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      fields.push(name);
      if (fields.length >= LIMITS.formFields) break;
    }
    return heading || fields.length ? { heading: heading || null, fields } : null;
  }

  // ── Heading path ───────────────────────────────────────────────
  function headingPathFor(target, opts) {
    const el = elementOf(target);
    if (!el) return [];
    const base = SX.activeTextRoot() || document.body;
    const scope = el.closest(DIALOGS) || (base.contains(el) ? base : document.body);
    const items = [];
    for (const h of headingsIn(scope)) {
      if (!precedesOrContains(h, el)) break;
      items.push({ el: h, level: headingLevel(h), text: textOf(h, 200) });
    }
    if (!opts || opts.landmarks !== false) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (!a.matches(LANDMARKS) || SX.isSynapseUI(a) && !SX.inReaderContent(a)) {
          if (a === scope) break;
          continue;
        }
        const label = containerLabel(a);
        if (label) items.push({ el: a, landmark: true, text: label });
        if (a === scope) break;
      }
      items.sort((x, y) => (x.el === y.el ? 0 : (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
    }
    return buildHeadingPath(items);
  }

  // ── Surrounding text ───────────────────────────────────────────
  /** ~2,000 chars around the range, from the smallest ancestor block holding enough text. */
  function surroundingFor(range, fallbackEl) {
    const startEl = elementOf(range ? range.commonAncestorContainer : fallbackEl);
    if (!startEl) return '';
    const stopAt = SX.activeTextRoot() || document.body;
    let block = startEl;
    while (block.parentElement && block !== stopAt && block !== document.body &&
      (block.textContent || '').length < LIMITS.surrounding * 1.5) {
      block = block.parentElement;
    }
    const idx = SX.buildTextIndex(block);
    let off = null;
    if (range) off = SX.offsetsFromRange(idx, range);
    if (!off && fallbackEl) {
      const r = document.createRange();
      r.selectNodeContents(fallbackEl);
      off = SX.offsetsFromRange(idx, r);
    }
    const s = off ? off.start : 0;
    const e = off ? off.end : 0;
    return centerSlice(idx.text, s, e, LIMITS.surrounding).text;
  }

  // ── Element metadata ───────────────────────────────────────────
  SX.interactiveAncestor = function (node) {
    const el = elementOf(node);
    if (!el) return null;
    const hit = el.closest(INTERACTIVE);
    return hit && !SX.isSynapseUI(hit) ? hit : null;
  };

  SX.elementMeta = function (el) {
    if (!el) return null;
    const ariaLabel = el.getAttribute('aria-label');
    const title = el.getAttribute('title') || idrefsText(el, 'aria-describedby') || '';
    let href = null;
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      try { href = new URL(el.getAttribute('href'), location.href).href; } catch (_) { href = el.getAttribute('href'); }
      if (/^javascript:/i.test(href)) href = null;
    }
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accessibleName(el),
      aria_label: ariaLabel || null,
      title: title || null,
      label: labelTextOf(el) || null,
      href,
      form: formOf(el),
      container: containerOf(el)
    };
  };

  /**
   * The main target inside a circled hull: the interactive element with the
   * largest overlap if any, else the main text block. Returns
   * { element, interactive } (element may be null).
   */
  SX.circleTarget = function (hull, box, pieces) {
    const rootEl = SX.activeTextRoot() || document.body;
    let best = null, bestArea = 0;
    for (const el of rootEl.querySelectorAll(INTERACTIVE)) {
      if (SX.isSynapseUI(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const area = G.intersectionArea({ x: r.left, y: r.top, width: r.width, height: r.height }, box);
      if (area <= 0) continue;
      // Mostly inside the hull, measured at its centre.
      if (!G.pointInPolygon({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, hull)) continue;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (best) return { element: best, interactive: true };
    if (pieces && pieces.length) {
      // The block holding the most circled text.
      const weight = new Map();
      for (const p of pieces) {
        const blockEl = p.node.parentElement && p.node.parentElement.closest('p,li,td,th,dd,dt,pre,blockquote,figcaption,h1,h2,h3,h4,h5,h6,div,section,article');
        if (blockEl) weight.set(blockEl, (weight.get(blockEl) || 0) + p.text.length);
      }
      let top = null, w = -1;
      for (const [el, n] of weight) if (n > w) { top = el; w = n; }
      return { element: top, interactive: false };
    }
    return { element: null, interactive: false };
  };

  // ── Main content region + page context ─────────────────────────
  function textLen(el) { return (el.textContent || '').length; }

  SX.mainRegion = function () {
    const reader = SX.readerContent();
    if (reader) return reader;
    if (H.contentRoot) return H.getContentRoot();
    const body = document.body;
    const landmarks = Array.from(document.querySelectorAll('main,[role="main"]'))
      .filter(el => !SX.isSynapseUI(el) && !isHidden(el));
    let pick = landmarks.sort((a, b) => textLen(b) - textLen(a))[0];
    if (!pick || textLen(pick) < 200) {
      const articles = Array.from(document.querySelectorAll('article,[role="article"]'))
        .filter(el => !SX.isSynapseUI(el) && !isHidden(el));
      const a = articles.sort((x, y) => textLen(y) - textLen(x))[0];
      if (a && textLen(a) >= 200) pick = a;
    }
    if (pick && textLen(pick) >= 200) return pick;

    // Largest text-dense container: score blocks into parent and grandparent.
    const scores = new Map();
    const blocks = body.querySelectorAll('p,li,pre,blockquote,td,dd,h2,h3');
    let n = 0;
    for (const b of blocks) {
      if (++n > 4000) break;
      if (SX.isSynapseUI(b) || b.closest(BOILERPLATE)) continue;
      const len = (b.textContent || '').trim().length;
      if (len < 25) continue;
      const p = b.parentElement;
      if (p) scores.set(p, (scores.get(p) || 0) + len);
      const gp = p && p.parentElement;
      if (gp) scores.set(gp, (scores.get(gp) || 0) + len / 2);
    }
    let top = null, best = 0;
    for (const [el, s] of scores) if (s > best && el !== document.documentElement) { top = el; best = s; }
    return top || body;
  };

  /** Text nodes in `region`, skipping boilerplate, hidden content and Synapse UI. */
  function collectMainNodes(region) {
    const nodes = [];
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (node === region) return NodeFilter.FILTER_SKIP;
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.id === 'synapse-reader-overlay') return NodeFilter.FILTER_SKIP;
        if (SX.isSynapseUI(node)) return NodeFilter.FILTER_REJECT;
        if (isBoilerplate(node) || isHidden(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    let t;
    while ((t = walker.nextNode())) nodes.push(t);
    return nodes;
  }

  function mainTextFor(region, range, fallbackEl) {
    const nodes = collectMainNodes(region);
    const starts = new Array(nodes.length);
    let raw = '';
    for (let i = 0; i < nodes.length; i++) { starts[i] = raw.length; raw += nodes[i].data + ' '; }
    const { text, map } = G.normalizeWithMap(raw);

    // Raw position of the focus: the first collected node at or after its start.
    let rawPos = -1;
    const focusNode = range ? range.startContainer : fallbackEl;
    if (focusNode) {
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        if (nd === focusNode) { rawPos = starts[i] + (range ? Math.min(range.startOffset, nd.data.length) : 0); break; }
        const rel = focusNode.compareDocumentPosition(nd);
        if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) || (rel & Node.DOCUMENT_POSITION_CONTAINED_BY)) { rawPos = starts[i]; break; }
      }
    }
    let pos = 0;
    if (rawPos >= 0) {
      let lo = 0, hi = map.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (map[mid] < rawPos) lo = mid + 1; else hi = mid; }
      pos = lo;
    }
    const focusLen = range ? Math.min(G.normalizeText(range.toString()).length, LIMITS.mainText) : 0;
    return centerSlice(text, pos, pos + focusLen, LIMITS.mainText).text;
  }

  function metaContent(selector) {
    const m = document.querySelector(selector);
    return m ? (m.getAttribute('content') || '') : '';
  }

  function outlineFor() {
    const scope = SX.readerContent() || (H.contentRoot ? H.getContentRoot() : document.body);
    const list = headingsIn(scope)
      .filter(h => !h.closest(BOILERPLATE) && !(h.closest('header,footer') && isPageChrome(h.closest('header,footer'))))
      .map(h => ({ level: headingLevel(h), text: textOf(h, 200) }));
    return buildOutline(list);
  }

  SX.pageContext = function (range, fallbackEl) {
    const region = SX.mainRegion();
    return {
      title: H.pageTitle(),
      site_name: metaContent('meta[property="og:site_name"]') || SX.state.hostname || null,
      description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]') || null,
      outline: outlineFor(),
      main_text: region ? mainTextFor(region, range, fallbackEl) : ''
    };
  };

  // ── Settings ───────────────────────────────────────────────────
  SX.loadContextSettings = function () {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(SETTINGS_KEY, (res) => {
          const v = res && res[SETTINGS_KEY];
          SX.state.contextSettings = {
            usePageContext: !(v && v.usePageContext === false),
            siteOverrides: (v && v.siteOverrides && typeof v.siteOverrides === 'object') ? v.siteOverrides : {}
          };
          resolve(SX.state.contextSettings);
        });
      } catch (_) { resolve(SX.state.contextSettings); }
    });
  };

  SX.saveContextSettings = function (next) {
    SX.state.contextSettings = next;
    try { chrome.storage.local.set({ [SETTINGS_KEY]: next }); } catch (_) { /* extension reloaded */ }
    SX.onContextSettingsChanged?.();
  };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      SX.loadContextSettings().then(() => SX.onContextSettingsChanged?.());
    });
  } catch (_) { /* not available */ }

  /** { allowed, sensitive, override, reason } for the current site. */
  SX.contextPolicy = function () {
    return pageContextAllowed(SX.state.contextSettings, SX.state.hostname);
  };

  // ── Assembly ───────────────────────────────────────────────────
  /**
   * opts: { range?, element?, interactive?: Element|null, includePage?: boolean }
   * Returns a capped { local, page? } context, or null.
   */
  SX.collectContext = function (opts) {
    const o = opts || {};
    const range = o.range || null;
    const anchorNode = range ? range.startContainer : o.element;
    const ctx = { local: {} };
    try {
      ctx.local.heading_path = headingPathFor(anchorNode || o.element);
      ctx.local.surrounding_text = surroundingFor(range, o.element);
      const target = o.interactive !== undefined ? o.interactive : (range ? SX.interactiveAncestor(range.commonAncestorContainer) : null);
      if (target) ctx.local.element = SX.elementMeta(target);
    } catch (_) { /* local context is best effort */ }
    if (o.includePage) {
      try { ctx.page = SX.pageContext(range, o.element); } catch (_) { /* best effort */ }
    }
    return capContext(ctx);
  };

  /**
   * The document behind a selection, when explains should carry document
   * context: inside the reader, on a text/CSV/Markdown/PDF page, or on a host
   * page configured with a document. Returns { url, mediaType, text? } or null.
   */
  SX.documentForExplain = function (node) {
    const src = H.documentSource();
    if (!src) return null;
    const doc = { url: src.url, mediaType: src.mediaType };
    // Plain-text pages render the file in one <pre>: send it the first time
    // so the background need not refetch it (it can, for re-uploads). Local
    // files always send it: the background can't read file:// URLs.
    const local = location.protocol === 'file:';
    if ((local || !SX.state.documentContextReady) && !H.source && /^text\//.test(src.mediaType) && !SX.inReaderContent(node)) {
      const pre = document.querySelector('body > pre');
      if (pre) doc.text = pre.textContent.slice(0, 2000000);
    }
    return doc;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
