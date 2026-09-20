/**
 * Session handling for the dashboard.
 *
 * Replaces supabase-js. The shape is deliberately small: a token pair plus the
 * user, persisted to localStorage, with a refresh that transparently rotates
 * before the access token expires.
 *
 * Two things here are load-bearing rather than stylistic:
 *
 *   1. `getAccessToken()` is single-flight. The backend rotates the refresh
 *      token on every use and treats a second presentation of a spent token as
 *      theft, revoking the whole session family. Several components call the
 *      API on mount simultaneously, so without one shared in-flight promise
 *      they would each present the same refresh token and sign the user out.
 *   2. Sessions are mirrored across tabs via the `storage` event, so signing
 *      out in one tab propagates — the job `onAuthStateChange` used to do.
 *
 * On localStorage: this is parity with what supabase-js already did, not a
 * regression. An HttpOnly cookie would be stronger against XSS, but the
 * browser-extension handoff requires JS-readable tokens, so cookies would mean
 * maintaining two auth paths. The exposure is bounded by the 15-minute access
 * token lifetime and by server-side reuse detection.
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

/**
 * Whether the app has been told where its API lives.
 *
 * With Supabase gone this is the one setting that breaks everything if wrong,
 * so ConfigBanner surfaces it on every page. The fallback above keeps local
 * development working without a .env at all, which is why this reports on the
 * raw variable rather than on BACKEND_URL.
 */
export const isBackendConfigured = Boolean(import.meta.env.VITE_BACKEND_URL);

const STORAGE_KEY = 'synapse.session';
const AUTH_EVENT = 'synapse:auth';

/** Refresh this many seconds before expiry, so an in-flight request never carries a just-expired token. */
const REFRESH_SKEW_SECONDS = 60;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  plan: string;
  created_at: string;
  auth_provider: 'password' | 'google' | 'both';
  email_verified: boolean;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Absolute unix seconds. */
  expires_at: number;
  user: AuthUser;
}

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'auth_error', status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── Storage ───────────────────────────────────────────────────────

let cached: Session | null | undefined;

function read(): Session | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    // Private mode, blocked site data, or corrupt JSON. Treat as signed out
    // rather than throwing on every read.
    cached = null;
  }
  return cached;
}

function write(session: Session | null): void {
  cached = session;
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — the in-memory copy still serves this tab */
  }
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: session }));
}

export function getSession(): Session | null {
  return read();
}

export function getUser(): AuthUser | null {
  return read()?.user ?? null;
}

export function setSession(session: Session): void {
  write(session);
}

export function clearSession(): void {
  write(null);
}

/**
 * Subscribe to sign-in/sign-out. Returns an unsubscribe function.
 *
 * Listens for both the in-tab custom event and the cross-tab `storage` event,
 * so a sign-out anywhere reaches every open tab.
 */
