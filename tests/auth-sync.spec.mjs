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

const testEmail = `synapse.e2e.${Date.now()}@example.com`;
const testPassword = 'Synapse-E2E-passw0rd!';
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

test('popup starts signed out and accepts the local backend URL', async () => {
  const page = await openPopup();

  await expect(page.locator('#account-status')).toHaveText(/Not signed in/i);

  // Point the extension at the local API through the real settings UI.
  await page.fill('#backend-url', BACKEND_URL);
  await page.click('#save-provider-btn');
  await expect(page.locator('#status')).toHaveText(/Backend settings saved/i);

  const { providerConfig } = await readStorage(worker(), 'providerConfig');
  expect(providerConfig.backendBaseUrl).toBe(BACKEND_URL);
  expect(providerConfig.useBackendProxy).toBe(true);

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

test('signing up on the dashboard hands the session to the extension', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/auth?tab=signup`);

  await page.fill('#name', 'Synapse E2E');
  await page.fill('#email-signup', testEmail);
  await page.fill('#password-signup', testPassword);
  await page.fill('#password-confirm', testPassword);
  await page.click('button[type="submit"]');

  // If the Supabase project requires email confirmation there is no session to
  // hand off, and the whole flow under test cannot run — say so plainly.
  const confirmationWall = page.getByText(/Check your email/i);
  const landedOnDashboard = page.waitForURL('**/dashboard', { timeout: 45_000 });
  const blocked = confirmationWall
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'blocked')
    .catch(() => null);

  const outcome = await Promise.race([landedOnDashboard.then(() => 'ok'), blocked]);
  if (outcome === 'blocked') {
    throw new Error(
      'Supabase returned no session on signup (email confirmation is required). ' +
        'Disable "Confirm email" for this project, or re-run with an existing test account.'
    );
  }

  await wakeWorker();
  const { supabaseSession } = await waitForStorage(
    worker(),
    'supabaseSession',
    (s) => Boolean(s.supabaseSession?.access_token),
    30_000
  );

  expect(supabaseSession.access_token).toBeTruthy();
  expect(supabaseSession.refresh_token).toBeTruthy();
  expect(supabaseSession.supabase_url).toMatch(/^https:\/\/.*\.supabase\.co\/?$/);
  expect(supabaseSession.supabase_anon_key).toBeTruthy();
  expect(supabaseSession.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

  await page.close();
});

test('extension pulls the server profile after the handoff', async () => {
  await wakeWorker();
  const { supabaseSession } = await readStorage(worker(), 'supabaseSession');

  const { status, body } = await backendProfile(supabaseSession.access_token);
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

  const { supabaseSession } = await readStorage(worker(), 'supabaseSession');
  const { status, body } = await backendProfile(supabaseSession.access_token);
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
  const before = (await readStorage(worker(), 'supabaseSession')).supabaseSession;

  // Force the stored session past its expiry so getValidAccessToken() must refresh.
  await writeStorage(worker(), {
    supabaseSession: { ...before, expires_at: Math.floor(Date.now() / 1000) - 10 },
  });

  const page = await openPopup();
  const auth = await sendMessage(page, { type: 'GET_AUTH_STATUS' });
  expect(auth).toMatchObject({ authenticated: true });

  const after = (await readStorage(worker(), 'supabaseSession')).supabaseSession;
  expect(after.access_token).not.toBe(before.access_token);
  expect(after.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // The refreshed token must still be accepted by the API.
  const { status } = await backendProfile(after.access_token);
  expect(status).toBe(200);

  await page.close();
});

test('logging out of the dashboard clears the extension session', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/dashboard`);
  // The logout control is a clickable <div> in the header, not a <button>, so
  // there is no button role to target — anchor on the "logout" icon glyph.
  await page.locator('header').getByText('logout', { exact: true }).click();
  await page.waitForURL('**/auth**', { timeout: 30_000 });

  await wakeWorker();
  await waitForStorage(
    worker(),
    'supabaseSession',
    (s) => !s.supabaseSession,
    20_000
  );

  const popup = await openPopup();
  await expect(popup.locator('#account-status')).toHaveText(/Not signed in/i);
  await expect(popup.locator('#billing-status')).toHaveText(/anonymous free-tier/i);

  await popup.close();
  await page.close();
});
