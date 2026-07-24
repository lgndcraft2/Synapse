-- Add the "lite" (Thinker Lite) tier to the plan CHECK constraints.
--
-- The application added a "lite" plan (backend/app/api/routes/billing.py maps the
-- Thinker Lite Stripe price to plan="lite"), but the original DB constraints only
-- allowed free/premium/institutional. Without this, activating a Thinker Lite
-- subscription fails with billing_plan_check / users_plan_check violations and the
-- Stripe webhook returns 500, so the upgrade never persists.
--
-- Safe to run once; widening an allowed-value set does not affect existing rows.

BEGIN;

ALTER TABLE public.billing DROP CONSTRAINT billing_plan_check;
ALTER TABLE public.billing ADD CONSTRAINT billing_plan_check
    CHECK (plan = ANY (ARRAY['free', 'lite', 'premium', 'institutional']));

ALTER TABLE public.users DROP CONSTRAINT users_plan_check;
ALTER TABLE public.users ADD CONSTRAINT users_plan_check
    CHECK (plan = ANY (ARRAY['free', 'lite', 'premium', 'institutional']));

COMMIT;
