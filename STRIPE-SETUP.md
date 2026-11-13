# Stripe setup: payment inside registration

About 20 minutes, done once. Nothing changes on the live site until step 5: until a payment option has a Stripe price ID, registration keeps working exactly like before.

Do it in **test mode** first (toggle at the top right of the Stripe dashboard), run one registration with Stripe's test card `4242 4242 4242 4242`, then repeat steps 3, 4 and 5 in live mode.

## 1. Update the database

Supabase dashboard → **SQL Editor** → New query → paste all of `supabase/stripe.sql` → **Run**. It is safe to run again.

## 2. Create the Stripe function in Supabase

1. Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `stripe`.
3. Replace the sample code with all of `supabase/functions/stripe/index.ts` → **Deploy function**.
4. Open the function's **Details** (or Settings) and turn **Verify JWT** / "Enforce JWT verification" **off**, then save. (Stripe can't log in to Supabase; the function checks Stripe's signature, and only lets admins run the sync.)

## 3. Add your Stripe secret key

1. Stripe dashboard → **Developers** → **API keys** → reveal and copy the **Secret key** (`sk_test_…` in test mode, `sk_live_…` in live mode).
2. Supabase dashboard → **Edge Functions** → **Secrets** → add `STRIPE_SECRET_KEY` with that value → Save.

Never paste the secret key into the site, the office, GitHub, or a chat.

## 4. Point Stripe at the function (the webhook)

1. Stripe dashboard → **Developers** → **Webhooks** → **Add endpoint** (or "Add destination" → Webhook endpoint).
2. Endpoint URL: `https://azguekurdqthlxbksmez.supabase.co/functions/v1/stripe/webhook`
3. Events to send:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `charge.refunded`
4. Save, then on the endpoint's page reveal the **Signing secret** (`whsec_…`).
5. Supabase → **Edge Functions** → **Secrets** → add `STRIPE_WEBHOOK_SECRET` with that value.

## 5. Connect your prices to the registration form

1. Stripe dashboard → **Product catalog** → open the product (e.g. full season) → in **Pricing**, click the price → copy its ID (`price_…`, not the `prod_…` product ID).
   - A **one-time** price becomes a full payment.
   - A **recurring** price (e.g. monthly) becomes a payment plan.
2. League office → **Payments** → enter the PIN → on each option, paste the price ID into "Stripe price ID". For a plan, set **Number of payments** (e.g. 4): the plan then stops itself after the last payment. Leave it blank only for plans that should run until cancelled.
3. Open the registration page: the options now appear inside the form, and "Continue to payment" takes players to Stripe.

You can leave the old Stripe link in an option; it's ignored once a price ID is set.

## 6. Catch up on people who already paid

League office → **People** → **Sync with Stripe**. It looks through the last year of Stripe payments and plans and fills in every registration it can match by email, including people who paid through the old Stripe links. Anyone it can't match is listed at the top (usually they paid with a different email than they registered with: fix the email on their registration, then sync again).

For old plans to show "amount remaining", the old option in Payments needs **Number of payments** filled in and its Stripe link left in place, so the sync can tell which plan they're on.

## What updates by itself after that

| In Stripe | In the league office |
|---|---|
| Full payment goes through | **Paid** |
| Plan's first payment goes through | **On plan · 1/4**, with next payment date and amount remaining |
| Each later plan payment | count goes up (2/4, 3/4…) |
| A plan payment fails | **Past due**, and it shows on the dashboard |
| Last plan payment | **Paid**, and the plan is stopped in Stripe |
| Plan cancelled before the end | **Past due** (still owes the rest) |
| Full refund | **Refunded** |

You can still set a status by hand on a player's profile (cash, e-transfer). Stripe will never overwrite **Comped** or **Refunded**.

## If something doesn't work

- Supabase → Edge Functions → `stripe` → **Logs** shows every call and any error.
- Stripe → Developers → Webhooks → your endpoint shows each event and whether the function accepted it (it should say 200). A 400 "Bad signature" means `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint (test and live mode each have their own).
- "Payment could not start" on the form usually means `STRIPE_SECRET_KEY` is missing, or the price ID is from the other mode (test vs live).
