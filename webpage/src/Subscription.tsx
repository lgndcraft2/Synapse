import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import {
  cancelSubscription,
  changePlan,
  getBillingStatus,
  getInvoices,
  getPaymentMethod,
  getUsage,
  openCustomerPortal,
  resumeSubscription,
} from './lib/api';
import {
  PLANS,
  PLAN_LABELS,
  formatDate,
  formatPrice,
  periodNoun,
  planByTier,
  priceFor,
  priceIdFor,
  type BillingPeriod,
  type Plan,
} from './lib/plans';
import AppShell from './component/AppShell';
import { CARD, INSET, Eyebrow, Notice, Pager, Section, Skeleton } from './component/ui';

interface BillingInfo {
  plan: string;
  status: string;
  billing_period?: string | null;
  cancel_at_period_end?: boolean;
  trial_ends_at?: string | null;
  renews_at?: string | null;
  cancelled_at?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}

interface Invoice {
  id: string;
  number?: string | null;
  created: string;
  amount_paid: number;
  amount_due: number;
  currency: string;
  status?: string | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
}

interface PaymentMethod {
  brand?: string | null;
  last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
}

interface Usage {
  plan: string;
  unlimited: boolean;
  limit_type: string;
  used: number;
  limit?: number | null;
  remaining?: number | null;
  resets_at?: string | null;
  lifetime_used?: number | null;
  lifetime_limit?: number | null;
}

/** Status chip. Cancelling is its own state — it is not the same as active. */
function StatusChip({ billing, loading }: { billing: BillingInfo | null; loading: boolean }) {
  // Hold the chip's footprint while billing loads, so the plan heading beside
  // it doesn't reflow once the status lands. This one corner of the card sits
  // under a decorative disc in --surface-variant, which the default skeleton
  // tone matches almost exactly — so this placeholder goes a shade darker to
  // stay visible. The loaded chip has no such problem: it is always solid.
  if (loading) {
    return <Skeleton style={{ width: 74, height: 20, borderRadius: 4, backgroundColor: '#c8c6c0' }} />;
  }
  if (!billing) return null;
  const cancelling = Boolean(billing.cancel_at_period_end);
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    trialing: { label: 'Free trial', bg: '#1b5e4b', fg: '#ffffff' },
    active: { label: 'Active', bg: '#004635', fg: '#ffffff' },
    past_due: { label: 'Payment failed', bg: '#ba1a1a', fg: '#ffffff' },
    cancelled: { label: 'Cancelled', bg: '#5e5f5b', fg: '#ffffff' },
  };
  const chip = cancelling
    ? { label: 'Ending', bg: '#8a4b24', fg: '#ffffff' }
    : map[billing.status] || { label: billing.status, bg: '#5e5f5b', fg: '#ffffff' };

  return (
    <span
      className="text-xs px-2 py-0.5 rounded font-semibold uppercase shrink-0"
      style={{ backgroundColor: chip.bg, color: chip.fg, letterSpacing: '0.05em' }}
    >
      {chip.label}
    </span>
  );
}

const INVOICES_PER_PAGE = 5;

