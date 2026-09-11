-- Track whether a subscription is set to cancel at the end of its billing period.
--
-- The subscription management screen has to tell two very different states apart:
-- "renews on 17 Oct" and "cancels on 17 Oct". Both have the same renews_at, so
-- without this flag the UI cannot distinguish them, and a user who has cancelled
-- would still be told their plan is about to renew.
--
-- Stripe owns the truth (subscription.cancel_at_period_end); this column mirrors
-- it so /billing/status can answer without a round trip on every page load. It is
-- written by POST /billing/cancel, POST /billing/resume, and the
-- customer.subscription.updated webhook.
--
-- Safe to run once; existing rows default to FALSE, which matches the previous
-- implicit behaviour (nothing could be scheduled for cancellation before now).

BEGIN;

ALTER TABLE public.billing
    ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
