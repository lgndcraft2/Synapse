import { supabase } from './supabase';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://api.synapseos.app';

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { 'Authorization': `Bearer ${session.access_token}` };
}

export async function syncUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const authHeaders = await getAuthHeader();
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/auth/sync`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        supabase_uid: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.email?.split('@')[0],
        avatar_url: user.user_metadata?.avatar_url,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Sync failed' }));
      throw new Error(error.detail || 'Sync failed');
    }

    return response.json();
  } catch (err: any) {
    if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      throw new Error('Backend server unreachable. Please ensure the backend is running at ' + BACKEND_URL);
    }
    throw err;
  }
}

export async function getBillingStatus() {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${BACKEND_URL}/api/v1/billing/status`, {
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
  const response = await fetch(`${BACKEND_URL}/api/v1/billing/checkout`, {
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

export async function openCustomerPortal() {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${BACKEND_URL}/api/v1/billing/portal`, {
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
  const response = await fetch(`${BACKEND_URL}/api/v1/dashboard/stats`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch dashboard stats');
  }

  return response.json();
}

export async function getProfile() {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${BACKEND_URL}/api/v1/profile`, {
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
  const response = await fetch(`${BACKEND_URL}/api/v1/profile`, {
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

export async function getProfileHistory() {
  const authHeaders = await getAuthHeader();
  const response = await fetch(`${BACKEND_URL}/api/v1/profile/history`, {
    headers: authHeaders,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch profile history');
  }

  return response.json();
}
