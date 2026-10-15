/**
 * The plan catalogue — one source of truth for the landing page's pricing
 * section, the /billing page and the post-checkout confirmation.
 *
 * `priceId` values are Paystack plan codes and must match the backend's
 * PAYSTACK_*_PLAN_CODE env vars exactly, or
 * POST /api/v1/billing/checkout rejects them with "Invalid or unauthorized
 * price ID." (see backend/app/core/config.py → allowed_price_ids).
 */

/** Internal tiers the backend stores on `billing.plan` / `users.plan`. */
export type PlanTier = 'free' | 'lite' | 'premium' | 'institutional';

export type BillingPeriod = 'monthly' | 'annual';

export interface PlanPrice {
  priceId: string;
  /** Amount in kobo (Paystack's NGN subunit), so the display never does float arithmetic. */
  amount: number;
}

export interface Plan {
  tier: PlanTier;
  name: string;
  tagline: string;
  features: string[];
  /** Copy for the landing page's button; /billing uses its own verbs. */
  cta: string;
  featured?: boolean;
  note?: string;
  monthly?: PlanPrice;
  annual?: PlanPrice;
}

/** Matches the backend's `subscription_data={"trial_period_days": 7}`. */
export const TRIAL_DAYS = 7;

/** Human-readable names for the tiers the backend reports. */
export const PLAN_LABELS: Record<string, string> = {
  free: 'Explorer',
  lite: 'Thinker Lite',
  premium: 'Deep Thinker',
  institutional: 'Institutional',
};

const env = import.meta.env;

export const PLANS: Plan[] = [
  {
    tier: 'free',
    name: 'Explorer',
    tagline: 'Enough to feel the difference.',
    features: [
      'Web reformatting',
      'Highlight and circle to explain',
      'Single profile',
      '30 section reformats per month',
      'Basic cognitive profile',
    ],
    cta: 'Start Free',
  },
  {
    tier: 'lite',
    name: 'Thinker Lite',
    tagline: 'For steady, everyday reading.',
    features: [
      'Everything in Free',
      'Up to 300 section reformats per month',
      'Saved explanation history',
      'Document support',
      'Basic adaptive feedback',
    ],
    cta: 'Upgrade',
    featured: true,
    monthly: { priceId: env.VITE_PAYSTACK_THINKER_LITE_PLAN_CODE || '', amount: 550000 },
    annual: { priceId: env.VITE_PAYSTACK_THINKER_LITE_ANNUAL_PLAN_CODE || '', amount: 5500000 },
  },
  {
    tier: 'premium',
    name: 'Deep Thinker',
    tagline: 'No ceiling, no rationing.',
    features: [
      'Unlimited explains and reformats',
      'Saved explanation history',
      'Full Document and PDF support',
      'Cognitive pattern insights',
      'Full adaptive feedback loop',
    ],
    cta: 'Go Deep',
    note: '$8/mo primary pricing, with local university pricing available in Nigeria.',
    monthly: { priceId: env.VITE_PAYSTACK_DEEP_THINKER_PLAN_CODE || '', amount: 1100000 },
    annual: { priceId: env.VITE_PAYSTACK_DEEP_THINKER_ANNUAL_PLAN_CODE || '', amount: 11000000 },
  },
];

/**
 * Annual billing only exists once both annual plans are created in
 * Paystack and their codes mirrored into the env. Until then the toggle stays hidden and
 * every checkout is monthly, so nothing half-wired reaches the user.
 */
export const annualAvailable: boolean = PLANS.filter((p) => p.monthly).every(
  (p) => Boolean(p.annual?.priceId),
);

export function planByTier(tier: string | undefined | null): Plan | undefined {
  return PLANS.find((p) => p.tier === tier);
}

export function priceFor(plan: Plan, period: BillingPeriod): PlanPrice | undefined {
  return period === 'annual' ? plan.annual : plan.monthly;
}

export function priceIdFor(plan: Plan, period: BillingPeriod): string {
  return priceFor(plan, period)?.priceId || '';
}

/** Groups thousands by hand rather than with Intl, so the prerendered HTML
 * and the browser can never format differently and break hydration. */
function naira(kobo: number): string {
  const value = kobo / 100;
  const [whole, fraction] = (Number.isInteger(value) ? String(value) : value.toFixed(2)).split('.');
  return `₦${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}

/** 1100000 → "₦11,000". Kobo only appear when there are some. */
export function formatPrice(kobo: number): string {
  return naira(kobo);
}

/** 1100000 → "₦11,000" — the compact form used on the pricing cards. */
export function formatPriceShort(kobo: number): string {
  return naira(kobo);
}

export function periodSuffix(period: BillingPeriod): string {
  return period === 'annual' ? '/yr' : '/mo';
}

export function periodNoun(period: BillingPeriod): string {
  return period === 'annual' ? 'year' : 'month';
}

/** The date the trial converts to a paid charge, for the order summary. */
export function trialEndDate(from: Date = new Date()): Date {
  const end = new Date(from);
  end.setDate(end.getDate() + TRIAL_DAYS);
  return end;
}

export function formatDate(value: string | Date | undefined | null): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