export default function Subscription() {
  const [user, setUser] = useState<any>(null);
  // False until the session has been read — see AppHeaderProps.authChecked.
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  // Stripe pages by cursor and reports no total, so Prev is served by keeping
  // the cursor that opened each page we have visited. cursors[0] is page 1's
  // (always undefined); its length is the current page number.
  const [invoiceCursors, setInvoiceCursors] = useState<(string | undefined)[]>([undefined]);
  const [invoiceHasMore, setInvoiceHasMore] = useState(false);
  const [invoicesBusy, setInvoicesBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [card, setCard] = useState<PaymentMethod | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  // Each panel tracks its own load, so a slow Stripe call can't hold the whole
  // screen on "Loading…" the way a single shared flag would.
  const [loading, setLoading] = useState({
    billing: true,
    invoices: true,
    card: true,
    usage: true,
  });
  const isLoading = loading.billing;

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingPlan, setConfirmingPlan] = useState<
    { tier: string; name: string; priceId: string; isUpgrade: boolean } | null
  >(null);
  const [busy, setBusy] = useState<null | 'cancel' | 'resume' | 'portal' | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        const next = encodeURIComponent(window.location.pathname);
        window.location.href = `/auth?tab=login&next=${next}`;
        return;
      }
      setUser(user);
      setCheckedAuth(true);

      // Fire all four together but render each as it lands, so a slow Stripe
      // round trip doesn't hold up the panels that are already answerable.
      const done = (key: keyof typeof loading) =>
        setLoading((prev) => ({ ...prev, [key]: false }));

      const settle = <T,>(p: Promise<T>, key: keyof typeof loading, apply: (v: T) => void) =>
        p
          .then(apply)
          .catch((err) => console.error(`Subscription ${key} load error`, err))
          .finally(() => done(key));

      await Promise.all([
        settle(getBillingStatus(), 'billing', setBilling),
        settle(getInvoices({ limit: INVOICES_PER_PAGE }), 'invoices', (v) => {
          setInvoices(v.data || []);
          setInvoiceHasMore(Boolean(v.has_more));
          setInvoiceCursors([undefined, v.next_cursor || undefined]);
        }),
        settle(getPaymentMethod(), 'card', setCard),
        settle(getUsage(), 'usage', setUsage),
      ]);
    }
    load();
  }, []);

  const tier = billing?.plan || 'free';
  const plan = planByTier(tier);
  const period: BillingPeriod = billing?.billing_period === 'annual' ? 'annual' : 'monthly';
  const price = plan ? priceFor(plan, period) : undefined;
  const hasSubscription = Boolean(billing?.stripe_subscription_id);
  const isCancelling = Boolean(billing?.cancel_at_period_end);
  const isPaid = tier !== 'free';

  /**
   * Loads an invoice page. `target` is 1-based; its cursor must already be in
   * `invoiceCursors` (page 1's is undefined, and each response hands us the
   * next one), so this only ever walks one page at a time in either direction.
   */
  async function loadInvoicePage(target: number) {
    if (invoicesBusy) return;
    setInvoicesBusy(true);
    setInvoiceError(null);
    try {
      const result = await getInvoices({
        limit: INVOICES_PER_PAGE,
        starting_after: invoiceCursors[target - 1],
      });
      setInvoices(result.data || []);
      setInvoiceHasMore(Boolean(result.has_more));
      setInvoiceCursors((prev) => {
        const next = prev.slice(0, target);
        next[target] = result.next_cursor || undefined;
        return next;
      });
    } catch (err: any) {
      // Leave the rows on screen — a failed page turn shouldn't empty the list.
      setInvoiceError(err?.message || 'Could not load this page of your billing history.');
    } finally {
      setInvoicesBusy(false);
    }
  }

  /**
   * Back to the newest invoices — used after money moves. Page 1's cursor is
   * always undefined, so this needs no state reset first; loading it truncates
   * the stack back to one entry, and a failure leaves the current page intact.
   */
  const resetInvoices = () => loadInvoicePage(1);

  const invoicePage = invoiceCursors.length - 1;

  async function run(key: string, action: () => Promise<any>, successMessage?: string) {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const updated = await action();
      if (updated && typeof updated === 'object' && 'plan' in updated) setBilling(updated);
      if (successMessage) setNotice(successMessage);
      // Money moved or the plan changed — refresh the derived panels.
      resetInvoices().catch(() => {});
      getUsage().then(setUsage).catch(() => {});
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handlePortal() {
    if (busy) return;
    setBusy('portal');
    setError(null);
    try {
      window.location.href = await openCustomerPortal();
    } catch (err: any) {
      setError(err?.message || 'Could not open the billing portal.');
      setBusy(null);
    }
  }

  return (
    <AppShell user={user} authChecked={checkedAuth} backTo={{ href: '/dashboard', label: 'Back to dashboard' }}>
      <main className="flex-grow w-full mx-auto px-10 py-16" style={{ maxWidth: 1140 }}>
        <section className="mb-10">
          <h1
            className="font-serif font-bold mb-4"
            style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#1b1c1c' }}
          >
            Your subscription.
          </h1>
          <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b', maxWidth: 620 }}>
            Change your plan, update how you pay, or cancel. Nothing here is a trap — cancelling
            keeps your access until the end of the period you've already paid for.
          </p>
        </section>

        {(error || notice) && (
          <div className="mb-8">{error ? <Notice kind="error">{error}</Notice> : <Notice kind="success">{notice}</Notice>}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
          {/* ── LEFT ─────────────────────────────────────────────── */}
          <div className="md:col-span-7 flex flex-col gap-10">
            {/* Current plan */}
            <section className="rounded-xl p-8 shadow-tactile relative overflow-hidden" style={CARD}>
              <div className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-50" style={{ backgroundColor: '#e4e2e1', zIndex: 0 }} />
              <div className="relative">
                <div className="flex justify-between items-start gap-4 mb-6">
                  <div>
                    <Eyebrow>Current plan</Eyebrow>
                    <h2 className="font-serif font-semibold mt-2" style={{ fontSize: 32, lineHeight: 1.2, color: '#004635' }}>
                      {isLoading ? <Skeleton style={{ width: 190, height: 38 }} /> : PLAN_LABELS[tier] || tier}
                    </h2>
                    {isPaid && price && (
                      <p className="text-sm mt-1" style={{ color: '#5e5f5b' }}>
                        {formatPrice(price.amount)} / {periodNoun(period)}
                      </p>
                    )}
                  </div>
                  <StatusChip billing={billing} loading={isLoading} />
                </div>

                <div className="pt-4" style={{ borderTop: '1px solid #3d3d38' }}>
                  {isLoading ? (
                    <div aria-label="Loading subscription summary">
                      <Skeleton style={{ width: '92%', height: 18 }} />
                      <Skeleton style={{ width: '70%', height: 18, marginTop: 10 }} />
                      <div className="flex flex-wrap gap-3 mt-6">
                        <Skeleton style={{ width: 132, height: 42 }} />
                        <Skeleton style={{ width: 156, height: 42 }} />
                      </div>
                    </div>
                  ) : isCancelling ? (
                    <p className="text-base" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      <span className="font-semibold">Your subscription is ending.</span> You keep{' '}
                      {PLAN_LABELS[tier] || tier} until{' '}
                      <span className="font-semibold">{formatDate(billing?.renews_at)}</span>, then you'll
                      move to Explorer. You won't be charged again.
                    </p>
                  ) : billing?.status === 'past_due' ? (
                    <p className="text-base" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      <span className="font-semibold">Your last payment didn't go through.</span> Update
                      your card to keep your plan active.
                    </p>
                  ) : billing?.status === 'trialing' && billing?.trial_ends_at ? (
                    <p className="text-base" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      You're on a free trial until{' '}
                      <span className="font-semibold">{formatDate(billing.trial_ends_at)}</span>
                      {price ? <>, then {formatPrice(price.amount)} / {periodNoun(period)}</> : null}.
                    </p>
                  ) : isPaid && billing?.renews_at ? (
                    <p className="text-base" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      Renews automatically on{' '}
                      <span className="font-semibold">{formatDate(billing.renews_at)}</span>.
                    </p>
                  ) : (
                    <p className="text-base" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      You're on the free Explorer plan. Free tier limits apply.
                    </p>
                  )}

                  {/* Gated on the load: until billing lands, tier reads as
                      "free", which would render "View plans" underneath the
                      skeleton buttons above and then swap it for a different
                      control. */}
                  {!isLoading && (
                    <div className="flex flex-wrap gap-3 mt-6">
                      {!isPaid && (
                        <a
                          href="/billing"
                          className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                          style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                        >
                          View plans
                        </a>
                      )}
                      {isCancelling && hasSubscription && (
                        <button
                          className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                          style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                          onClick={() => run('resume', resumeSubscription, 'Your subscription will continue as normal.')}
                          disabled={busy === 'resume'}
                        >
                          {busy === 'resume' ? 'Resuming…' : 'Resume subscription'}
                        </button>
                      )}
                      {isPaid && !isCancelling && hasSubscription && (
                        <button
                          className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                          style={{ border: '1px solid #707974', color: '#5e5f5b', backgroundColor: 'transparent' }}
                          onClick={() => setConfirmingCancel(true)}
                        >
                          Cancel subscription
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Cancellation confirmation */}
            {confirmingCancel && plan && (
              <section className="rounded-xl p-8 shadow-tactile" style={{ backgroundColor: '#fcf9f8', border: '2px solid #ba1a1a' }}>
                <Eyebrow>Before you go</Eyebrow>
                <h2 className="font-serif font-semibold mt-2 mb-4" style={{ fontSize: 28, lineHeight: 1.2, color: '#1b1c1c' }}>
                  Cancel {PLAN_LABELS[tier] || tier}?
                </h2>
                <p className="text-base mb-4" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                  You'll keep full access until{' '}
                  <span className="font-semibold">{formatDate(billing?.renews_at)}</span>. After that
                  you'll move to Explorer and won't be charged again. You can resume any time before
                  then.
                </p>
                <p className="text-sm font-semibold mb-2" style={{ color: '#5e5f5b' }}>
                  What you'll lose on {formatDate(billing?.renews_at)}:
                </p>
                <ul className="space-y-2 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm" style={{ color: '#5e5f5b' }}>
                      <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: 18, color: '#ba1a1a' }}>
                        close
                      </span>
                      <span className="line-through">{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#ba1a1a', color: '#ffffff', border: '1px solid #ba1a1a' }}
                    onClick={async () => {
                      await run('cancel', cancelSubscription);
                      setConfirmingCancel(false);
                    }}
                    disabled={busy === 'cancel'}
                  >
                    {busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel it'}
                  </button>
                  <button
                    className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                    onClick={() => setConfirmingCancel(false)}
                  >
                    Never mind, keep it
                  </button>
                </div>
              </section>
            )}

            {/* Change plan */}
            {hasSubscription && !isCancelling && (
              <Section title="Change plan">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {PLANS.filter((p) => p.monthly).map((p: Plan) => {
                    const isCurrent = p.tier === tier;
                    const target = priceFor(p, period);
                    const targetId = priceIdFor(p, period);
                    const isUpgrade = Boolean(target && price && target.amount > price.amount);
                    return (
                      <article key={p.tier} className="rounded-lg p-6 flex flex-col" style={isCurrent ? INSET : CARD}>
                        <div className="flex justify-between items-start gap-2 mb-2">
                          <h3 className="font-serif font-semibold" style={{ fontSize: 20, color: '#004635' }}>
                            {p.name}
                          </h3>
                          {isCurrent && (
                            <span className="text-xs px-2 py-0.5 rounded font-semibold uppercase shrink-0" style={{ backgroundColor: '#004635', color: '#fff' }}>
                              Current
                            </span>
                          )}
                        </div>
                        <p className="text-sm mb-4" style={{ color: '#5e5f5b' }}>
                          {target ? `${formatPrice(target.amount)} / ${periodNoun(period)}` : '—'} · {p.tagline}
                        </p>
                        <div className="mt-auto">
                          {isCurrent ? (
                            <button
                              className="subscription-action rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                              style={{ border: '1px solid #707974', color: '#5e5f5b', backgroundColor: 'transparent', cursor: 'default' }}
                              disabled
                            >
                              Current plan
                            </button>
                          ) : (
                            <button
                              className="subscription-action rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                              style={{ backgroundColor: isUpgrade ? '#004635' : 'transparent', color: isUpgrade ? '#ffffff' : '#004635', border: '1px solid #004635' }}
                              onClick={() =>
                                setConfirmingPlan({
                                  tier: p.tier,
                                  name: p.name,
                                  priceId: targetId as string,
                                  isUpgrade,
                                })
                              }
                              disabled={busy === p.tier || !targetId}
                            >
                              {busy === p.tier ? 'Switching…' : isUpgrade ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <p className="text-sm mt-4" style={{ color: '#5e5f5b' }}>
                  Switching takes effect immediately, and we'll confirm the details before anything
                  is charged.
                </p>
              </Section>
            )}

            {/* Plan-change confirmation. Not a modal: the house pattern is an
                inline panel, as with the cancellation confirm above. Green
                rather than the cancel panel's red — switching is not
                destructive, and danger styling here would cry wolf. */}
            {confirmingPlan && (
              <section
                className="rounded-xl p-8 shadow-tactile"
                style={{ backgroundColor: '#fcf9f8', border: '2px solid #004635' }}
              >
                <Eyebrow>Before you switch</Eyebrow>
                <h2
                  className="font-serif font-semibold mt-2 mb-4"
                  style={{ fontSize: 28, lineHeight: 1.2, color: '#1b1c1c' }}
                >
                  {confirmingPlan.isUpgrade ? 'Upgrade to' : 'Switch to'} {confirmingPlan.name}?
                </h2>
                <p className="text-base mb-4" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                  This takes effect{' '}
                  <span className="font-semibold">immediately</span>. Stripe credits the unused part
                  of {PLAN_LABELS[tier] || tier} against {confirmingPlan.name}, so you're charged
                  only the difference.
                </p>
                {billing?.status === 'trialing' && (
                  <p className="text-base mb-4" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                    <span className="font-semibold">Your free trial ends now.</span> Switching plans
                    during a trial starts billing today rather than on{' '}
                    {formatDate(billing?.trial_ends_at)}.
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#004635', color: '#ffffff', border: '1px solid #004635' }}
                    onClick={async () => {
                      const target = confirmingPlan;
                      await run(
                        target.tier,
                        () => changePlan(target.priceId),
                        `You're now on ${target.name}. Stripe has prorated the difference.`,
                      );
                      setConfirmingPlan(null);
                    }}
                    disabled={busy === confirmingPlan.tier}
                  >
                    {busy === confirmingPlan.tier
                      ? 'Switching…'
                      : `Yes, switch to ${confirmingPlan.name}`}
                  </button>
                  <button
                    className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ border: '1px solid #707974', color: '#5e5f5b', backgroundColor: 'transparent' }}
                    onClick={() => setConfirmingPlan(null)}
                  >
                    Never mind
                  </button>
                </div>
              </section>
            )}

            {/* Billing history */}
            <Section title="Billing history">
              {loading.invoices ? (
                <ul aria-label="Loading billing history">
                  {[0, 1, 2].map((i) => (
                    <li
                      key={i}
                      className="py-3 flex justify-between items-center gap-4"
                      style={{ borderBottom: '1px solid #e4e2e1' }}
                    >
                      <div className="pr-4 flex-grow">
                        <Skeleton style={{ width: i === 1 ? 118 : 132, height: 17 }} />
                        <Skeleton style={{ width: i === 2 ? 142 : 168, height: 14, marginTop: 7 }} />
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <Skeleton style={{ width: 56, height: 17 }} />
                        <Skeleton style={{ width: 62, height: 14 }} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : invoices.length > 0 ? (
                <ul aria-busy={invoicesBusy}>
                  {invoices.map((inv) => (
                    <li
                      key={inv.id}
                      className="py-3 flex justify-between items-center gap-4"
                      style={{ borderBottom: '1px solid #e4e2e1' }}
                    >
                      <div className="truncate pr-4">
                        <span className="block truncate font-medium" style={{ color: '#1b1c1c' }}>
                          {formatDate(inv.created)}
                        </span>
                        <span className="text-sm" style={{ color: '#5e5f5b' }}>
                          {inv.number || inv.id}
                          {inv.status && inv.status !== 'paid' ? ` · ${inv.status}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <span className="font-semibold" style={{ color: '#1b1c1c' }}>
                          {formatPrice(inv.amount_paid || inv.amount_due)}
                        </span>
                        {inv.hosted_invoice_url && (
                          <a
                            href={inv.hosted_invoice_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-semibold hover:underline flex items-center gap-1"
                            style={{ color: '#004635' }}
                          >
                            Receipt
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                              open_in_new
                            </span>
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm italic" style={{ color: '#5e5f5b' }}>
                  No invoices yet. Your receipts will appear here after your first payment.
                </p>
              )}
              {invoiceError && (
                <div className="mt-4">
                  <Notice kind="error">{invoiceError}</Notice>
                </div>
              )}
              {(invoicePage > 1 || invoiceHasMore) && (
                <Pager
                  label="Billing history"
                  page={invoicePage}
                  rangeStart={invoices.length ? (invoicePage - 1) * INVOICES_PER_PAGE + 1 : 0}
                  rangeEnd={
                    invoices.length ? (invoicePage - 1) * INVOICES_PER_PAGE + invoices.length : 0
                  }
                  /* Stripe reports no total, so no "of N" here. */
                  hasMore={invoiceHasMore}
                  busy={invoicesBusy}
                  onPrev={() => loadInvoicePage(invoicePage - 1)}
                  onNext={() => loadInvoicePage(invoicePage + 1)}
                />
              )}
            </Section>
          </div>

          {/* ── RIGHT ────────────────────────────────────────────── */}
          <div className="md:col-span-4 md:col-start-9 flex flex-col gap-10">
            {/* Usage */}
            <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
              <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: '#1b1c1c' }}>
                Usage
              </h3>
              {loading.usage ? (
                <div aria-label="Loading usage">
                  <Skeleton style={{ width: '62%', height: 15 }} />
                  <Skeleton style={{ width: 92, height: 32, marginTop: 16 }} />
                  <Skeleton style={{ width: '100%', height: 8, marginTop: 14, borderRadius: 999 }} />
                  <Skeleton style={{ width: '76%', height: 14, marginTop: 10 }} />
                </div>
              ) : !usage ? (
                <p className="text-sm italic" style={{ color: '#5e5f5b' }}>
                  Usage is unavailable right now.
                </p>
              ) : usage.unlimited ? (
                <>
                  <p className="text-sm mb-4" style={{ color: '#5e5f5b' }}>
                    Reformats on your plan.
                  </p>
                  <div className="flex items-center gap-2 font-serif font-semibold" style={{ fontSize: 28, color: '#004635' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 26 }}>
                      all_inclusive
                    </span>
                    Unlimited
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm mb-4" style={{ color: '#5e5f5b' }}>
                    {usage.limit_type === 'monthly' ? 'Reformats this month.' : 'Reformats today.'}
                  </p>
                  <div className="flex items-baseline gap-2 mb-3">
                    <span className="font-serif font-bold" style={{ fontSize: 32, lineHeight: 1, color: '#004635' }}>
                      {usage.used}
                    </span>
                    <span className="text-sm font-semibold" style={{ color: '#5e5f5b' }}>
                      / {usage.limit}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden mb-2" style={{ backgroundColor: '#e4e2e1' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, usage.limit ? (usage.used / usage.limit) * 100 : 0)}%`,
                        backgroundColor:
                          usage.limit && usage.used / usage.limit > 0.9 ? '#ba1a1a' : '#004635',
                      }}
                    />
                  </div>
                  <p className="text-sm" style={{ color: '#5e5f5b' }}>
                    {usage.remaining} left · resets {formatDate(usage.resets_at)}
                  </p>
                  {usage.lifetime_limit != null && (
                    <p className="text-xs mt-3 pt-3" style={{ color: '#5e5f5b', borderTop: '1px solid #e4e2e1' }}>
                      Lifetime: {usage.lifetime_used} / {usage.lifetime_limit} on the free tier.
                    </p>
                  )}
                </>
              )}
            </section>

            {/* Payment method */}
            <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
              <h3 className="font-serif font-semibold text-2xl mb-4" style={{ color: '#1b1c1c' }}>
                Payment method
              </h3>
              {loading.card ? (
                <div className="flex items-center gap-3 mb-4" aria-label="Loading payment method">
                  <Skeleton style={{ width: 28, height: 28, borderRadius: 6 }} />
                  <div className="flex-grow">
                    <Skeleton style={{ width: 148, height: 17 }} />
                    <Skeleton style={{ width: 106, height: 14, marginTop: 7 }} />
                  </div>
                </div>
              ) : card?.last4 ? (
                <>
                  <div className="flex items-center gap-3 mb-4">
                    <span className="material-symbols-outlined" style={{ fontSize: 28, color: '#004635' }}>
                      credit_card
                    </span>
                    <div>
                      <p className="font-medium" style={{ color: '#1b1c1c' }}>
                        {(card.brand || 'Card').replace(/\b\w/g, (l) => l.toUpperCase())} ···· {card.last4}
                      </p>
                      {card.exp_month && card.exp_year && (
                        <p className="text-sm" style={{ color: '#5e5f5b' }}>
                          Expires {String(card.exp_month).padStart(2, '0')}/{card.exp_year}
                        </p>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm mb-4 italic" style={{ color: '#5e5f5b' }}>
                  No card on file.
                </p>
              )}
              {(billing?.stripe_customer_id || isPaid) && (
                <button
                  className="subscription-action rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80 flex items-center justify-center gap-2"
                  style={{ border: '1px solid #004635', color: '#004635', backgroundColor: 'transparent' }}
                  onClick={handlePortal}
                  disabled={busy === 'portal'}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    lock
                  </span>
                  {busy === 'portal' ? 'Opening…' : card?.last4 ? 'Update card' : 'Add a card'}
                </button>
              )}
              <p className="text-xs mt-3" style={{ color: '#5e5f5b', lineHeight: 1.5 }}>
                Card details are entered on Stripe's secure page — they never touch Synapse's
                servers.
              </p>
            </section>

            {/* Help */}
            <section className="p-5 rounded shadow-tactile mt-auto" style={INSET}>
              <Eyebrow>Need a hand?</Eyebrow>
              <p className="text-sm mt-2" style={{ color: '#5e5f5b', lineHeight: 1.6 }}>
                Billing questions, refunds, or something that looks wrong — get in touch and we'll
                sort it out.
              </p>
              <a href="/support" className="text-sm font-semibold hover:underline mt-3 block" style={{ color: '#004635' }}>
                Contact support
              </a>
            </section>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
