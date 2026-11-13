// ---------------------------------------------------------------
// Milton Ivy League: Stripe, in one Supabase Edge Function.
//
//   POST /functions/v1/stripe/checkout   the registration form calls this.
//        Saves the registration, then opens Stripe Checkout for the
//        payment option the player picked (a full payment or a plan).
//   POST /functions/v1/stripe/webhook    Stripe calls this whenever a
//        payment goes through, fails, or a plan changes. It keeps each
//        registration's payment columns up to date.
//   POST /functions/v1/stripe/options    the registration page calls this to
//        get the payment options to show. Only options that are switched on
//        in the office AND still active in Stripe come back, so an archived
//        price or a deactivated payment link never reaches the site. With
//        {"all": true} and an admin login, returns every option and why any
//        are hidden (for the Payments tab).
//   POST /functions/v1/stripe/sync       "Sync with Stripe" in the league
//        office (admins only). Looks back through Stripe for the past
//        year and matches every payment and plan to a registration,
//        including people who paid through the old Stripe links.
//
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   STRIPE_SECRET_KEY       sk_live_... (or sk_test_... while testing)
//   STRIPE_WEBHOOK_SECRET   whsec_...  from the Stripe webhook endpoint
//   SITE_URL                optional, defaults to https://miltonivyleague.ca
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase automatically.
//
// Deploy with "Verify JWT" turned OFF: Stripe can't send a Supabase
// login. The sync route checks for an admin itself.
// ---------------------------------------------------------------
import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-02-24.acacia',
  httpClient: Stripe.createFetchHttpClient()
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://miltonivyleague.ca').replace(/\/$/, '');
const ALLOWED_ORIGINS = [SITE_URL, 'https://miltonivyleague.ca', 'https://www.miltonivyleague.ca'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  try {
    if (route === 'options') return await options(req);
    if (route === 'checkout') return await checkout(req);
    if (route === 'webhook') return await webhook(req);
    if (route === 'sync') return await sync(req);
    return json({ error: 'Unknown route' }, 404);
  } catch (err) {
    console.error(route, err);
    return json({ error: (err as Error).message ?? 'Something went wrong' }, 500);
  }
});

// =================================================================
// Checkout: save the registration, then send the player to Stripe
// =================================================================
const REG_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'position', 'jersey_number', 'division',
  'team_id', 'shirt_size', 'emergency_name', 'emergency_phone', 'notes'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkout(req: Request) {
  const body = await req.json().catch(() => ({}));
  const optionId = String(body.option_id ?? '');
  if (!UUID.test(optionId)) return json({ error: 'Pick a payment option.' }, 400);

  const { data: option } = await db.from('payment_links').select('*').eq('id', optionId).eq('active', true).maybeSingle();
  if (!option?.stripe_price_id) return json({ error: 'That payment option is not available any more.' }, 400);
  const check = await stripeCheck(option);
  if (!check.ok) return json({ error: 'That payment option is not available any more. Refresh the page and pick another.' }, 409);
  const price = check.price!;
  const isPlan = !!price.recurring;

  // A player coming back after closing the Stripe page reuses their registration.
  let reg;
  if (body.registration_id) {
    if (!UUID.test(String(body.registration_id))) return json({ error: 'Bad registration.' }, 400);
    reg = (await db.from('registrations').select('*').eq('id', body.registration_id).maybeSingle()).data;
    if (!reg) return json({ error: 'We could not find your registration. Fill in the form again.' }, 404);
    if (reg.payment_status !== 'unpaid') return json({ error: 'This registration is already paid or on a plan.' }, 409);
  } else {
    const r = body.registration ?? {};
    const row: Record<string, unknown> = {};
    for (const k of REG_FIELDS) {
      const v = r[k];
      row[k] = v === undefined || v === '' ? null : String(v).trim().slice(0, 500);
    }
    if (!row.first_name || !row.last_name || !row.email || !/^\S+@\S+\.\S+$/.test(String(row.email)))
      return json({ error: 'Fill in your name and a valid email.' }, 400);
    if (r.waiver_accepted !== true) return json({ error: 'Please accept the waiver.' }, 400);
    row.waiver_accepted = true;
    row.jersey_number = row.jersey_number ? parseInt(String(row.jersey_number), 10) || null : null;
    if (row.team_id && !UUID.test(String(row.team_id))) row.team_id = null;
    if (!['Forward', 'Defence', 'Goalie'].includes(String(row.position))) row.position = 'Forward';
    const ins = await db.from('registrations').insert(row).select('*').single();
    if (ins.error) throw ins.error;
    reg = ins.data;
  }

  const origin = req.headers.get('origin') ?? '';
  const site = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : SITE_URL;
  const meta = { registration_id: reg.id, option_id: option.id, installments: option.installments ? String(option.installments) : '' };

  const session = await stripe.checkout.sessions.create({
    mode: isPlan ? 'subscription' : 'payment',
    line_items: [{ price: price.id, quantity: 1 }],
    customer_email: reg.email,
    client_reference_id: reg.id,
    metadata: meta,
    ...(isPlan
      ? { subscription_data: { metadata: meta, description: `${reg.first_name} ${reg.last_name}: ${option.label}` } }
      : { customer_creation: 'always', payment_intent_data: { metadata: meta, description: `${reg.first_name} ${reg.last_name}: ${option.label}` } }),
    success_url: `${site}/register.html?paid=1&reg=${reg.id}`,
    cancel_url: `${site}/register.html?unfinished=1&reg=${reg.id}`
  });

  await db.from('registrations').update({
    payment_option_id: option.id, payment_type: isPlan ? 'plan' : 'full', stripe_session_id: session.id,
    installments_total: isPlan ? option.installments ?? null : null
  }).eq('id', reg.id);

  return json({ url: session.url, registration_id: reg.id });
}