export function subscribeAuth(callback: (session: Session | null) => void): () => void {
  const onLocal = (event: Event) => callback((event as CustomEvent).detail ?? null);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = undefined; // force a re-read; another tab wrote this
    callback(read());
  };

  window.addEventListener(AUTH_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(AUTH_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

// ── Requests ──────────────────────────────────────────────────────

async function request<T>(
  method: 'POST' | 'PATCH' | 'GET',
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AuthError(
      `Backend server unreachable. Please ensure the backend is running at ${BACKEND_URL}`,
      'network',
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // FastAPI puts our structured errors in `detail`, which is either a string
    // or the {code, message} object the auth routes return.
    const detail = payload?.detail;
    if (detail && typeof detail === 'object') {
      throw new AuthError(detail.message || 'Request failed', detail.code, response.status);
    }
    throw new AuthError(
      typeof detail === 'string' ? detail : 'Request failed',
      'request_failed',
      response.status,
    );
  }

  return payload as T;
}

const post = <T>(path: string, body?: unknown, token?: string) =>
  request<T>('POST', path, body, token);

// ── Token refresh ─────────────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(refreshToken: string): Promise<string | null> {
  try {
    const session = await post<Session>('/api/v1/auth/refresh', {
      refresh_token: refreshToken,
    });
    write(session);
    return session.access_token;
  } catch (err) {
    const code = err instanceof AuthError ? err.code : '';
    // A revoked or expired session is terminal — clear it so the app stops
    // retrying a token the server will never accept again. A network blip is
    // not, so the session survives to be retried.
    if (code === 'session_revoked' || code === 'refresh_expired' || code === 'invalid_refresh_token') {
      clearSession();
    }
    return null;
  }
}

/**
 * The access token for an API call, refreshing first if it is about to expire.
 *
 * Single-flight: concurrent callers share one refresh rather than each
 * presenting the same refresh token, which the server would read as replay.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = read();
  if (!session) return null;

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at - REFRESH_SKEW_SECONDS > now) {
    return session.access_token;
  }

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(session.refresh_token).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// ── Flows ─────────────────────────────────────────────────────────

export async function signUp(
  email: string,
  password: string,
  name?: string,
): Promise<{ status: string; message: string }> {
  return post('/api/v1/auth/register', { email, password, name });
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await post<Session>('/api/v1/auth/login', { email, password });
  write(session);
  return session;
}

export async function verifyEmail(token: string): Promise<Session> {
  const session = await post<Session>('/api/v1/auth/verify-email/confirm', { token });
  write(session);
  return session;
}

export async function resendVerification(email: string): Promise<void> {
  await post('/api/v1/auth/verify-email/resend', { email });
}

export async function forgotPassword(email: string): Promise<void> {
  await post('/api/v1/auth/password/forgot', { email });
}

export async function resetPassword(token: string, password: string): Promise<Session> {
  const session = await post<Session>('/api/v1/auth/password/reset', { token, password });
  write(session);
  return session;
}

/** Trade the one-time code from the Google redirect for a session. */
export async function exchangeOAuthCode(code: string): Promise<Session> {
  const session = await post<Session>('/api/v1/auth/google/exchange', { code });
  write(session);
  return session;
}

/**
 * Begin Google sign-in.
 *
 * A full-page navigation, not fetch(): the browser must accept the state
 * cookie and then follow a cross-origin redirect, and Google will not serve
 * its consent screen to XHR.
 */
export function startGoogleLogin(next: string): void {
  const url = `${BACKEND_URL}/api/v1/auth/google/start?next=${encodeURIComponent(next)}`;
  window.location.href = url;
}

/**
 * Sign out.
 *
 * Tells the backend first so the refresh token is actually revoked — Supabase
 * used to do that server-side. Local state is cleared regardless, because a
 * failed network call must never leave someone stuck signed in.
 */
export async function signOut(): Promise<void> {
  const session = read();
  if (session?.refresh_token) {
    try {
      await post('/api/v1/auth/logout', { refresh_token: session.refresh_token });
    } catch {
      /* best effort */
    }
  }
  clearSession();
}

export async function updateName(name: string): Promise<AuthUser> {
  const token = await getAccessToken();
  const user = await request<AuthUser>('PATCH', '/api/v1/auth/me', { name }, token ?? undefined);
  const session = read();
  if (session) write({ ...session, user });
  return user;
}

/**
 * Guard for authenticated screens.
 *
 * Resolves from local state immediately so the shell can render without a
 * flash, then confirms with the server in the background — a locally valid but
 * server-revoked session would otherwise render the whole dashboard before the
 * first API call failed.
 */
export async function requireAuth(next?: string): Promise<AuthUser | null> {
  const session = read();
  if (!session) {
    redirectToLogin(next);
    return null;
  }

  const token = await getAccessToken();
  if (!token) {
    redirectToLogin(next);
    return null;
  }
  return session.user;
}

export function redirectToLogin(next?: string): void {
  const suffix = next ? `&next=${encodeURIComponent(next)}` : '';
  window.location.href = `/auth?tab=login${suffix}`;
}
