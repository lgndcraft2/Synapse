import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { createCheckoutSession, getBillingStatus } from './lib/api';
import {
  PLANS,
  PLAN_LABELS,
  TRIAL_DAYS,
  annualAvailable,
  formatDate,
  formatPrice,
  formatPriceShort,
  periodNoun,
  periodSuffix,
  planByTier,
  priceFor,
  priceIdFor,
  trialEndDate,
  type BillingPeriod,
  type Plan,
} from './lib/plans';
import AppShell from './component/AppShell';
import { Skeleton } from './component/ui';

interface BillingInfo {
  plan: string;
  status: string;
  billing_period?: string | null;
  cancel_at_period_end?: boolean;
  renews_at?: string | null;
  trial_ends_at?: string | null;
  stripe_customer_id?: string | null;
}

type Step = 'plans' | 'review';

const CARD: React.CSSProperties = {
  backgroundColor: '#f6f3f2',
  border: '1px solid #3d3d38',
};

function Check() {
  return (
    <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: 18, color: '#004635' }}>
      check
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="block text-xs font-semibold uppercase"
      style={{ color: '#5e5f5b', letterSpacing: '0.08em' }}
    >
      {children}
    </span>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded p-4 mt-4 flex items-start gap-3 text-sm"
      style={{ backgroundColor: '#ffdad6', color: '#ba1a1a' }}
      role="alert"
    >
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: 18 }}>
        error
      </span>
      <span>{message}</span>
    </div>
  );
}