// =================================================================
// Options: only what's switched on here AND still live in Stripe
// =================================================================
type Check = { ok: boolean; reason?: string; price?: Stripe.Price };
let liveLinks: { at: number; urls: Set<string> } | null = null;

/* Is this option still usable in Stripe? A price must be active and its
   product not archived; a plain link must be an active Stripe payment link. */
async function stripeCheck(o: any): Promise<Check> {
  if (o.stripe_price_id) {
    let price: Stripe.Price;
    try { price = await stripe.prices.retrieve(o.stripe_price_id, { expand: ['product'] }); }
    catch { return { ok: false, reason: 'Stripe has no price with this ID (check test vs live mode).' }; }
    if (!price.active) return { ok: false, reason: 'This price is archived in Stripe.' };
    const product = price.product as Stripe.Product | Stripe.DeletedProduct;
    if (!product || (product as Stripe.DeletedProduct).deleted || !(product as Stripe.Product).active)
      return { ok: false, reason: 'The product for this price is archived in Stripe.' };
    return { ok: true, price };
  }
  if (o.url) {
    if (!liveLinks || Date.now() - liveLinks.at > 60_000) {
      const urls = new Set<string>();
      for await (const pl of stripe.paymentLinks.list({ active: true, limit: 100 })) urls.add(pl.url.replace(/\/$/, ''));
      liveLinks = { at: Date.now(), urls };
    }
    return liveLinks.urls.has(String(o.url).trim().replace(/\/$/, ''))
      ? { ok: true } : { ok: false, reason: 'This link is deactivated in Stripe, or is not a payment link from this Stripe account.' };
  }
  return { ok: false, reason: 'No Stripe price ID or link.' };
}

async function options(req: Request) {
  const body = await req.json().catch(() => ({}));
  const all = body.all === true;
  if (all && !(await callerIsAdmin(req))) return json({ error: 'Admins only.' }, 403);
  let q = db.from('payment_links').select('*').order('sort');
  if (!all) q = q.eq('active', true);
  const { data: rows, error } = await q;
  if (error) throw error;
  const checked = await Promise.all((rows ?? []).map(async o => {
    const c = await stripeCheck(o);
    return { ...o, stripe_ok: c.ok, stripe_reason: c.reason ?? null };
  }));
  if (all) return json({ options: checked });
  const pub = ({ id, label, description, price_text, url, stripe_price_id, installments, sort }: any) =>
    ({ id, label, description, price_text, url: stripe_price_id ? null : url, stripe_price_id, installments, sort });
  return json({ options: checked.filter(o => o.stripe_ok).map(pub) });
}

async function callerIsAdmin(req: Request) {
  const asUser = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false }
  });
  const { data } = await asUser.rpc('is_admin');
  return !!data;
}

// =================================================================
// Webhook: Stripe tells us what happened
// =================================================================
async function webhook(req: Request) {
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig ?? '', Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '', undefined, cryptoProvider);
  } catch (err) {
    return json({ error: `Bad signature: ${(err as Error).message}` }, 400);
  }

  // Everything below re-reads the current state from Stripe and
  // overwrites the registration with it, so a repeated or
  // out-of-order event can't double-count a payment.
  const obj = event.data.object as any;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await applySession(obj);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const subId = obj.subscription ?? obj.parent?.subscription_details?.subscription;
      if (subId) await applySubscription(typeof subId === 'string' ? subId : subId.id);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(obj.id);
      break;
    case 'charge.refunded':
      await applyRefund(obj);
      break;
  }
  return json({ received: true });
}

