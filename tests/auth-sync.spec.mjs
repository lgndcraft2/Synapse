import { expect, test } from '@playwright/test';
import {
  launchExtension,
  readStorage,
  sendExternalMessage,
  sendMessage,
  waitForStorage,
  writeStorage,
} from './extension.mjs';
import { BACKEND_URL, FRONTEND_URL, readState } from './paths.mjs';

test.describe.configure({ mode: 'serial' });

let context;
let extensionId;
let userDataDir;
let popupUrl;

// Seeded by global-setup into a throwaway SQLite database. The suite used to
// register a real Supabase account on every run and leak it; sign-up and email
// verification are covered by backend/tests/test_auth_flows.py instead.
const { email: testEmail, password: testPassword } = readState().seeded;
const NOTE_MARKER = `e2e-${Date.now()}`;

/** MV3 workers get evicted; always grab the live one. */
function worker() {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('Extension service worker is not running');
  return sw;
}

/** Wakes the service worker if Chrome has evicted it. */
async function wakeWorker() {
  if (context.serviceWorkers().length) return;
  const page = await context.newPage();
  await page.goto(popupUrl);
  await page.close();
  await context.waitForEvent('serviceworker', { timeout: 15_000 });
}

async function backendProfile(token) {
  const res = await fetch(`${BACKEND_URL}/api/v1/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function openPopup() {
  const page = await context.newPage();
  await page.goto(popupUrl);
  return page;
}

test.beforeAll(async () => {
  const launched = await launchExtension();
  context = launched.context;
  extensionId = launched.extensionId;
  userDataDir = launched.userDataDir;
  popupUrl = `chrome-extension://${extensionId}/popup.html`;

  // The popup redirects to onboarding and self-closes on a fresh profile.
  await writeStorage(launched.worker, { onboardingComplete: true });

  // Close the onboarding tab the install event opens.
  for (const page of context.pages()) {
    if (page.url().includes('onboarding.html')) await page.close();
  }
});

test.afterAll(async () => {
  await context?.close();
});

