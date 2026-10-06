// ================================================================
// SYNAPSE GEOMETRY + TEXT ANCHORING (pure functions, no DOM)
// Loaded as a classic content script before content.js, by the background
// service worker via importScripts(), and from Node for unit tests.
// ================================================================
(function (root) {
  'use strict';

  // ── Polygon geometry ───────────────────────────────────────────
  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Convex hull by Andrew's monotone chain. Returns the hull in
   * counter-clockwise order (screen coords: y grows down, so it reads
   * clockwise on screen) without repeating the first point. Collinear
   * points on the hull edge are dropped. Fewer than 3 distinct points
   * returns the distinct points as-is.
   */
  function convexHull(points) {
    const pts = [];
    const seen = new Set();
    for (const p of points || []) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const key = p.x + ',' + p.y;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push({ x: p.x, y: p.y });
    }
    if (pts.length < 3) return pts;
    pts.sort((a, b) => (a.x - b.x) || (a.y - b.y));

    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  /** Absolute polygon area via the shoelace formula. */
  function polygonArea(poly) {
    if (!poly || poly.length < 3) return 0;
    let sum = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      sum += (poly[j].x * poly[i].y) - (poly[i].x * poly[j].y);
    }
    return Math.abs(sum) / 2;
  }

  /** Ray-casting point-in-polygon. Points exactly on an edge may go either way. */
  function pointInPolygon(pt, poly) {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersects = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  /** Axis-aligned bounding box as {x, y, width, height}. */
  function bbox(points) {
    if (!points || !points.length) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Mean of the vertices; good enough as an interior point for a convex hull. */
  function centroid(poly) {
    if (!poly || !poly.length) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
      a.y < b.y + b.height && b.y < a.y + a.height;
  }

  /** Area of the intersection of two {x,y,width,height} rects. */
  function intersectionArea(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * Scales a CSS-pixel rect into image pixels and clamps it to the image.
   * Returns integer {x, y, width, height}; width/height may be 0 if the
   * rect lies fully outside the image.
   */
  function scaleAndClampRect(rect, scale, imageWidth, imageHeight) {
    const x0 = Math.max(0, Math.floor(rect.x * scale));
    const y0 = Math.max(0, Math.floor(rect.y * scale));
    const x1 = Math.min(imageWidth, Math.ceil((rect.x + rect.width) * scale));
    const y1 = Math.min(imageHeight, Math.ceil((rect.y + rect.height) * scale));
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  /** Size that fits {width,height} inside a longest side of `maxSide`, never upscaling. */
  function fitWithin(width, height, maxSide) {
    const longest = Math.max(width, height);
    if (!longest || longest <= maxSide) return { width, height, scale: 1 };
    const scale = maxSide / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale
    };
  }

  // ── Text normalisation + quote anchoring ───────────────────────

  /**
   * Collapses every whitespace run to one space (and trims leading
   * whitespace) while recording, for each output character, its index in
   * the raw input. `map[i]` is the raw index of normalised char `i`.
   */
  function normalizeWithMap(raw) {
    let text = '';
    const map = [];
    let pendingSpace = false;
    let pendingIdx = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        if (!pendingSpace) { pendingSpace = true; pendingIdx = i; }
        continue;
      }
      if (pendingSpace && text.length) { text += ' '; map.push(pendingIdx); }
      pendingSpace = false;
      text += ch;
      map.push(i);
    }
    return { text, map };
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Builds a {quote, prefix, suffix} anchor for text[start, end) in an
   * already-normalised string. Long quotes are truncated and carry
   * `quote_end` (the last `endLen` chars) so the full span can be found again.
   */
  function buildTextAnchor(text, start, end, opts) {
    const o = Object.assign({ context: 32, maxQuote: 1500, endLen: 120 }, opts || {});
    const full = text.slice(start, end);
    const anchor = {
      quote: full,
      prefix: text.slice(Math.max(0, start - o.context), start),
      suffix: text.slice(end, end + o.context)
    };
    if (full.length > o.maxQuote) {
      anchor.quote = full.slice(0, o.maxQuote);
      anchor.quote_end = full.slice(-o.endLen);
      anchor.quote_length = full.length;
    }
    return anchor;
  }

  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /**
   * Finds an anchor in normalised `text`. Every exact occurrence of the
   * quote is scored by how much of the stored prefix/suffix matches around
   * it; the best wins (ties go to the earliest). Returns {start, end} in
   * `text` coordinates or null when the quote no longer exists.
   */
  function findTextAnchor(text, anchor, opts) {
    if (!anchor || !anchor.quote) return null;
    const quote = normalizeText(anchor.quote);
    if (!quote) return null;
    const maxHits = (opts && opts.maxHits) || 200;
    const prefix = normalizeText(anchor.prefix || '');
    const suffix = normalizeText(anchor.suffix || '');
    const quoteEnd = anchor.quote_end ? normalizeText(anchor.quote_end) : '';

    let best = null;
    let from = 0;
    let hits = 0;
    while (hits < maxHits) {
      const idx = text.indexOf(quote, from);
      if (idx === -1) break;
      hits++;
      let end = idx + quote.length;
      if (quoteEnd) {
        // Truncated quote: the stored tail must follow, within a sane window.
        const expected = anchor.quote_length || quote.length + quoteEnd.length;
        const tailIdx = text.indexOf(quoteEnd, Math.max(idx, end - quoteEnd.length));
        if (tailIdx === -1 || tailIdx - idx > expected * 1.5 + 200) { from = idx + 1; continue; }
        end = tailIdx + quoteEnd.length;
      }
      const before = text.slice(Math.max(0, idx - prefix.length - 1), idx).trimEnd();
      const after = text.slice(end, end + suffix.length + 1).trimStart();
      const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
      if (!best || score > best.score) best = { start: idx, end, score };
      if (prefix.length + suffix.length > 0 && score === prefix.length + suffix.length) break;
      from = idx + 1;
    }
    return best ? { start: best.start, end: best.end } : null;
  }

  /** Largest index i with sorted[i] <= value (sorted ascending), or -1. */
  function upperBoundIndex(sorted, value) {
    let lo = 0, hi = sorted.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= value) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ── History helpers ────────────────────────────────────────────

  /** Adds `entry` to the front, dedupes by id, keeps at most `max` (oldest dropped). */
  function pushCapped(list, entry, max) {
    const rest = (list || []).filter(e => e && e.id !== entry.id);
    const next = [entry].concat(rest);
    next.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return next.slice(0, max);
  }

  // Local files have no host: they share one history "site", the same name
  // the backend uses (LOCAL_FILES_HOST in backend/app/api/routes/explain.py).
  const LOCAL_FILES_HOST = 'local-files';

  function hostnameOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return LOCAL_FILES_HOST;
      return u.hostname.toLowerCase();
    } catch (_) { return ''; }
  }

  /** URL without its fragment, for "same page" comparisons. */
  function pageKey(url) {
    try { const u = new URL(url); u.hash = ''; return u.href; } catch (_) { return String(url || ''); }
  }

  function relativeTime(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    if (d < 7) return d + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) : s;
  }

  const api = {
    convexHull, polygonArea, pointInPolygon, bbox, centroid,
    rectsIntersect, intersectionArea, scaleAndClampRect, fitWithin,
    normalizeWithMap, normalizeText, buildTextAnchor, findTextAnchor, upperBoundIndex,
    pushCapped, hostnameOf, pageKey, relativeTime, truncate, LOCAL_FILES_HOST
  };

  root.SynapseGeometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