// =================================================================
// Sync: look back through Stripe and fill in everyone
// =================================================================
async function sync(req: Request) {
  if (!(await callerIsAdmin(req))) return json({ error: 'Admins only.' }, 403);

  const body = await req.json().catch(() => ({}));
  const days = Math.min(Math.max(parseInt(body.days, 10) || 365, 1), 730);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const matched = new Set<string>();
  const unmatched: Unmatched[] = [];

  for await (const sub of stripe.subscriptions.list({ status: 'all', created: { gte: since }, limit: 100 })) {
    const r = await applySubscription(sub.id, sub);
    if (r.reg) matched.add(r.reg); else if (r.unmatched) unmatched.push(r.unmatched);
  }
  for await (const s of stripe.checkout.sessions.list({ status: 'complete', created: { gte: since }, limit: 100 })) {
    if (s.mode !== 'payment' || s.payment_status !== 'paid') continue;
    const r = await applySession(s);
    if (r.reg) matched.add(r.reg); else if (r.unmatched) unmatched.push(r.unmatched);
  }
  return json({ matched: matched.size, unmatched });
}

// =================================================================
// Shared: turn Stripe objects into registration updates
// =================================================================
type Unmatched = { name: string; email: string; type: 'full' | 'plan'; amount_cents: number; created: string; stripe_id: string };
type Result = { reg?: string; unmatched?: Unmatched };

const PROTECTED = ['comped', 'refunded'];   // set by hand in the office: never overwritten

async function applySession(s: Stripe.Checkout.Session): Promise<Result> {
  if (s.mode === 'subscription') {
    const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
    return subId ? applySubscription(subId, undefined, s) : {};
  }
  if (s.payment_status !== 'paid') return {};

  const email = s.customer_details?.email ?? s.customer_email ?? '';
  const reg = await findReg({ id: s.metadata?.registration_id ?? s.client_reference_id, sessionId: s.id, email });
  if (!reg) return { unmatched: { name: s.customer_details?.name ?? '', email, type: 'full', amount_cents: s.amount_total ?? 0, created: iso(s.created)!, stripe_id: s.id } };

  const option = await optionFor(s.metadata?.option_id, s.payment_link);
  await db.from('registrations').update({
    ...(PROTECTED.includes(reg.payment_status) ? {} : { payment_status: 'paid' }),
    payment_type: 'full', plan_status: null,
    payment_option_id: reg.payment_option_id ?? option?.id ?? null,
    amount_total_cents: s.amount_total, amount_paid_cents: s.amount_total,
    paid_at: reg.paid_at ?? iso(s.created), next_payment_at: null,
    stripe_customer_id: custId(s.customer) ?? reg.stripe_customer_id, stripe_session_id: s.id,
    stripe_synced_at: new Date().toISOString()
  }).eq('id', reg.id);
  return { reg: reg.id };
}

async function applySubscription(subId: string, sub?: Stripe.Subscription, session?: Stripe.Checkout.Session): Promise<Result> {
  sub ??= await stripe.subscriptions.retrieve(subId);
  if (!sub) return {};
  const customer = typeof sub.customer === 'string' ? await stripe.customers.retrieve(sub.customer) : sub.customer;
  const email = (customer as Stripe.Customer)?.email ?? session?.customer_details?.email ?? '';

  // Older subscriptions (from Stripe payment links) carry no registration id;
  // the checkout session that started them may.
  if (!sub.metadata?.registration_id && !session) {
    const ss = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
    session = ss.data[0];
  }
  const reg = await findReg({
    id: sub.metadata?.registration_id ?? session?.metadata?.registration_id ?? session?.client_reference_id,
    subId: sub.id, email
  });

  const item = sub.items.data[0];
  const each = (item?.price?.unit_amount ?? 0) * (item?.quantity ?? 1);
  if (!reg) return { unmatched: { name: (customer as Stripe.Customer)?.name ?? '', email, type: 'plan', amount_cents: each, created: iso(sub.created)!, stripe_id: sub.id } };

  const option = await optionFor(sub.metadata?.option_id ?? reg.payment_option_id, session?.payment_link);
  const total = parseInt(sub.metadata?.installments ?? '', 10) || reg.installments_total || option?.installments || null;

  let paidCount = 0, paidCents = 0, lastPaid: number | null = null;
  for await (const inv of stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 100 })) {
    if ((inv.amount_paid ?? 0) <= 0) continue;
    paidCount++; paidCents += inv.amount_paid;
    lastPaid = Math.max(lastPaid ?? 0, inv.status_transitions?.paid_at ?? inv.created);
  }

  const complete = !!total && paidCount >= total;
  let plan: 'active' | 'past_due' | 'cancelled' | 'completed';
  if (complete) plan = 'completed';
  else if (['canceled', 'incomplete_expired'].includes(sub.status)) plan = 'cancelled';
  else if (['past_due', 'unpaid', 'incomplete'].includes(sub.status)) plan = 'past_due';
  else plan = 'active';

  const pay = plan === 'completed' ? 'paid'
    : plan === 'active' ? 'plan'
    : plan === 'past_due' ? 'past_due'
    : paidCount > 0 ? 'past_due' : 'unpaid';   // cancelled before finishing: still owes the rest

  // A plan we created with a set number of payments stops itself once the last one is in.
  if (complete && sub.metadata?.installments && !['canceled', 'incomplete_expired'].includes(sub.status) && !sub.cancel_at_period_end) {
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  }

  const periodEnd = (sub as any).current_period_end ?? (item as any)?.current_period_end;
  await db.from('registrations').update({
    ...(PROTECTED.includes(reg.payment_status) ? {} : { payment_status: pay }),
    payment_type: 'plan', plan_status: plan,
    payment_option_id: reg.payment_option_id ?? option?.id ?? null,
    installment_cents: each || null, installments_total: total, installments_paid: paidCount,
    amount_paid_cents: paidCents, amount_total_cents: total ? each * total : null,
    paid_at: complete ? (reg.paid_at ?? iso(lastPaid)) : null,
    next_payment_at: plan === 'active' && !sub.cancel_at_period_end ? iso(periodEnd) : null,
    stripe_customer_id: custId(sub.customer), stripe_subscription_id: sub.id,
    stripe_synced_at: new Date().toISOString()
  }).eq('id', reg.id);
  return { reg: reg.id };
}

