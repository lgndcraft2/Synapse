// Unit tests for the pure half of extension/explain/context.js.
// Run: node --test tests/unit/*.node.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CX = require('../../extension/explain/context.js');

test('loads in Node without a DOM and exposes only the pure API', () => {
  assert.equal(typeof CX.centerSlice, 'function');
  assert.equal(globalThis.SynapseExplain, undefined);
});

test('centerSlice returns short text whole', () => {
  assert.deepEqual(CX.centerSlice('hello world', 2, 4, 100), { text: 'hello world', offset: 0 });
  assert.deepEqual(CX.centerSlice('', 0, 0, 10), { text: '', offset: 0 });
});

test('centerSlice centres on the focus and stays in bounds', () => {
  const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
  const focus = words.indexOf('w1000');
  const { text, offset } = CX.centerSlice(words, focus, focus + 5, 400);
  assert.ok(text.length <= 400);
  assert.ok(text.includes('w1000'));
  const mid = offset + 200;
  assert.ok(Math.abs(mid - focus) < 60, 'roughly centred');
  // Snapped to word boundaries: starts and ends on whole words.
  assert.match(text, /^w\d+/);
  assert.match(text, /w\d+$/);

  const start = CX.centerSlice(words, 0, 2, 400);
  assert.equal(start.offset, 0);
  const end = CX.centerSlice(words, words.length - 2, words.length, 400);
  assert.ok(end.text.endsWith('w1999'));
});

test('centerSlice starts at the focus when the focus is longer than max', () => {
  const t = 'a'.repeat(100) + 'b'.repeat(1000) + 'c'.repeat(100);
  const { text, offset } = CX.centerSlice(t, 100, 1100, 300);
  assert.equal(offset, 100);
  assert.equal(text, 'b'.repeat(300));
});

test('buildOutline keeps h1-h3 in order, dedupes and caps', () => {
  const hs = [
    { level: 1, text: 'Settings' }, { level: 4, text: 'Fine print' }, { level: 2, text: '  Profile ' },
    { level: 2, text: 'profile' }, { level: 3, text: '' }, { level: 3, text: 'Connected   accounts' }
  ];
  assert.deepEqual(CX.buildOutline(hs), ['Settings', 'Profile', 'Connected accounts']);
  const many = Array.from({ length: 60 }, (_, i) => ({ level: 2, text: `H${i}` }));
  assert.equal(CX.buildOutline(many).length, 40);
  assert.equal(CX.buildOutline([{ level: 1, text: 'x'.repeat(500) }])[0].length, 200);
});

test('buildHeadingPath forms a level stack', () => {
  const path = CX.buildHeadingPath([
    { level: 1, text: 'Settings' }, { level: 2, text: 'Profile' }, { level: 3, text: 'Avatar' },
    { level: 2, text: 'Connected accounts' }, { level: 3, text: 'Chase Checking' }
  ]);
  assert.deepEqual(path, ['Settings', 'Connected accounts', 'Chase Checking']);
});

test('buildHeadingPath keeps landmarks and caps at 8', () => {
  const path = CX.buildHeadingPath([
    { level: 1, text: 'Settings' }, { landmark: true, text: 'Account actions' }, { level: 1, text: 'Inside' }
  ]);
  assert.deepEqual(path, ['Settings', 'Account actions', 'Inside']);
  const deep = Array.from({ length: 12 }, (_, i) => ({ level: i + 1, text: `L${i}` }));
  const capped = CX.buildHeadingPath(deep);
  assert.equal(capped.length, 8);
  assert.equal(capped[7], 'L11');
  assert.deepEqual(CX.buildHeadingPath([{ level: 2, text: 'A' }, { landmark: true, text: 'a' }]), ['A']);
});

test('pickAccessibleName follows the accname fallback order', () => {
  const all = { labelledby: 'By id', ariaLabel: 'Aria', label: 'Label', alt: 'Alt', value: 'Val', text: 'Text', title: 'Title', placeholder: 'Ph' };
  assert.equal(CX.pickAccessibleName(all), 'By id');
  assert.equal(CX.pickAccessibleName({ ...all, labelledby: '  ' }), 'Aria');
  assert.equal(CX.pickAccessibleName({ label: 'Email', title: 'Your email', placeholder: 'you@x' }), 'Email');
  assert.equal(CX.pickAccessibleName({ text: '', title: 'Refresh', placeholder: 'x' }), 'Refresh');
  assert.equal(CX.pickAccessibleName({ placeholder: 'Search…' }), 'Search…');
  assert.equal(CX.pickAccessibleName({ text: 'Go' , title: 'Go somewhere' }), 'Go');
  assert.equal(CX.pickAccessibleName({}), null);
  assert.equal(CX.pickAccessibleName(null), null);
});

