-- Support tickets filed from the /support page.
--
-- The backend has no email capability, so a submitted ticket is persisted here
-- and the browser additionally hands the user's mail client a pre-filled
-- message. This table is the durable record and is what the internal support
-- console will read from and reply into.
--
-- user_id is nullable and ON DELETE SET NULL on purpose:
--   * somebody whose sign-in is broken must still be able to reach support, so
--     anonymous tickets carry only the email they typed;
--   * deleting an account (DELETE /api/v1/auth/account) must not destroy the
--     support history attached to it.
--
-- status / reply / replied_at exist from the start so the console has somewhere
-- to write without another migration.
--
-- Safe to run once; creating a new table does not touch existing rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.support_tickets (
    id            UUID PRIMARY KEY,
    reference     TEXT NOT NULL UNIQUE,
    user_id       UUID REFERENCES public.users(id) ON DELETE SET NULL,
    email         TEXT NOT NULL,
    topic         TEXT NOT NULL,
    subject       TEXT NOT NULL,
    message       TEXT NOT NULL,
    diagnostics   JSONB,
    status        TEXT NOT NULL DEFAULT 'open',
    reply         TEXT,
    replied_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_status_check;
ALTER TABLE public.support_tickets ADD CONSTRAINT support_tickets_status_check
    CHECK (status = ANY (ARRAY['open', 'answered', 'closed']));

CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx
    ON public.support_tickets(user_id);
CREATE INDEX IF NOT EXISTS support_tickets_created_at_idx
    ON public.support_tickets(created_at DESC);

COMMIT;
