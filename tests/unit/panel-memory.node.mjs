import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const context = require('../../extension/explain/context.js');
const geometry = require('../../extension/lib/geometry.js');
const source = readFileSync(new URL('../../extension/explain/panel.js', import.meta.url), 'utf8');

function harness() {
  let url = 'https://example.test/first';
  const requests = [];
  const pending = [];
  const views = [];
  const panel = {
    G: geometry,
    H: { S: {}, pageUrl: () => url, pageTitle: () => url },
    state: { turns: [], history: [], requestSeq: 0 },
    send: (message) => {
      requests.push(message);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  runInNewContext(source, { SynapseExplain: panel, SynapseContext: context });
  panel.showCurrent = (view) => views.push(view);
  panel.openPanel = () => {};
  return { panel, requests, pending, views, navigate: (next) => { url = next; } };
}

test('an in-flight result keeps its original page after SPA navigation', async () => {
  const app = harness();
  const request = app.panel.requestExplain({ text: 'first page' });
  app.navigate('https://example.test/second');
  app.pending.shift()({ ok: true, html: '<p>First answer</p>' });
  await request;
  assert.equal(app.panel.state.turns[0].url, 'https://example.test/first');
  assert.equal(app.views.at(-1).request.pageUrl, 'https://example.test/first');

  const next = app.panel.requestExplain({ text: 'second page' });
  assert.equal(app.requests.at(-1).recentTurns.length, 0);
  app.pending.shift()({ ok: true, html: '<p>Second answer</p>' });
  await next;
});

test('same-page memory includes a Respond draft but excludes other pages', async () => {
  const app = harness();
  const first = app.panel.requestExplain({ text: 'a message', mode: 'respond' });
  app.pending.shift()({ ok: true, html: '<p>Reply briefly</p>', draft: 'Yes, Friday works.' });
  await first;
  app.panel.state.turns.push({ url: 'https://example.test/elsewhere', source: 'private elsewhere' });
  const next = app.panel.requestExplain({ text: 'follow-up' });
  const turns = app.requests.at(-1).recentTurns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, 'Reply briefly Draft: Yes, Friday works.');
  app.pending.shift()({ ok: true, html: '<p>Follow-up</p>' });
  await next;
});

test('failed results never enter page memory', async () => {
  const app = harness();
  const request = app.panel.requestExplain({ text: 'question' });
  app.pending.shift()({ ok: false, error: 'Unavailable' });
  await request;
  assert.equal(app.panel.state.turns.length, 0);
});
