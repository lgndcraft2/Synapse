// Hands the Supabase session to the browser extension so it can act as the
// signed-in user without a separate login ("session handoff"). For this to work:
//   1. the extension must list this web origin in manifest "externally_connectable"
//   2. we must know the extension's ID (VITE_EXTENSION_ID)
// If either is missing (e.g. the extension isn't installed), every call is a safe no-op.

import type { Session } from './auth';

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID || '';
// Handed to the extension so it knows which API to refresh against. It
// previously received a Supabase URL and anon key; it now gets neither, so no
// API key ever leaves the dashboard.
const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

type ChromeRuntime = {
  sendMessage: (id: string, message: unknown, callback?: (response: unknown) => void) => void;
  lastError?: { message?: string };
};

function runtime(): ChromeRuntime | null {
  const chrome = (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  if (!EXTENSION_ID) return null;
  if (!chrome?.runtime?.sendMessage) return null;
  return chrome.runtime;
}

function send(message: unknown) {
  const rt = runtime();
  if (!rt) return;
  try {
    rt.sendMessage(EXTENSION_ID, message, () => {
      // Touch lastError so Chrome doesn't log "Unchecked runtime.lastError"
      // when the extension isn't installed / doesn't respond.
      void rt.lastError;
    });
  } catch {
    /* extension not installed or unreachable — ignore */
  }
}

export function pushSessionToExtension(session: Session | null) {
  if (!session?.access_token || !session.refresh_token) return;
  send({
    type: 'SYNAPSE_SESSION',
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    api_url: API_URL,
  });
}

export function pushLogoutToExtension() {
  send({ type: 'SYNAPSE_LOGOUT' });
}

export interface ExtensionInfo {
  installed: boolean;
  version?: string;
}

/**
 * Asks the extension whether it's there, and which version.
 *
 * Unlike the fire-and-forget senders above this reads the reply, so it needs
 * its own timeout: an uninstalled extension never calls back at all. "Not
 * installed" is a normal answer here, not an error — it's one of the most
 * useful things a support ticket can tell us.
 */
export function pingExtension(timeoutMs = 1200): Promise<ExtensionInfo> {
  return new Promise((resolve) => {
    const rt = runtime();
    if (!rt) {
      resolve({ installed: false });
      return;
    }

    let settled = false;
    const finish = (info: ExtensionInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    const timer = setTimeout(() => finish({ installed: false }), timeoutMs);

    try {
      rt.sendMessage(EXTENSION_ID, { type: 'SYNAPSE_PING' }, (response) => {
        clearTimeout(timer);
        // Touch lastError so Chrome doesn't log an unchecked-error warning.
        if (rt.lastError || !response) {
          finish({ installed: false });
          return;
        }
        const res = response as { ok?: boolean; installed?: boolean; version?: string };
        finish({ installed: Boolean(res.installed), version: res.version });
      });
    } catch {
      clearTimeout(timer);
      finish({ installed: false });
    }
  });
}