test('isSensitiveHost: explicit list, subdomains, and narrow heuristics', () => {
  for (const h of ['mail.google.com', 'outlook.office.com', 'web.whatsapp.com', 'www.messenger.com', 'acme.slack.com',
    'app.slack.com', 'discord.com', 'teams.microsoft.com', 'www.paypal.com', 'secure.chase.com', 'mail.example.org',
    'webmail.uni.edu', 'onlinebanking.example.com', 'MAIL.GOOGLE.COM.']) {
    assert.ok(CX.isSensitiveHost(h), h);
  }
  for (const h of ['docs.google.com', 'example.com', 'en.wikipedia.org', 'news.ycombinator.com', '127.0.0.1', '',
    'gmail.example', 'notpaypal.com', 'paypal.com.evil.example']) {
    assert.ok(!CX.isSensitiveHost(h), h);
  }
});

test('pageContextAllowed: global off wins; sensitive sites need a per-site on', () => {
  assert.deepEqual(CX.pageContextAllowed({}, 'example.com').allowed, true);
  assert.equal(CX.pageContextAllowed({ usePageContext: false }, 'example.com').allowed, false);
  assert.equal(CX.pageContextAllowed({ usePageContext: false }, 'example.com').reason, 'setting');
  const s = CX.pageContextAllowed({}, 'mail.google.com');
  assert.equal(s.allowed, false);
  assert.equal(s.sensitive, true);
  assert.equal(s.reason, 'sensitive');
  assert.equal(CX.pageContextAllowed({ siteOverrides: { 'mail.google.com': true } }, 'mail.google.com').allowed, true);
  assert.equal(CX.pageContextAllowed({ usePageContext: false, siteOverrides: { 'mail.google.com': true } }, 'mail.google.com').allowed, false);
  assert.equal(CX.pageContextAllowed({ siteOverrides: { 'example.com': false } }, 'example.com').allowed, false);
});

test('capContext trims every field to the contract limits', () => {
  const ctx = CX.capContext({
    local: {
      heading_path: Array.from({ length: 12 }, (_, i) => `H${i} ` + 'x'.repeat(300)),
      surrounding_text: 's'.repeat(5000),
      element: {
        tag: 'button', role: 'button', name: 'n'.repeat(400), aria_label: null, title: '', label: undefined,
        href: null, container: 'toolbar: Actions', extra: 'dropped',
        form: { heading: 'Chase', fields: Array.from({ length: 30 }, (_, i) => `F${i}`) }
      }
    },
    page: {
      title: 'T', site_name: 'S', description: 'D',
      outline: Array.from({ length: 50 }, (_, i) => `O${i}`),
      main_text: 'm'.repeat(20000)
    }
  });
  assert.equal(ctx.local.heading_path.length, 8);
  assert.ok(ctx.local.heading_path.every(h => h.length <= 200));
  assert.equal(ctx.local.surrounding_text.length, 2000);
  assert.equal(ctx.local.element.name.length, 300);
  assert.equal(ctx.local.element.title, null);
  assert.equal(ctx.local.element.extra, undefined);
  assert.equal(ctx.local.element.form.fields.length, 20);
  assert.equal(ctx.page.outline.length, 40);
  assert.equal(ctx.page.main_text.length, 8000);
  assert.ok(CX.byteLength(ctx) <= CX.LIMITS.maxBytes);
});

test('capContext shrinks oversized multibyte context under the byte cap', () => {
  const ctx = CX.capContext({
    local: { surrounding_text: '漢'.repeat(2000) },
    page: { outline: Array.from({ length: 40 }, () => '字'.repeat(200)), main_text: '語'.repeat(8000) }
  });
  assert.ok(CX.byteLength(ctx) <= CX.LIMITS.maxBytes);
  assert.ok(ctx.local.surrounding_text.length > 0);
});

test('capContext and localOnly handle empty input', () => {
  assert.equal(CX.capContext(null), null);
  assert.equal(CX.capContext({}), null);
  assert.equal(CX.capContext({ local: { heading_path: [], surrounding_text: '  ' } }), null);
  assert.deepEqual(CX.localOnly({ local: { surrounding_text: 'a' }, page: { title: 'x' } }), { local: { surrounding_text: 'a' } });
  assert.equal(CX.localOnly({ page: { title: 'x' } }), null);
  assert.equal(CX.localOnly(null), null);
});
