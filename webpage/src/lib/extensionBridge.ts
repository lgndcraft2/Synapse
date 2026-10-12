// Signs the browser extension in as the dashboard's user, without a separate
// login ("session handoff"). The extension gets its own session; see
// pushSessionToExtension. For this to work:
//   1. the extension must list this web origin in manifest "externally_connectable"
//   2. we must know the extension's ID (VITE_EXTENSION_ID)
// If either is missing (e.g. the extension isn't installed), every call is a safe no-op.

import { getAccessToken, type Session } from './auth';
import { BACKEND_URL } from './config';

// Chrome gives one extension a different ID per install source: an unpacked
// copy's ID comes from its folder, the Web Store assigns its own. So this is a
// comma-separated list (e.g. the store ID plus a production build loaded
// unpacked), and the dashboard talks to whichever one answers.
const EXTENSION_IDS: string[] = String(import.meta.env.VITE_EXTENSION_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// Handed to the extension so it knows which API to refresh against. It
// previously received a Supabase URL and anon key; it now gets neither, so no
// API key ever leaves the dashboard.
const API_URL = BACKEND_URL;

type ChromeRuntime = {
  sendMessage: (id: string, message: unknown, callback?: (response: unknown) => void) => void;
  lastError?: { message?: string };
};

function runtime(): ChromeRuntime | null {
  const chrome = (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  if (!EXTENSION_IDS.length) return null;
  if (!chrome?.runtime?.sendMessage) return null;
  return chrome.runtime;
}

/** The ID that last answered a ping; messages go there. */
let installedId: string | null = null;

function send(message: unknown, ids: string[] = installedId ? [installedId] : EXTENSION_IDS) {
  const rt = runtime();
  if (!rt) return;
  for (const id of ids) {
    try {
      rt.sendMessage(id, message, () => {
        // Touch lastError so Chrome doesn't log "Unchecked runtime.lastError"
        // when the extension isn't installed / doesn't respond.
        void rt.lastError;
      });
    } catch {
      /* extension not installed or unreachable — ignore */
    }
  }
}

let handoffInFlight: Promise<void> | null = null;

/**
 * Signs the extension in as the dashboard's user.
 *
 * The extension gets its own session from /auth/extension-session, never the
 * dashboard's tokens: refresh tokens rotate, so two clients sharing one family
 * makes the second refresh look like a replay and the server signs both out.
 * Skipped when the extension already holds a session for this user, so a
 * dashboard visit doesn't mint a new session every time.
 */
export function pushSessionToExtension(session: Session | null): Promise<void> {
  if (!session?.access_token || !session.user?.id || !runtime()) return Promise.resolve();
  if (!handoffInFlight) {
    handoffInFlight = handOff(session.user.id).finally(() => {
      handoffInFlight = null;
    });
  }
  return handoffInFlight;
}

// Chrome puts an idle extension's service worker to sleep. Waking it while the
// dashboard is busy loading can take seconds, and a message sent mid-wake can
// fail outright, so one short ping would read a sleeping extension as "not
// installed" and the handoff would silently never happen.
const HANDOFF_PING_ATTEMPTS = 3;
const HANDOFF_PING_TIMEOUT_MS = 4000;
const HANDOFF_RETRY_DELAY_MS = 1000;

async function pingForHandoff(): Promise<ExtensionInfo> {
  let info: ExtensionInfo = { installed: false };
  for (let attempt = 0; attempt < HANDOFF_PING_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, HANDOFF_RETRY_DELAY_MS));
    info = await pingExtension(HANDOFF_PING_TIMEOUT_MS);
    if (info.installed) return info;
  }
  return info;
}

async function handOff(userId: string): Promise<void> {
  const info = await pingForHandoff();
  if (!info.installed || !info.id || info.userId === userId) return;

  const token = await getAccessToken();
  if (!token) return;

  let minted: Session;
  try {
    const response = await fetch(`${API_URL}/api/v1/auth/extension-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    minted = (await response.json()) as Session;
  } catch {
    return; // offline or API down; the next dashboard visit retries
  }

  send(
    {
      type: 'SYNAPSE_SESSION',
      access_token: minted.access_token,
      refresh_token: minted.refresh_token,
      expires_at: minted.expires_at ?? null,
      user_id: minted.user?.id ?? userId,
      api_url: API_URL,
    },
    [info.id],
  );
}

/** Every configured ID: signing out must reach whichever copy is installed. */
export function pushLogoutToExtension() {
  send({ type: 'SYNAPSE_LOGOUT' }, EXTENSION_IDS);
}

export interface ExtensionInfo {
  installed: boolean;
  /** Which configured extension ID answered. */
  id?: string;
  version?: string;
  /** The user the extension is signed in as, if any. */
  userId?: string | null;
}

function pingOne(rt: ChromeRuntime, id: string, timeoutMs: number): Promise<ExtensionInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info: ExtensionInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    const timer = setTimeout(() => finish({ installed: false }), timeoutMs);

    try {
      rt.sendMessage(id, { type: 'SYNAPSE_PING' }, (response) => {
        clearTimeout(timer);
        // Touch lastError so Chrome doesn't log an unchecked-error warning.
        if (rt.lastError || !response) {
          finish({ installed: false });
          return;
        }
        const res = response as { ok?: boolean; installed?: boolean; version?: string; user_id?: string | null };
        finish({ installed: Boolean(res.installed), id, version: res.version, userId: res.user_id ?? null });
      });
    } catch {
      clearTimeout(timer);
      finish({ installed: false });
    }
  });
}

/**
 * Asks the extension whether it's there, and which version.
 *
 * Unlike the fire-and-forget senders above this reads the reply, so it needs
 * its own timeout: an uninstalled extension never calls back at all. "Not
 * installed" is a normal answer here, not an error — it's one of the most
 * useful things a support ticket can tell us. Every configured ID is asked at
 * once; the first in the list that answers wins.
 */
export async function pingExtension(timeoutMs = 1200): Promise<ExtensionInfo> {
  const rt = runtime();
  if (!rt) return { installed: false };
  const answers = await Promise.all(EXTENSION_IDS.map((id) => pingOne(rt, id, timeoutMs)));
  const found = answers.find((a) => a.installed);
  if (found?.id) installedId = found.id;
  return found ?? { installed: false };
}
