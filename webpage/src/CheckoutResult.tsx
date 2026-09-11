import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { confirmCheckout } from './lib/api';
import { pushSessionToExtension } from './lib/extensionBridge';
import { PLAN_LABELS, formatDate, formatPrice, planByTier, priceFor } from './lib/plans';
import AppShell from './component/AppShell';

interface BillingInfo {
  plan: string;
  status: string;
  billing_period?: string | null;
  renews_at?: string | null;
  trial_ends_at?: string | null;
}

type State = 'confirming' | 'success' | 'failed' | 'cancelled';

function Badge({ icon, background, color }: { icon: string; background: string; color: string }) {
  return (
    <div
      className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
      style={{ backgroundColor: background, color }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 32 }}>
        {icon}
      </span>
    </div>
  );
}

export default function CheckoutResult() {
  const [user, setUser] = useState<any>(null);
  const [state, setState] = useState<State>('confirming');
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    async function run() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/auth?tab=login&next=${next}`;
        return;
      }
      setUser(user);

      // Stripe sends cancellations to /billing/cancelled with no session.
      if (window.location.pathname.startsWith('/billing/cancelled')) {
        setState('cancelled');
        return;
      }

      const id = new URLSearchParams(window.location.search).get('session_id');
      if (!id) {
        setError('We could not find a checkout session in this link.');
        setState('failed');
        return;
      }
      setSessionId(id);
      await confirm(id);
    }
    run();
  }, []);

  async function confirm(id: string) {
    try {
      // The endpoint is idempotent and returns the freshly-synced record, so
      // render straight from it rather than re-fetching the status.
      const result: BillingInfo = await confirmCheckout(id);
      setBilling(result);
      setState('success');
      setError(null);

      // Hand the refreshed session to the extension so the new tier applies
      // without the user having to sign in again there.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      pushSessionToExtension(session);

      // Drop session_id from the URL so a refresh doesn't re-confirm.
      window.history.replaceState({}, '', '/billing/success');
    } catch (err: any) {
      setError(err?.message || 'We could not confirm your payment.');
      setState('failed');
    }
  }

  async function retry() {
    if (!sessionId || isRetrying) return;
    setIsRetrying(true);
    setState('confirming');
    await confirm(sessionId);
    setIsRetrying(false);
  }

  const plan = planByTier(billing?.plan);
  const period = billing?.billing_period === 'annual' ? 'annual' : 'monthly';
  const price = plan ? priceFor(plan, period) : undefined;
  const planName = PLAN_LABELS[billing?.plan || ''] || plan?.name || 'your new plan';

  return (
    <AppShell user={user} backTo={{ href: '/dashboard', label: 'Back to dashboard' }}>
      <main
        className="flex-grow w-full mx-auto px-10 py-16 flex items-center justify-center"
        style={{ maxWidth: 1140 }}
      >
        <div
          className="rounded-xl p-8 shadow-tactile text-center w-full"
          style={{ backgroundColor: '#f6f3f2', border: '1px solid #3d3d38', maxWidth: 560 }}
        >
          {state === 'confirming' && (
            <>
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
                style={{ backgroundColor: '#e4e2e1', color: '#004635' }}
              >
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32 }}>
                  progress_activity
                </span>
              </div>
              <h1 className="font-serif font-bold mb-3" style={{ fontSize: 32, lineHeight: 1.2, color: '#1b1c1c' }}>
                Confirming your payment…
              </h1>
              <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b' }}>
                This only takes a moment. Don't close this tab.
              </p>
            </>
          )}

          {state === 'success' && (
            <>
              <Badge icon="check" background="#004635" color="#aef0d7" />
              <h1 className="font-serif font-bold mb-3" style={{ fontSize: 36, lineHeight: 1.15, color: '#1b1c1c' }}>
                You're on {planName}.
              </h1>
              <p className="text-lg mb-4" style={{ lineHeight: 1.6, color: '#5e5f5b' }}>
                {billing?.status === 'trialing' && billing?.trial_ends_at
                  ? `Your free trial is live until ${formatDate(billing.trial_ends_at)}${
                      price ? `, then it's ${formatPrice(price.amount)} ${period === 'annual' ? 'yearly' : 'monthly'}` : ''
                    }.`
                  : billing?.renews_at
                    ? `Your subscription is active and renews on ${formatDate(billing.renews_at)}.`
                    : 'Your subscription is active.'}
              </p>
              <p
                className="font-serif italic text-lg mb-8 pt-4"
                style={{ color: '#004635', lineHeight: 1.5, borderTop: '1px solid #e4e2e1' }}
              >
                Now go read something. Synapse will reshape it around the way you actually think.
              </p>
              <a
                href="/dashboard"
                className="block w-full rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
              >
                Go to dashboard
              </a>
              <p className="text-sm mt-4" style={{ color: '#5e5f5b' }}>
                A receipt is on its way to your inbox from Stripe.
              </p>
            </>
          )}

          {state === 'failed' && (
            <>
              <Badge icon="error" background="#ffdad6" color="#ba1a1a" />
              <h1 className="font-serif font-bold mb-3" style={{ fontSize: 32, lineHeight: 1.2, color: '#1b1c1c' }}>
                We couldn't confirm your payment.
              </h1>
              <p className="text-base mb-4" style={{ lineHeight: 1.6, color: '#5e5f5b' }}>
                {error}
              </p>
              <p
                className="text-sm mb-8 p-4 rounded text-left"
                style={{ backgroundColor: '#f0eded', color: '#5e5f5b', lineHeight: 1.6 }}
              >
                If you were charged, don't pay again — Stripe notifies us separately and your plan
                will update on its own within a minute. Refresh your dashboard to check.
              </p>
              <div className="flex flex-col gap-3">
                {sessionId && (
                  <button
                    className="w-full rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                    onClick={retry}
                    disabled={isRetrying}
                  >
                    {isRetrying ? 'Retrying…' : 'Try again'}
                  </button>
                )}
                <a
                  href="/dashboard"
                  className="block w-full rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                  style={{ border: '1px solid #004635', color: '#004635' }}
                >
                  Go to dashboard
                </a>
              </div>
            </>
          )}

          {state === 'cancelled' && (
            <>
              <Badge icon="undo" background="#e4e2e1" color="#5e5f5b" />
              <h1 className="font-serif font-bold mb-3" style={{ fontSize: 32, lineHeight: 1.2, color: '#1b1c1c' }}>
                Checkout cancelled.
              </h1>
              <p className="text-lg mb-8" style={{ lineHeight: 1.6, color: '#5e5f5b' }}>
                No charge was made and nothing changed. Your current plan is exactly where you left
                it — upgrade whenever you're ready.
              </p>
              <div className="flex flex-col gap-3">
                <a
                  href="/billing"
                  className="block w-full rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                  style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                >
                  View plans
                </a>
                <a
                  href="/dashboard"
                  className="block w-full rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                  style={{ border: '1px solid #004635', color: '#004635' }}
                >
                  Back to dashboard
                </a>
              </div>
            </>
          )}
        </div>
      </main>
    </AppShell>
  );
}