async function applyRefund(charge: Stripe.Charge) {
  if (!charge.refunded) return;   // partial refund: leave it for a human
  const cust = custId(charge.customer);
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  let reg = null;
  if (pi) {
    const ss = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
    if (ss.data[0]) reg = (await db.from('registrations').select('id').eq('stripe_session_id', ss.data[0].id).maybeSingle()).data;
  }
  if (!reg && cust) reg = (await db.from('registrations').select('id').eq('stripe_customer_id', cust).eq('payment_type', 'full')
    .order('created_at', { ascending: false }).limit(1)).data?.[0];
  if (reg) await db.from('registrations').update({ payment_status: 'refunded', stripe_synced_at: new Date().toISOString() }).eq('id', reg.id);
}

/* Find the registration a Stripe payment belongs to: by the id we attached,
   then by Stripe ids already saved, then by email (people who paid through
   the old Stripe links). Email matching prefers a registration that isn't
   linked to another payment yet. */
async function findReg(k: { id?: string | null; sessionId?: string; subId?: string; email?: string }) {
  if (k.id && UUID.test(k.id)) {
    const { data } = await db.from('registrations').select('*').eq('id', k.id).maybeSingle();
    if (data) return data;
  }
  if (k.subId) {
    const { data } = await db.from('registrations').select('*').eq('stripe_subscription_id', k.subId).limit(1);
    if (data?.[0]) return data[0];
  }
  if (k.sessionId) {
    const { data } = await db.from('registrations').select('*').eq('stripe_session_id', k.sessionId).limit(1);
    if (data?.[0]) return data[0];
  }
  const email = (k.email ?? '').trim();
  if (!email) return null;
  const { data } = await db.from('registrations').select('*')
    .ilike('email', email.replace(/[\\%_]/g, c => '\\' + c)).neq('status', 'declined')
    .order('created_at', { ascending: false });
  const free = (data ?? []).filter(r => !r.stripe_subscription_id && !(r.payment_type === 'full' && r.amount_paid_cents > 0));
  return free[0] ?? null;
}

const optionCache = new Map<string, any>();
async function optionFor(optionId?: string | null, paymentLink?: string | Stripe.PaymentLink | null) {
  if (optionId && UUID.test(optionId)) {
    const { data } = await db.from('payment_links').select('*').eq('id', optionId).maybeSingle();
    if (data) return data;
  }
  const plId = typeof paymentLink === 'string' ? paymentLink : paymentLink?.id;
  if (!plId) return null;
  if (!optionCache.has(plId)) {
    const pl = await stripe.paymentLinks.retrieve(plId);
    const { data } = await db.from('payment_links').select('*').eq('url', pl.url).limit(1);
    optionCache.set(plId, data?.[0] ?? null);
  }
  return optionCache.get(plId);
}

const custId = (c: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined) => typeof c === 'string' ? c : c?.id ?? null;
const iso = (t?: number | null) => t ? new Date(t * 1000).toISOString() : null;