export default function Billing() {
  const [user, setUser] = useState<any>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [step, setStep] = useState<Step>('plans');
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [selected, setSelected] = useState<Plan | null>(null);

  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        // Come back here once they're signed in.
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/auth?tab=login&next=${next}`;
        return;
      }
      setUser(user);

      let status: BillingInfo | null = null;
      try {
        status = await getBillingStatus();
        setBilling(status);
      } catch (err) {
        // A missing billing row just means "free" — never blank the page over it.
        console.error('Failed to load billing status', err);
      }

      // ?plan=premium deep-links straight to the order summary — that's what
      // the dashboard's Upgrade link and the landing page's CTAs point at.
      // Skip it when it's the plan they're already on, so they land on the
      // grid (where it reads "Current plan") instead of a pointless re-purchase.
      const requested = new URLSearchParams(window.location.search).get('plan');
      const preselected = planByTier(requested);
      if (preselected?.monthly && preselected.tier !== (status?.plan || 'free')) {
        setSelected(preselected);
        setStep('review');
      }

      setIsLoading(false);
    }
    load();
  }, []);

  const currentTier = billing?.plan || 'free';
  const isPaid = currentTier !== 'free';
  const canManage = isPaid || Boolean(billing?.stripe_customer_id);

  async function handleCheckout() {
    if (!selected || isRedirecting) return;
    const priceId = priceIdFor(selected, period);
    if (!priceId) {
      setError(
        `${selected.name} isn't available for ${periodNoun(period)}ly billing yet. Pick another option, or let us know at /support.`,
      );
      return;
    }

    setError(null);
    setIsRedirecting(true);
    try {
      window.location.href = await createCheckoutSession(priceId);
    } catch (err: any) {
      setError(err?.message || 'We could not start checkout. Please try again.');
      setIsRedirecting(false);
    }
  }

  function choose(plan: Plan) {
    setSelected(plan);
    setError(null);
    setStep('review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <AppShell user={user} backTo={{ href: '/dashboard', label: 'Back to dashboard' }}>
      <main className="flex-grow w-full mx-auto px-10 py-16" style={{ maxWidth: 1140 }}>
        {step === 'plans'
          ? renderPlans()
          : renderReview()}
      </main>
    </AppShell>
  );

  // ── Step 1: the plans ───────────────────────────────────────────────
  function renderPlans() {
    return (
      <>
        <section className="mb-10">
          <h1
            className="font-serif font-bold mb-4"
            style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#1b1c1c' }}
          >
            Choose your flow.
          </h1>
          <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b', maxWidth: 620 }}>
            No diagnosis required. No data sold. Ever. Every paid plan starts with a{' '}
            {TRIAL_DAYS}-day free trial, and you can cancel before it ends without being charged.
          </p>
        </section>

        {/* Current plan */}
        <section className="p-5 rounded shadow-tactile mb-10" style={{ backgroundColor: '#f0eded', border: '1px solid #3d3d38' }}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-semibold uppercase" style={{ color: '#5e5f5b', letterSpacing: '0.05em' }}>
              Your plan
            </span>
            <span
              className="text-xs px-2 py-0.5 rounded font-semibold uppercase"
              style={{ backgroundColor: isPaid ? '#004635' : '#5e5f5b', color: '#ffffff' }}
            >
              {isLoading ? <Skeleton style={{ width: 72, height: 14 }} /> : PLAN_LABELS[currentTier] || currentTier}
            </span>
          </div>
          <div className="flex justify-between items-end gap-4 flex-wrap">
            <div>
              {isLoading ? (
                <>
                  <Skeleton style={{ width: 128, height: 20 }} />
                  <Skeleton style={{ width: 176, height: 16, marginTop: 8 }} />
                </>
              ) : (
                <>
                  <p className="font-medium" style={{ color: '#1b1c1c' }}>
                    {billing?.cancel_at_period_end
                      ? 'Ending soon'
                      : billing?.status === 'trialing'
                        ? 'Free trial'
                        : billing?.status === 'past_due'
                          ? 'Payment overdue'
                          : isPaid
                            ? `${billing?.billing_period === 'annual' ? 'Annual' : 'Monthly'} access`
                            : 'Free tier'}
                  </p>
                  <p className="text-sm mt-1" style={{ color: '#5e5f5b' }}>
                    {billing?.cancel_at_period_end && billing?.renews_at
                      ? `Access ends ${formatDate(billing.renews_at)}`
                      : billing?.renews_at
                        ? `Renews on ${formatDate(billing.renews_at)}`
                        : billing?.trial_ends_at
                          ? `Trial ends ${formatDate(billing.trial_ends_at)}`
                          : 'Free tier limits apply'}
                  </p>
                </>
              )}
            </div>
            {canManage && !isLoading && (
              <a
                href="/subscription"
                className="text-sm font-semibold hover:underline"
                style={{ color: '#004635' }}
              >
                Manage subscription
              </a>
            )}
          </div>
          {error && <ErrorPanel message={error} />}
        </section>

        {/* Billing period toggle — hidden until annual prices are configured. */}
        {annualAvailable && (
          <section className="mb-8">
            <div
              className="inline-flex items-center gap-4 p-2 rounded-xl shadow-tactile"
              style={CARD}
            >
              <span
                className="text-xs font-semibold uppercase tracking-wider ml-2"
                style={{ color: '#5e5f5b', letterSpacing: '0.05em' }}
              >
                Billing period
              </span>
              <div className="flex gap-1">
                {(['monthly', 'annual'] as BillingPeriod[]).map((value) => (
                  <button
                    key={value}
                    onClick={() => setPeriod(value)}
                    className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                    style={
                      period === value
                        ? { backgroundColor: '#004635', color: '#ffffff', border: 0 }
                        : { color: '#5e5f5b', backgroundColor: 'transparent', border: 0 }
                    }
                  >
                    {value === 'monthly' ? 'Monthly' : 'Annual · 2 months free'}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Plan cards */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          {PLANS.map((plan) => {
            const price = priceFor(plan, period);
            const isCurrent = plan.tier === currentTier;
            const isFree = plan.tier === 'free';
            const featured = Boolean(plan.featured);

            return (
              <article
                key={plan.tier}
                className="rounded-xl p-8 shadow-tactile relative overflow-hidden flex flex-col"
                style={{
                  backgroundColor: '#f6f3f2',
                  border: featured ? '2px solid #004635' : '1px solid #3d3d38',
                }}
              >
                {featured && (
                  <span
                    className="absolute top-0 right-0 text-xs font-semibold uppercase px-3 py-1"
                    style={{ backgroundColor: '#004635', color: '#aef0d7', letterSpacing: '0.08em' }}
                  >
                    Recommended
                  </span>
                )}

                <Eyebrow>{plan.tier === 'free' ? 'Free forever' : 'Paid plan'}</Eyebrow>
                <h2 className="font-serif font-semibold mt-2" style={{ fontSize: 28, lineHeight: 1.2, color: '#004635' }}>
                  {plan.name}
                </h2>
                <p className="text-sm mt-1 mb-4" style={{ color: '#5e5f5b' }}>
                  {plan.tagline}
                </p>

                <div className="flex items-baseline gap-1 mb-6">
                  <span className="font-serif font-bold" style={{ fontSize: 40, lineHeight: 1, color: '#1b1c1c' }}>
                    {isFree || !price ? 'Free' : formatPriceShort(price.amount)}
                  </span>
                  {!isFree && price && (
                    <span className="text-sm font-semibold" style={{ color: '#5e5f5b' }}>
                      {periodSuffix(period)}
                    </span>
                  )}
                </div>

                <ul className="space-y-2 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm" style={{ color: '#1b1c1c' }}>
                      <Check />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.note && (
                  <p className="text-xs mb-4" style={{ color: '#5e5f5b' }}>
                    {plan.note}
                  </p>
                )}

                <div className="mt-auto">
                  {isCurrent ? (
                    <button
                      className="w-full rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                      style={{
                        border: '1px solid #707974',
                        color: '#5e5f5b',
                        backgroundColor: 'transparent',
                        cursor: 'default',
                      }}
                      disabled
                    >
                      Current plan
                    </button>
                  ) : isFree ? (
                    <a
                      href="/dashboard"
                      className="block w-full text-center rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                      style={{ border: '1px solid #004635', color: '#004635' }}
                    >
                      Keep exploring
                    </a>
                  ) : (
                    <button
                      className="w-full rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                      style={
                        featured
                          ? { backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }
                          : { backgroundColor: 'transparent', color: '#004635', border: '1px solid #004635' }
                      }
                      onClick={() => choose(plan)}
                    >
                      {isPaid ? 'Switch to this plan' : 'Select plan'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        {/* Trust strip */}
        <section className="flex flex-wrap gap-6 pt-6" style={{ borderTop: '1px solid #e4e2e1' }}>
          {[
            ['event_available', `${TRIAL_DAYS}-day free trial`],
            ['cancel', 'Cancel anytime'],
            ['lock', 'Payments secured by Stripe'],
          ].map(([icon, label]) => (
            <span key={label} className="flex items-center gap-2 text-sm" style={{ color: '#5e5f5b' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#004635' }}>
                {icon}
              </span>
              {label}
            </span>
          ))}
        </section>
      </>
    );
  }

  // ── Step 2: the order summary ───────────────────────────────────────
  function renderReview() {
    if (!selected) return null;
    const price = priceFor(selected, period);
    const amount = price?.amount ?? 0;
    const noun = periodNoun(period);
    const firstCharge = formatDate(trialEndDate());

    return (
      <>
        <section className="mb-10">
          <Eyebrow>Step 2 of 2</Eyebrow>
          <h1
            className="font-serif font-bold mt-2 mb-4"
            style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#1b1c1c' }}
          >
            Review your order.
          </h1>
          <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b', maxWidth: 620 }}>
            Nothing is charged today. We'll hand you to Stripe to save a payment method, and your
            trial starts the moment you're back.
          </p>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
          {/* Order summary */}
          <section className="md:col-span-7">
            <div className="rounded-xl p-8 shadow-tactile relative overflow-hidden" style={CARD}>
              <div
                className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-50"
                style={{ backgroundColor: '#e4e2e1', zIndex: 0 }}
              />

              <div className="relative">
                <Eyebrow>Order summary</Eyebrow>

                <div className="flex justify-between items-baseline gap-4 mt-4 mb-6">
                  <h2 className="font-serif font-semibold" style={{ fontSize: 32, lineHeight: 1.2, color: '#004635' }}>
                    {selected.name}
                  </h2>
                  <span className="font-semibold shrink-0" style={{ color: '#1b1c1c' }}>
                    {formatPrice(amount)} / {noun}
                  </span>
                </div>

                <div className="space-y-3 pb-3">
                  <div className="flex justify-between items-center text-sm">
                    <span style={{ color: '#1b1c1c' }}>Subscription, billed {noun}ly</span>
                    <span style={{ color: '#1b1c1c' }}>{formatPrice(amount)}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="flex items-center gap-2" style={{ color: '#004635' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                        redeem
                      </span>
                      {TRIAL_DAYS}-day free trial
                    </span>
                    <span style={{ color: '#004635' }}>−{formatPrice(amount)}</span>
                  </div>
                </div>

                <div className="flex justify-between items-baseline pt-4" style={{ borderTop: '1px solid #3d3d38' }}>
                  <span className="text-xs font-semibold uppercase" style={{ color: '#5e5f5b', letterSpacing: '0.08em' }}>
                    Due today
                  </span>
                  <span className="font-serif font-bold" style={{ fontSize: 40, lineHeight: 1, color: '#004635' }}>
                    $0.00
                  </span>
                </div>
                <p className="text-sm mt-2" style={{ color: '#5e5f5b' }}>
                  Then {formatPrice(amount)} {noun}ly, starting {firstCharge}. Cancel any time before
                  then and you won't be charged.
                </p>

                <button
                  className="w-full rounded px-4 py-4 mt-6 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80 flex items-center justify-center gap-2"
                  style={{
                    backgroundColor: '#004635',
                    color: '#ffffff',
                    border: '1px solid #004635',
                    opacity: isRedirecting ? 0.6 : 1,
                    cursor: isRedirecting ? 'default' : 'pointer',
                  }}
                  onClick={handleCheckout}
                  disabled={isRedirecting}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    lock
                  </span>
                  {isRedirecting ? 'Redirecting to Stripe…' : 'Proceed to secure checkout'}
                </button>

                {error && <ErrorPanel message={error} />}

                <button
                  className="mt-4 text-sm font-semibold hover:underline flex items-center gap-1"
                  style={{ color: '#004635', background: 'none', border: 0, padding: 0 }}
                  onClick={() => {
                    setStep('plans');
                    setError(null);
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    arrow_back
                  </span>
                  Change plan
                </button>
              </div>
            </div>
          </section>

          {/* What you get */}
          <section className="md:col-span-4 md:col-start-9">
            <h3 className="font-serif font-semibold text-2xl mb-4 pb-2" style={{ borderBottom: '1px solid #e4e2e1', color: '#1b1c1c' }}>
              What you unlock
            </h3>
            <ul className="space-y-3 mb-6">
              {selected.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm" style={{ color: '#1b1c1c' }}>
                  <Check />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <div className="p-5 rounded shadow-tactile" style={{ backgroundColor: '#f0eded', border: '1px solid #3d3d38' }}>
              <p className="text-sm" style={{ color: '#5e5f5b' }}>
                You can cancel or switch plans any time from your dashboard. Your cognitive profile
                stays yours either way.
              </p>
            </div>
          </section>
        </div>
      </>
    );
  }
}
