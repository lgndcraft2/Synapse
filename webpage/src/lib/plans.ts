/**
 * The plan catalogue — one source of truth for the landing page's pricing
 * section, the /billing page and the post-checkout confirmation.
 *
 * `priceId` values must match the backend's STRIPE_* env vars exactly, or
 * POST /api/v1/billing/checkout rejects them with "Invalid or unauthorized
 * price ID." (see backend/app/core/config.py → allowed_price_ids).
 */

/** Internal tiers the backend stores on `billing.plan` / `users.plan`. */
export type PlanTier = 'free' | 'lite' | 'premium' | 'institutional';

export type BillingPeriod = 'monthly' | 'annual';

export interface PlanPrice {
  priceId: string;
  /** Amount in cents, so the display never does float arithmetic. */
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
      'Single profile',
      '30 section reformats per month',
      'Basic cognitive profile',
      'Chrome extension only',
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
      'Google Docs support',
      'Faster processing',
      'Basic adaptive feedback',
    ],
    cta: 'Upgrade',
    featured: true,
    monthly: { priceId: env.VITE_STRIPE_THINKER_LITE_PRICE_ID || '', amount: 400 },
    annual: { priceId: env.VITE_STRIPE_THINKER_LITE_ANNUAL_PRICE_ID || '', amount: 4000 },
  },
  {
    tier: 'premium',
    name: 'Deep Thinker',
    tagline: 'No ceiling, no rationing.',
    features: [
      'Unlimited reformats',
      'Full Google Docs/PDF support',
      'Cognitive pattern insights',
      'Full adaptive feedback loop',
    ],
    cta: 'Go Deep',
    note: '$8/mo primary pricing, with local university pricing available in Nigeria.',
    monthly: { priceId: env.VITE_STRIPE_DEEP_THINKER_PRICE_ID || '', amount: 800 },
    annual: { priceId: env.VITE_STRIPE_DEEP_THINKER_ANNUAL_PRICE_ID || '', amount: 8000 },
  },
];

/**
 * Annual billing only exists once both annual price IDs are configured in
 * Stripe and mirrored into the env. Until then the toggle stays hidden and
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

/** 800 → "$8.00" */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** 800 → "$8" — the compact form used on the pricing cards. */
export function formatPriceShort(cents: number): string {
  const value = cents / 100;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
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
