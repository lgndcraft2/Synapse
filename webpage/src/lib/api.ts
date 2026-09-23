import { getAccessToken, clearSession, redirectToLogin } from './auth';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

/**
 * Bearer header for an authenticated call, or `{}` when signed out.
 *
 * Still returns `{}` rather than throwing, so the shape every other function
 * here depends on is unchanged. getAccessToken() transparently refreshes an
 * expiring token, and is single-flight, so the parallel calls several screens
 * fire on mount share one refresh instead of racing.
 */
async function getAuthHeader(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) return {};
  return { 'Authorization': `Bearer ${token}` };
}

/**
 * Handles a 401 once, centrally.
 *
 * Without this, an unrecoverable session surfaces as whichever of the ~19 API
 * calls happened to fire first, each with its own unrelated error toast. The
 * session is already gone by the time a 401 arrives — getAccessToken clears it
 * on a terminal refresh failure — so this is about getting the user to the
 * login screen rather than leaving them on a broken page.
 */
function handleUnauthorized(response: Response): void {
  if (response.status !== 401) return;
  clearSession();
  const here = window.location.pathname + window.location.search;
  // /auth itself 401ing must not bounce in a loop.
  if (!window.location.pathname.startsWith('/auth')) redirectToLogin(here);
}

/** fetch + the central 401 handler. Every call below goes through this. */
async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  handleUnauthorized(response);
  return response;
}

/**
 * One page of a list endpoint.
 *
 * `total` is null for sources that cannot count cheaply — Stripe's invoice
 * list is cursor-paginated and reports no total — so callers must handle its
 * absence rather than assume a page count. `next_cursor` is set only by those
 * cursor-paginated sources.
 */
export interface Paged<T> {
  data: T[];
  total: number | null;
  has_more: boolean;
  next_cursor?: string | null;
}

/** Serialises defined params only, so `?limit=10` never becomes `?limit=undefined`. */
function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export async function getBillingStatus() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/status`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error('Failed to fetch billing status');
  }

  return response.json();
}

export async function createCheckoutSession(priceId: string) {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/checkout`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_id: priceId,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Checkout failed' }));
    throw new Error(error.detail || 'Checkout failed');
  }

  const { checkout_url } = await response.json();
  return checkout_url;
}

export async function confirmCheckout(sessionId: string) {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/confirm`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_id: sessionId }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to confirm checkout' }));
    throw new Error(error.detail || 'Failed to confirm checkout');
  }

  return response.json();
}

/** Schedules cancellation at the end of the current billing period. */
export async function cancelSubscription() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/cancel`, {
    method: 'POST',
    headers: authHeaders,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to cancel subscription' }));
    throw new Error(error.detail || 'Failed to cancel subscription');
  }

  return response.json();
}

/** Clears a scheduled cancellation so the subscription renews as normal. */
export async function resumeSubscription() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/resume`, {
    method: 'POST',
    headers: authHeaders,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to resume subscription' }));
    throw new Error(error.detail || 'Failed to resume subscription');
  }

  return response.json();
}

/** Moves an existing subscription to a different price, prorated by Stripe. */
export async function changePlan(priceId: string) {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/change-plan`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ price_id: priceId }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to change plan' }));
    throw new Error(error.detail || 'Failed to change plan');
  }

  return response.json();
}

/** Cursor-paged: pass the previous page's `next_cursor` as `starting_after`. */
export async function getInvoices(
  params: { limit?: number; starting_after?: string | null } = {},
): Promise<Paged<any>> {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(
    `${BACKEND_URL}/api/v1/billing/invoices${query(params)}`,
    { headers: authHeaders },
  );

  if (!response.ok) {
    throw new Error('Failed to fetch billing history');
  }

  return response.json();
}

export async function getPaymentMethod() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/payment-method`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch payment method');
  }

  return response.json();
}

export async function getUsage() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/usage`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch usage');
  }

  return response.json();
}

export async function openCustomerPortal() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/billing/portal`, {
    method: 'POST',
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to open billing portal');
  }

  const { portal_url } = await response.json();
  return portal_url;
}

export async function getDashboardStats() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/dashboard/stats`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch dashboard stats');
  }

  return response.json();
}

/** Internal aggregate traffic and account metrics for authorised operators. */
export async function getObserverOverview() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/observer/overview`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to fetch observer data' }));
    throw new Error(error.detail || 'Failed to fetch observer data');
  }

  return response.json();
}

/**
 * One page of reading sessions. The aggregate /dashboard/stats payload still
 * carries `recent_sessions` for other callers; the dashboard list reads this.
 */
export async function getReadingSessions(
  params: { limit?: number; offset?: number } = {},
): Promise<Paged<any>> {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(
    `${BACKEND_URL}/api/v1/dashboard/sessions${query(params)}`,
    { headers: authHeaders },
  );

  if (!response.ok) {
    throw new Error('Failed to fetch reading sessions');
  }

  return response.json();
}

export async function getProfile() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/profile`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error('Failed to fetch profile');
  }

  return response.json();
}

export async function updateProfile(update: Record<string, unknown>) {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/profile`, {
    method: 'PATCH',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(update),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to update profile' }));
    throw new Error(error.detail || 'Failed to update profile');
  }

  return response.json();
}

/** Permanently deletes the account: Stripe subscription, local rows, auth user. */
export async function deleteAccount() {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/auth/account`, {
    method: 'DELETE',
    headers: authHeaders,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to delete account' }));
    throw new Error(error.detail || 'Failed to delete account');
  }

  return true;
}

/**
 * Files a support ticket. Auth is optional — anonymous callers must pass an
 * email so the ticket is answerable.
 */
export async function createSupportTicket(ticket: {
  topic: string;
  subject: string;
  message: string;
  email?: string;
  diagnostics?: Record<string, unknown> | null;
}) {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(`${BACKEND_URL}/api/v1/support/tickets`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(ticket),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to send your ticket' }));
    throw new Error(error.detail || 'Failed to send your ticket');
  }

  return response.json();
}

export async function getMyTickets(
  params: { limit?: number; offset?: number } = {},
): Promise<Paged<any>> {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(
    `${BACKEND_URL}/api/v1/support/tickets${query(params)}`,
    { headers: authHeaders },
  );

  if (!response.ok) {
    throw new Error('Failed to fetch your tickets');
  }

  return response.json();
}

export async function getProfileHistory(
  params: { limit?: number; offset?: number } = {},
): Promise<Paged<any>> {
  const authHeaders = await getAuthHeader();
  const response = await authedFetch(
    `${BACKEND_URL}/api/v1/profile/history${query(params)}`,
    { headers: authHeaders },
  );

  if (!response.ok) {
    throw new Error('Failed to fetch profile history');
  }

  return response.json();
}
