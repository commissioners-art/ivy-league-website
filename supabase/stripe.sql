-- ===============================================================
-- Stripe payments inside registration — paste into the Supabase
-- SQL editor and run once. Safe to run again.
--
-- What this adds:
--   * payment_links can point at a Stripe price (stripe_price_id).
--     Options with a price are paid at the end of the registration
--     form (Stripe Checkout). Options without one keep working as a
--     plain Stripe link, exactly like before.
--   * registrations remember how the player is paying (a full
--     payment or a payment plan) and where that stands. The Stripe
--     edge function (supabase/functions/stripe) keeps these columns
--     up to date by itself; nobody types them in.
-- ===============================================================

-- ---------- payment options ------------------------------------
alter table payment_links alter column url drop not null;
alter table payment_links add column if not exists stripe_price_id text;   -- price_... from Stripe
alter table payment_links add column if not exists installments   int      -- payment plans: how many payments, then it stops.
  check (installments is null or installments > 0);                        -- blank = runs until cancelled

-- ---------- what each registrant chose and where it stands ------
alter table registrations add column if not exists payment_option_id uuid references payment_links on delete set null;
alter table registrations add column if not exists payment_type      text   -- 'full' (one payment) | 'plan' (subscription)
  check (payment_type is null or payment_type in ('full','plan'));
alter table registrations add column if not exists plan_status       text   -- Stripe's subscription status, simplified
  check (plan_status is null or plan_status in ('active','past_due','cancelled','completed'));
alter table registrations add column if not exists amount_total_cents   int;            -- what the season costs them in total (when known)
alter table registrations add column if not exists amount_paid_cents    int default 0;  -- what has actually come in
alter table registrations add column if not exists installment_cents    int;            -- size of each plan payment
alter table registrations add column if not exists installments_total   int;            -- plan length (null = open-ended)
alter table registrations add column if not exists installments_paid    int default 0;
alter table registrations add column if not exists next_payment_at      timestamptz;
alter table registrations add column if not exists paid_at              timestamptz;    -- when it was paid in full
alter table registrations add column if not exists stripe_customer_id     text;
alter table registrations add column if not exists stripe_subscription_id text;
alter table registrations add column if not exists stripe_session_id      text;
alter table registrations add column if not exists stripe_synced_at       timestamptz;

-- 'plan' = on a payment plan and up to date, 'past_due' = a plan payment failed
alter table registrations drop constraint if exists registrations_payment_status_check;
alter table registrations add constraint registrations_payment_status_check
  check (payment_status in ('unpaid','plan','past_due','paid','refunded','comped'));

create index if not exists registrations_sub_idx   on registrations (stripe_subscription_id);
create index if not exists registrations_email_idx on registrations (lower(email));

-- ---------- close a gap in the public sign-up policy -------------
-- The public form may only create a fresh, unpaid registration.
-- (Before this, a hand-crafted request could submit one already
-- marked "paid".) Payment columns are only ever set by staff or by
-- the Stripe edge function.
drop policy if exists "public submit" on registrations;
create policy "public submit" on registrations for insert with check (
  payment_status = 'unpaid' and status = 'new' and player_id is null
  and coalesce(amount_paid_cents, 0) = 0 and coalesce(installments_paid, 0) = 0
  and payment_type is null and plan_status is null and paid_at is null
  and stripe_customer_id is null and stripe_subscription_id is null and stripe_session_id is null
);
