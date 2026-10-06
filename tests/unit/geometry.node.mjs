// Unit tests for extension/lib/geometry.js.
// Run: node --test tests/unit/geometry.node.mjs
// (Named *.node.mjs so the Playwright config, which matches *.spec / *.test, ignores it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../../extension/lib/geometry.js');

const sq = (n) => [{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }];

test('convexHull drops interior and duplicate points', () => {
  const pts = [...sq(10), { x: 5, y: 5 }, { x: 2, y: 3 }, { x: 0, y: 0 }, { x: 5, y: 0 }];
  const hull = G.convexHull(pts);
  assert.equal(hull.length, 4);
  const keys = hull.map(p => `${p.x},${p.y}`).sort();
  assert.deepEqual(keys, ['0,0', '0,10', '10,0', '10,10']);
});

test('convexHull handles an open scribble and degenerate input', () => {
  const arc = [];
  for (let a = 0; a <= Math.PI * 1.5; a += 0.1) arc.push({ x: 100 + 50 * Math.cos(a), y: 100 + 50 * Math.sin(a) });
  const hull = G.convexHull(arc);
  assert.ok(hull.length >= 3);
  assert.ok(G.pointInPolygon({ x: 100, y: 100 }, hull));
  assert.deepEqual(G.convexHull([]), []);
  assert.equal(G.convexHull([{ x: 1, y: 1 }, { x: 1, y: 1 }]).length, 1);
  assert.equal(G.convexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).length, 2); // collinear
  assert.equal(G.convexHull([{ x: NaN, y: 0 }, null, { x: 1, y: 2 }]).length, 1);
});

test('polygonArea is orientation independent', () => {
  assert.equal(G.polygonArea(sq(10)), 100);
  assert.equal(G.polygonArea(sq(10).reverse()), 100);
  assert.equal(G.polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }]), 6);
  assert.equal(G.polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0);
});

test('pointInPolygon', () => {
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.ok(G.pointInPolygon({ x: 2, y: 2 }, tri));
  assert.ok(!G.pointInPolygon({ x: 8, y: 8 }, tri));
  assert.ok(!G.pointInPolygon({ x: -1, y: 1 }, tri));
  assert.ok(!G.pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }]));
});

test('bbox, centroid and rect helpers', () => {
  assert.deepEqual(G.bbox([{ x: 3, y: 9 }, { x: -1, y: 2 }, { x: 5, y: 4 }]), { x: -1, y: 2, width: 6, height: 7 });
  assert.deepEqual(G.bbox([]), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(G.centroid(sq(10)), { x: 5, y: 5 });
  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.ok(G.rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 }));
  assert.ok(!G.rectsIntersect(a, { x: 10, y: 0, width: 5, height: 5 }));
  assert.equal(G.intersectionArea(a, { x: 5, y: 5, width: 10, height: 10 }), 25);
  assert.equal(G.intersectionArea(a, { x: 20, y: 20, width: 1, height: 1 }), 0);
});

test('scaleAndClampRect scales by DPR and clamps to the image', () => {
  assert.deepEqual(G.scaleAndClampRect({ x: 10, y: 20, width: 30, height: 40 }, 2, 1000, 1000), { x: 20, y: 40, width: 60, height: 80 });
  assert.deepEqual(G.scaleAndClampRect({ x: -10, y: -10, width: 50, height: 50 }, 1.5, 40, 1000), { x: 0, y: 0, width: 40, height: 60 });
  assert.deepEqual(G.scaleAndClampRect({ x: 500, y: 500, width: 10, height: 10 }, 1, 100, 100).width, 0);
});

test('fitWithin never upscales', () => {
  assert.deepEqual(G.fitWithin(800, 400, 400), { width: 400, height: 200, scale: 0.5 });
  assert.deepEqual(G.fitWithin(100, 50, 400), { width: 100, height: 50, scale: 1 });
});

