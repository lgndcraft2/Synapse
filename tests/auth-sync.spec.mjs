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

/** The dashboard's own session, as the SPA stores it. */
async function dashboardSession(page) {
  const raw = await page.evaluate(() => localStorage.getItem('synapse.session'));
  expect(raw).toBeTruthy();
  return JSON.parse(raw);
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

  // Auth fields deliberately use React-generated IDs so their labels stay
  // correctly associated. Test the same accessible contract a user relies on
  // instead of coupling this flow to an implementation-specific ID.
  await page.getByLabel('Email').fill(testEmail);
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Log in' }).click();

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

  // The extension gets its own session (an `extension` token family), never
  // the dashboard's tokens. Sharing them meant whichever side refreshed second
  // looked like a replay, and the server signed both out.
  const web = await dashboardSession(page);
  expect(synapseSession.refresh_token).not.toBe(web.refresh_token);
  expect(synapseSession.user_id).toBe(web.user.id);

  const pong = await sendExternalMessage(page, extensionId, { type: 'SYNAPSE_PING' });
  expect(pong.user_id).toBe(web.user.id);

  await page.close();
});

test('dashboard and extension refresh independently and both stay signed in', async () => {
  const page = await context.newPage();
  await page.goto(`${FRONTEND_URL}/dashboard`);
  await expect(page).toHaveURL(/\/dashboard/);

  await wakeWorker();
  const extBefore = (await readStorage(worker(), 'synapseSession')).synapseSession;

  // Revisiting the dashboard must not mint another session: the ping says the
  // extension is already signed in as this user.
  await page.waitForTimeout(2_000);
  expect((await readStorage(worker(), 'synapseSession')).synapseSession.refresh_token)
    .toBe(extBefore.refresh_token);

  // The dashboard rotates its refresh token...
  const web = await dashboardSession(page);
  const webRes = await fetch(`${BACKEND_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: web.refresh_token }),
  });
  expect(webRes.status).toBe(200);
  const rotatedWeb = await webRes.json();
  // Keep the dashboard tab consistent with the server, as its own refresh would.
  await page.evaluate((v) => localStorage.setItem('synapse.session', JSON.stringify(v)), rotatedWeb);

  // ...and then the extension rotates its own. With a shared family this was
  // the replay that revoked everything.
  await writeStorage(worker(), {
    synapseSession: { ...extBefore, expires_at: Math.floor(Date.now() / 1000) - 10 },
  });
  const popup = await openPopup();
  const auth = await sendMessage(popup, { type: 'GET_AUTH_STATUS' });
  expect(auth).toMatchObject({ authenticated: true });
  const extAfter = (await readStorage(worker(), 'synapseSession')).synapseSession;
  expect(extAfter.refresh_token).not.toBe(extBefore.refresh_token);

  // The dashboard's rotated session is still alive too.
  const webAgain = await fetch(`${BACKEND_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rotatedWeb.refresh_token }),
  });
  expect(webAgain.status).toBe(200);
  await page.evaluate((v) => localStorage.setItem('synapse.session', JSON.stringify(v)), await webAgain.json());

  await popup.close();
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

test('consistent "too complex" feedback nudges the profile once and the popup says so', async () => {
  const page = await openPopup();

  // The save test above left chunk size "long". Since that change: one
  // "clearer", now "too complex" until the server reacts.
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await sendMessage(page, {
      type: 'FEEDBACK',
      entry: {
        ts: Date.now() + i,
        reaction: 'complex',
        note: '',
        timeSpentSeconds: 10,
        readProgress: null,
        sessionDifficulty: 'normal',
        sectionTitle: 'Explain',
      },
    }));
  }
  for (const r of results) expect(r).toMatchObject({ ok: true, synced: true });
  const nudges = results.filter((r) => r.profileUpdate);
  expect(nudges).toHaveLength(1);
  expect(nudges[0].profileUpdate.profile.chunk_size).toBe('medium');

  const { synapseSession } = await readStorage(worker(), 'synapseSession');
  const { body } = await backendProfile(synapseSession.access_token);
  expect(body.chunk_size).toBe('medium');

  // Mirrored locally, every entry marked synced, and the popup banner armed.
  const stored = await readStorage(worker(), ['cognitiveProfile', 'feedbackLog', 'pendingProfileUpdate']);
  expect(stored.cognitiveProfile.chunkSize).toBe('medium');
  expect(stored.feedbackLog.every((e) => e.synced !== false)).toBe(true);
  expect(stored.pendingProfileUpdate.message).toMatch(/simpler/);

  const history = await fetch(`${BACKEND_URL}/api/v1/profile/history?limit=1`, {
    headers: { Authorization: `Bearer ${synapseSession.access_token}` },
  }).then((r) => r.json());
  expect(history.data[0].change_summary).toMatch(/^Adjusted from your feedback/);

  await page.close();
  const popup = await openPopup();
  await expect(popup.locator('#update-banner')).toBeVisible();
  await expect(popup.locator('#update-msg')).toContainText('simpler');
  await popup.close();
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
  // The previous test revoked the extension's family only. The dashboard is
  // still signed in (proof the families are separate) and, on load, hands the
  // extension a fresh session because the ping reports none.
  await wakeWorker();
  const { synapseSession: beforeLogout } = await waitForStorage(
    worker(),
    'synapseSession',
    (s) => Boolean(s.synapseSession?.refresh_token),
    30_000
  );

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