test('extension loads with the ID the dashboard was configured with', async () => {
  const state = readState();
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(extensionId).toBe(state.extensionId);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test('popup starts signed out', async () => {
  const page = await openPopup();

  await expect(page.locator('#account-status')).toHaveText(/Not signed in/i);
  await expect(page.locator('#dashboard-link')).toBeVisible();

  // This test used to fill '#backend-url' and click '#save-provider-btn'.
  // Neither element exists in popup.html — the backend-URL setting was removed
  // (see the comment at popup.js:28) — so it threw, and because the suite is
  // serial every test after it was skipped. The API base URL now arrives with
  // the session handoff instead, which the handoff test asserts.
  await page.close();
});

test('dashboard origin can reach the extension (externally_connectable)', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/auth?tab=login`);

  const pong = await sendExternalMessage(page, extensionId, { type: 'SYNAPSE_PING' });
  expect(pong).toMatchObject({ ok: true, installed: true });

  const rejected = await sendExternalMessage(page, extensionId, { type: 'NOT_A_REAL_TYPE' });
  expect(rejected).toMatchObject({ ok: false });

  await page.close();
});

test('signing in on the dashboard hands the session to the extension', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/auth?tab=login`);

  await page.fill('#email-login', testEmail);
  await page.fill('#password-login', testPassword);
  await page.click('button[type="submit"]');

  await page.waitForURL('**/dashboard', { timeout: 45_000 });

  await wakeWorker();
  const { synapseSession } = await waitForStorage(
    worker(),
    'synapseSession',
    (s) => Boolean(s.synapseSession?.access_token),
    30_000
  );

  expect(synapseSession.access_token).toBeTruthy();
  expect(synapseSession.refresh_token).toBeTruthy();
  expect(synapseSession.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // The payload carries the API base URL and no credentials of any kind. It
  // used to ship a Supabase URL *and the anon key*; the extension now holds no
  // API key at all.
  expect(synapseSession.api_url).toBe(BACKEND_URL);
  expect(synapseSession.supabase_url).toBeUndefined();
  expect(synapseSession.supabase_anon_key).toBeUndefined();

  // The handoff also self-configures the API base URL. providerConfig
  // .backendBaseUrl is read in six places but was written by nothing, so every
  // install silently fell back to the localhost default.
  const { providerConfig } = await readStorage(worker(), 'providerConfig');
  expect(providerConfig.backendBaseUrl).toBe(BACKEND_URL);

  await page.close();
});

test('extension pulls the server profile after the handoff', async () => {
  await wakeWorker();
  const { synapseSession } = await readStorage(worker(), 'synapseSession');

  const { status, body } = await backendProfile(synapseSession.access_token);
  expect(status).toBe(200);

  // The handoff kicks off fetchAndStoreProfile() in the background, so give it
  // a moment to land rather than reading storage the instant the session appears.
  const { cognitiveProfile } = await waitForStorage(
    worker(),
    'cognitiveProfile',
    (s) => Boolean(s.cognitiveProfile),
    15_000
  );

  // Local storage must mirror what the API returned, field for field.
  expect(cognitiveProfile).toMatchObject({
    profileType: body.profile_type,
    preferredFormat: body.preferred_format,
    chunkSize: body.chunk_size,
    needsExamplesFirst: body.needs_examples_first,
    simplifyVocab: body.simplify_vocab,
    maxNestingDepth: body.max_nesting_depth,
    useHeaders: body.use_headers,
  });
});

test('popup reports the signed-in state and live billing status', async () => {
  const page = await openPopup();

  await expect(page.locator('#account-status')).toHaveText(/Signed in/i);
  await expect(page.locator('#billing-status')).toHaveText(/Billing: free \(active\)/i);
  await expect(page.locator('#dashboard-link')).toBeHidden();

  const auth = await sendMessage(page, { type: 'GET_AUTH_STATUS' });
  expect(auth).toMatchObject({ authenticated: true });

  await page.close();
});

test('saving in the popup writes through to the server', async () => {
  const page = await openPopup();
  await expect(page.locator('#account-status')).toHaveText(/Signed in/i);

  await page.selectOption('#chunk-size', 'long');
  await page.selectOption('#format', 'numbered steps');
  await page.check('#simplify-vocab');
  await page.fill('#notes', NOTE_MARKER);
  await page.click('#save-btn');
  await expect(page.locator('#status')).toHaveText(/Profile saved/i);

  const saved = await sendMessage(page, {
    type: 'SAVE_PROFILE',
    profile: {
      chunkSize: 'long',
      preferredFormat: 'numbered steps',
      simplifyVocab: true,
      notes: NOTE_MARKER,
    },
  });
  expect(saved).toMatchObject({ success: true, synced: true });

  const { synapseSession } = await readStorage(worker(), 'synapseSession');
  const { status, body } = await backendProfile(synapseSession.access_token);
  expect(status).toBe(200);
  expect(body.chunk_size).toBe('long');
  expect(body.preferred_format).toBe('numbered steps');
  expect(body.simplify_vocab).toBe(true);
  expect(body.notes).toBe(NOTE_MARKER);

  await page.close();
});

test('feedback submitted by the extension reaches the server', async () => {
  const page = await openPopup();

  const result = await sendMessage(page, {
    type: 'FEEDBACK',
    entry: {
      reaction: 'clearer',
      note: NOTE_MARKER,
      timeSpentSeconds: 42,
      // content.js sends this as an integer percentage (Math.round(p * 100)).
      readProgress: 80,
      sessionDifficulty: 'normal',
      sectionTitle: 'E2E section',
    },
  });

  expect(result).toMatchObject({ ok: true, synced: true });
  expect(result.syncError).toBeUndefined();

  await page.close();
});

test('an expired access token is refreshed instead of dropping the session', async () => {
  await wakeWorker();
  const before = (await readStorage(worker(), 'synapseSession')).synapseSession;

  // Force the stored session past its expiry so getValidAccessToken() must refresh.
  await writeStorage(worker(), {
    synapseSession: { ...before, expires_at: Math.floor(Date.now() / 1000) - 10 },
  });

  const page = await openPopup();
  const auth = await sendMessage(page, { type: 'GET_AUTH_STATUS' });
  expect(auth).toMatchObject({ authenticated: true });

  const after = (await readStorage(worker(), 'synapseSession')).synapseSession;
  expect(after.access_token).not.toBe(before.access_token);
  expect(after.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // The assertion the entire session design rests on, and which nothing else
  // in this suite covers: the refresh token must ROTATE. background.js used to
  // fall back to the old token when the response omitted one, which under
  // rotation means re-presenting a spent token — exactly what the server
  // revokes the whole session family for.
  expect(after.refresh_token).not.toBe(before.refresh_token);

  // The refreshed token must still be accepted by the API.
  const { status } = await backendProfile(after.access_token);
  expect(status).toBe(200);

  await page.close();
});

test('a revoked refresh token clears the session instead of looping', async () => {
  await wakeWorker();
  const before = (await readStorage(worker(), 'synapseSession')).synapseSession;

  // Replaying a spent refresh token is the theft signal; the server revokes
  // the family and answers 401 from then on.
  await fetch(`${BACKEND_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: before.refresh_token }),
  });

  await writeStorage(worker(), {
    synapseSession: { ...before, expires_at: Math.floor(Date.now() / 1000) - 10 },
  });

  const page = await openPopup();
  const auth = await sendMessage(page, { type: 'GET_AUTH_STATUS' });
  expect(auth).toMatchObject({ authenticated: false });

  // Previously a failed refresh returned null and left the dead session in
  // storage forever, so the popup said "not signed in" while the extension
  // kept retrying a revoked token on every request.
  const after = (await readStorage(worker(), 'synapseSession')).synapseSession;
  expect(after).toBeFalsy();

  await page.close();
});

test('logging out of the dashboard clears the extension session', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/dashboard`);

  // Sign-out lives inside the account dropdown, which only renders when open,
  // so the trigger has to be clicked first. (This test previously anchored on
  // a bare "logout" glyph in the header and clicked nothing — the control had
  // since moved into a menu.) Both steps target accessible roles rather than
  // icon text, so a future restyle does not silently break this again.
  const beforeLogout = (await readStorage(worker(), 'synapseSession')).synapseSession;

  await page.locator('[aria-expanded]').first().click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await page.waitForURL('**/auth**', { timeout: 30_000 });

  // Sign-out now revokes the refresh token server-side, which Supabase used to
  // do for us. Without this the token would stay usable for 30 days.
  const revoked = await fetch(`${BACKEND_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: beforeLogout.refresh_token }),
  });
  expect(revoked.status).toBe(401);

  await wakeWorker();
  await waitForStorage(
    worker(),
    'synapseSession',
    (s) => !s.synapseSession,
    20_000
  );

  const popup = await openPopup();
  await expect(popup.locator('#account-status')).toHaveText(/Not signed in/i);
  await expect(popup.locator('#billing-status')).toHaveText(/anonymous free-tier/i);

  await popup.close();
  await page.close();
});