test('normalizeWithMap collapses whitespace and maps back to raw indexes', () => {
  const raw = '  Hello \n\t world  again ';
  const { text, map } = G.normalizeWithMap(raw);
  assert.equal(text, 'Hello world again');
  assert.equal(map.length, text.length);
  assert.equal(raw[map[0]], 'H');
  assert.equal(raw[map[text.indexOf('w')]], 'w');
  assert.match(raw[map[5]], /\s/);
});

test('buildTextAnchor and findTextAnchor round-trip with disambiguation', () => {
  const text = 'The cell is the unit of life. Later: the cell is the unit of life, again here.';
  const second = text.lastIndexOf('the cell is');
  const anchor = G.buildTextAnchor(text, second, second + 'the cell is the unit of life'.length);
  assert.equal(anchor.quote, 'the cell is the unit of life');
  assert.ok(anchor.prefix.endsWith('Later: '));
  const found = G.findTextAnchor(text, anchor);
  assert.deepEqual(found, { start: second, end: second + anchor.quote.length });

  // Whitespace differences in the live page still match.
  const reflowed = text.replace(/ /g, '  ');
  const n = G.normalizeWithMap(reflowed).text;
  assert.equal(G.findTextAnchor(n, anchor).start, second);

  assert.equal(G.findTextAnchor(text, { quote: 'not on the page' }), null);
  assert.equal(G.findTextAnchor(text, null), null);
  assert.equal(G.findTextAnchor(text, { quote: '   ' }), null);
});

test('long quotes are truncated with a tail and still found in full', () => {
  const body = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const text = `Intro. ${body} Outro.`;
  const start = text.indexOf('word0');
  const end = start + body.length;
  const anchor = G.buildTextAnchor(text, start, end, { maxQuote: 100, endLen: 30 });
  assert.equal(anchor.quote.length, 100);
  assert.ok(anchor.quote_end);
  assert.deepEqual(G.findTextAnchor(text, anchor), { start, end });
});

test('upperBoundIndex', () => {
  const starts = [0, 5, 9, 20];
  assert.equal(G.upperBoundIndex(starts, 0), 0);
  assert.equal(G.upperBoundIndex(starts, 7), 1);
  assert.equal(G.upperBoundIndex(starts, 25), 3);
  assert.equal(G.upperBoundIndex(starts, -1), -1);
});

test('pushCapped keeps the newest N and dedupes by id', () => {
  let list = [];
  for (let i = 0; i < 12; i++) {
    list = G.pushCapped(list, { id: `e${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }, 10);
  }
  assert.equal(list.length, 10);
  assert.equal(list[0].id, 'e11');
  assert.equal(list[9].id, 'e2');
  list = G.pushCapped(list, { id: 'e11', created_at: new Date(Date.UTC(2026, 0, 2)).toISOString(), v: 2 }, 10);
  assert.equal(list.length, 10);
  assert.equal(list[0].v, 2);
});

test('url helpers', () => {
  assert.equal(G.hostnameOf('https://Docs.Example.com:8443/a?b#c'), 'docs.example.com');
  assert.equal(G.hostnameOf('not a url'), '');
  assert.equal(G.hostnameOf('file:///C:/Users/me/paper.pdf'), G.LOCAL_FILES_HOST);
  assert.equal(G.LOCAL_FILES_HOST, 'local-files');
  assert.equal(G.pageKey('https://x.com/a?b=1#frag'), 'https://x.com/a?b=1');
});

test('relativeTime and truncate', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(G.relativeTime('2026-10-04T11:59:50Z', now), 'just now');
  assert.equal(G.relativeTime('2026-10-04T11:50:00Z', now), '10m ago');
  assert.equal(G.relativeTime('2026-10-04T09:00:00Z', now), '3h ago');
  assert.equal(G.relativeTime('2026-10-02T12:00:00Z', now), '2d ago');
  assert.equal(G.relativeTime('garbage', now), '');
  assert.equal(G.truncate('abcdef', 3), 'abc');
  assert.equal(G.truncate(null, 3), '');
});
