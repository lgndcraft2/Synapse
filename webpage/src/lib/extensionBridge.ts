// Hands the Supabase session to the browser extension so it can act as the
// signed-in user without a separate login ("session handoff"). For this to work:
//   1. the extension must list this web origin in manifest "externally_connectable"
//   2. we must know the extension's ID (VITE_EXTENSION_ID)
// If either is missing (e.g. the extension isn't installed), every call is a safe no-op.

import type { Session } from '@supabase/supabase-js';

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID || '';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

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
    supabase_url: SUPABASE_URL,
    supabase_anon_key: SUPABASE_ANON_KEY,
  });
}

export function pushLogoutToExtension() {
  send({ type: 'SYNAPSE_LOGOUT' });
}
