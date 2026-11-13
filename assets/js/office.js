/* ---------------------------------------------------------------
   office.js: the CRM side of the league office.
     Dashboard      what needs doing today
     People         everyone: rostered players, spares, APs, and
                    registrants not yet on a team
     Player profile details, contact, payment, stats, game log,
                    suspensions
     Suspensions    every suspension in the league
     Email lists    pick a group, copy their emails or open a BCC email
   Loaded before admin.js and uses its helpers (sb, esc, mount,
   toast, fmtDT, me, go, setCount) when the views run.
--------------------------------------------------------------- */

const fmtDay = iso => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: IVY_CONFIG.TIMEZONE || 'America/Toronto' });
const fullName = p => `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
const STATUS_CHIP = {
  active: ['Rostered', 'chip-ivy'], spare: ['Spare', 'chip-brass'], ap: ['AP', 'chip-brass'],
  inactive: ['Inactive', 'chip-grey'], registrant: ['Not on a team yet', 'chip-grey']
};
const PAY_CHIP = { paid: 'chip-ivy', comped: 'chip-ivy', plan: 'chip-brass', unpaid: 'chip-red', past_due: 'chip-red', refunded: 'chip-grey' };
const PAY_LABEL = { unpaid: 'Unpaid', plan: 'On plan', past_due: 'Past due', paid: 'Paid', refunded: 'Refunded', comped: 'Comped' };
/* Payment states that let an approved registration onto a roster (see supabase/stripe.sql). */
const ROSTER_READY = ['paid', 'plan', 'comped'];
const PAY_STATUSES = ['unpaid', 'plan', 'past_due', 'paid', 'refunded', 'comped'];
const chip = (text, cls) => `<span class="chip ${cls}">${esc(text)}</span>`;
const money = c => c == null ? '' : '$' + (c / 100).toLocaleString('en-CA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
/* Payment chip for a registration: "Paid", "On plan · 2/4", "Past due · 1/4"… */
const payChip = r => {
  if (!r) return '';
  let t = PAY_LABEL[r.payment_status] || r.payment_status;
  if (r.payment_type === 'plan' && ['plan', 'past_due'].includes(r.payment_status))
    t += r.installments_total ? ` · ${r.installments_paid ?? 0}/${r.installments_total}` : '';
  return chip(t, PAY_CHIP[r.payment_status] || 'chip-grey');
};
/* Still owes money: never paid, or a plan payment failed. Waitlisted people aren't chased. */
const owes = p => p.status !== 'inactive' && p.reg && p.reg.status !== 'waitlist' && ['unpaid', 'past_due'].includes(p.paid);
const remainingCents = r => r?.amount_total_cents != null ? Math.max(r.amount_total_cents - (r.amount_paid_cents || 0), 0) : null;
const isMissingTable = error => error && /relation|does not exist|schema cache/i.test(error.message || '');

/* Everyone the league knows about, one row per person. A player's
   contact details and payment come from their registration, when
   they have one (APs and hand-added players usually don't). */
async function loadPeople() {
  const [{ data: players }, { data: regs }, { data: teams }, susp] = await Promise.all([
    sb.from('players').select('*').order('last_name'),
    sb.from('registrations').select('*').order('created_at', { ascending: false }),
    sb.from('teams').select('id,name,division,roster_cap').order('name'),
    IvySusp.loadActive(sb)
  ]);
  const teamBy = new Map((teams || []).map(t => [t.id, t]));
  const regByPlayer = new Map();
  (regs || []).forEach(r => { if (r.player_id && !regByPlayer.has(r.player_id)) regByPlayer.set(r.player_id, r); });
  const suspBy = IvySusp.byPlayer(susp);

  const people = (players || []).map(p => {
    const r = regByPlayer.get(p.id);
    return {
      key: p.id, player: p, reg: r, name: fullName(p), status: p.status || 'active',
      team: teamBy.get(p.team_id), number: p.jersey_number, position: p.position,
      email: r?.email, phone: r?.phone, paid: r?.payment_status, susp: suspBy.get(p.id)
    };
  });
  /* registrations that haven't been put on a roster yet (declined ones are left out) */
  (regs || []).filter(r => !r.player_id && r.status !== 'declined').forEach(r => people.push({
    key: `r:${r.id}`, player: null, reg: r, name: fullName(r), status: 'registrant',
    team: teamBy.get(r.team_id), number: r.jersey_number, position: r.position,
    email: r.email, phone: r.phone, paid: r.payment_status, susp: null
  }));
  people.sort((a, b) => (a.player?.last_name ?? a.reg?.last_name ?? '').localeCompare(b.player?.last_name ?? b.reg?.last_name ?? '')
    || a.name.localeCompare(b.name));
  return { people, players: players || [], regs: regs || [], teams: teams || [], susp };
}

/* Sidebar badges: new registrations waiting for a decision. */
async function refreshCounts() {
  const { count } = await sb.from('registrations').select('id', { count: 'exact', head: true }).eq('status', 'new');
  setCount('regs', count || 0);
}

/* ================= Dashboard ================= */
async function dashView() {
  mount(`<p class="text-sm text-gray-500">Loading…</p>`);
  const now = Date.now();
  const [{ people, regs, teams, susp }, { data: games }] = await Promise.all([
    loadPeople(),
    sb.from('games').select('*, home:home_team_id(name), away:away_team_id(name)')
      .gte('starts_at', new Date(now - 14 * 864e5).toISOString())
      .lte('starts_at', new Date(now + 14 * 864e5).toISOString()).order('starts_at')
  ]);
  if (view !== 'home') return;   // they clicked away while it loaded

  const newRegs = regs.filter(r => r.status === 'new');
  const unpaid = people.filter(p => owes(p) && p.paid === 'unpaid');
  const pastDue = people.filter(p => owes(p) && p.paid === 'past_due');
  const waitlist = regs.filter(r => r.status === 'waitlist');
  const rostered = people.filter(p => p.status === 'active');
  const open = (games || []).filter(g => g.status !== 'final' && g.status !== 'postponed' && new Date(g.starts_at).getTime() < now - 3 * 36e5);
  const upcoming = (games || []).filter(g => new Date(g.starts_at).getTime() > now - 2 * 36e5 && g.status !== 'final').slice(0, 6);
  const weekGames = (games || []).filter(g => { const t = new Date(g.starts_at).getTime(); return t > now && t < now + 7 * 864e5; });
  const counts = new Map();
  people.forEach(p => { if (p.player && p.status === 'active' && p.player.team_id) counts.set(p.player.team_id, (counts.get(p.player.team_id) || 0) + 1); });
  const full = teams.filter(t => t.roster_cap && (counts.get(t.id) || 0) > t.roster_cap);
  setCount('regs', newRegs.length);

  const todo = [
    newRegs.length && ['regs', '', `${newRegs.length} new registration${newRegs.length === 1 ? '' : 's'} to review`, 'Approve them onto a team, waitlist, or decline.', 'var(--brass)'],
    pastDue.length && ['people', 'f:pastdue', `${pastDue.length} payment plan${pastDue.length === 1 ? '' : 's'} past due`, 'A plan payment failed or the plan was cancelled with money still owing.', '#B3261E'],
    unpaid.length && ['people', 'f:unpaid', `${unpaid.length} player${unpaid.length === 1 ? ' hasn’t' : 's haven’t'} paid`, 'Registrations still marked unpaid.', '#B3261E'],
    open.length && ['sched', '', `${open.length} game${open.length === 1 ? '' : 's'} not finalized`, 'Played, but the score sheet was never closed, so standings are missing them.', '#B3261E'],
    full.length && ['teams', '', `${full.map(t => t.name).join(', ')} over the roster cap`, 'More rostered players than the team allows.', 'var(--brass)'],
    waitlist.length && ['regs', '', `${waitlist.length} on the waitlist`, 'Registrations waiting for a spot.', 'var(--ivy-sprig)']
  ].filter(Boolean);

  const stat = (n, label, key, arg = '', cls = '') =>
    `<button class="stat ${cls}" data-go="${key}" data-arg="${esc(arg)}"><div class="n">${n}</div><div class="l">${label}</div></button>`;

  mount(`
    <div class="mb-6">
      <h2 class="display text-3xl">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${me.full_name ? ', ' + esc(me.full_name.split(' ')[0]) : ''}</h2>
      <p class="text-sm text-gray-600 mt-1">Here's where the league stands today.</p>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8">
      ${stat(rostered.length, 'Rostered players', 'people', 'f:active')}
      ${stat(newRegs.length, 'New registrations', 'regs', '', newRegs.length ? 'warn' : '')}
      ${stat(unpaid.length, 'Unpaid', 'people', 'f:unpaid', unpaid.length ? 'bad' : '')}
      ${stat(susp.length, 'Suspended now', 'susp', '', susp.length ? 'warn' : '')}
      ${stat(weekGames.length, 'Games this week', 'sched')}
    </div>

    <div class="grid lg:grid-cols-[1.3fr,1fr] gap-6">
      <section>
        <div class="rule mb-3">Needs attention</div>
        <div class="panel">
          ${todo.length ? todo.map(([k, arg, title, sub, colour]) => `
            <button class="todo" data-go="${k}" data-arg="${esc(arg)}">
              <span class="dot" style="background:${colour}"></span>
              <span class="flex-1"><b class="text-sm">${esc(title)}</b><span class="block text-xs text-gray-500 mt-0.5">${esc(sub)}</span></span>
              <span class="text-xs font-semibold" style="color:var(--ivy)">Open →</span>
            </button>`).join('')
          : `<p class="p-5 text-sm text-gray-600">Nothing waiting on you. Nice.</p>`}
        </div>

        <div class="rule mt-8 mb-3">Latest registrations</div>
        <div class="panel">
          ${regs.slice(0, 6).map(r => `
            <button class="todo" data-go="player" data-arg="${r.player_id || 'r:' + r.id}">
              <span class="flex-1 text-sm"><b>${esc(fullName(r))}</b>
                <span class="block text-xs text-gray-500">${esc(r.division ?? '')} · ${fmtDay(r.created_at)}</span></span>
              ${chip(r.status, r.status === 'new' ? 'chip-brass' : r.status === 'approved' ? 'chip-ivy' : 'chip-grey')}
              ${payChip(r)}
            </button>`).join('') || '<p class="p-5 text-sm text-gray-600">No registrations yet.</p>'}
        </div>
      </section>

      <section>
        <div class="rule mb-3">Coming up</div>
        <div class="panel">
          ${upcoming.map(g => `
            <button class="todo" data-go="score">
              <span class="flex-1 text-sm"><b>${esc(g.away?.name ?? 'TBD')} at ${esc(g.home?.name ?? 'TBD')}</b>
                <span class="block text-xs text-gray-500">${fmtDT(g.starts_at)} · ${esc(g.division ?? '')}</span></span>
              ${g.status === 'live' ? '<span class="text-xs font-bold text-red-600 pulse-live">Live</span>' : ''}
            </button>`).join('') || '<p class="p-5 text-sm text-gray-600">No games in the next two weeks.</p>'}
        </div>

        <div class="rule mt-8 mb-3">Quick actions</div>
        <div class="grid grid-cols-2 gap-2">
          <button class="btn btn-quiet !text-sm" data-go="comms">Email a group</button>
          <button class="btn btn-quiet !text-sm" data-go="people" data-arg="f:registrant">Place registrants</button>
          <button class="btn btn-quiet !text-sm" data-go="news">Post news</button>
          <button class="btn btn-quiet !text-sm" data-go="sched">Edit schedule</button>
          <button class="btn btn-quiet !text-sm col-span-2" data-go="people" data-arg="f:plan">Payment plans</button>
        </div>
      </section>
    </div>`);

  document.getElementById('view').addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    go(b.dataset.go, b.dataset.arg || undefined);
  });
}

/* ================= People ================= */
const PEOPLE_FILTERS = [
  ['all', 'Everyone', p => p.status !== 'inactive'],
  ['active', 'Rostered', p => p.status === 'active'],
  ['spare', 'Spares', p => p.status === 'spare'],
  ['ap', 'APs', p => p.status === 'ap'],
  ['registrant', 'Not on a team', p => p.status === 'registrant'],
  ['unpaid', 'Unpaid', p => owes(p) && p.paid === 'unpaid'],
  ['pastdue', 'Past due', p => owes(p) && p.paid === 'past_due'],
  ['plan', 'Payment plans', p => p.status !== 'inactive' && p.reg?.payment_type === 'plan'],
  ['full', 'Paid in full', p => p.status !== 'inactive' && p.reg?.payment_type === 'full' && p.paid === 'paid'],
  ['suspended', 'Suspended', p => !!p.susp],
  ['inactive', 'Inactive', p => p.status === 'inactive']
];

async function peopleView(arg) {
  mount(`<p class="text-sm text-gray-500">Loading…</p>`);
  const { people, teams } = await loadPeople();
  if (view !== 'people') return;

  let filter = arg?.startsWith('f:') ? arg.slice(2) : 'all';
  let q = arg && !arg.startsWith('f:') ? arg : '';
  let team = '';
  if (!PEOPLE_FILTERS.some(([k]) => k === filter)) filter = 'all';
  document.getElementById('office-q').value = '';

  mount(`
    <div class="flex flex-wrap items-end justify-between gap-4 mb-5">
      <div>
        <h2 class="display text-3xl">People</h2>
        <p id="ppl-sub" class="text-sm text-gray-600 mt-1"></p>
      </div>
      <div class="flex flex-wrap gap-2">
        ${me.role === 'admin' ? '<button id="ppl-sync" class="btn btn-quiet !text-sm" title="Match every Stripe payment and plan from the past year to a registration">Sync with Stripe</button>' : ''}
        <button id="ppl-csv" class="btn btn-quiet !text-sm">Download CSV</button>
      </div>
    </div>
    ${syncReport()}
    <div class="flex flex-wrap gap-2 mb-3" id="ppl-filters">
      ${PEOPLE_FILTERS.map(([k, l, fn]) => `<button data-f="${k}" class="chip !text-xs !px-3 !py-1.5">${l} <span class="opacity-60">${people.filter(fn).length}</span></button>`).join('')}
    </div>
    <div class="grid sm:grid-cols-[1fr,16rem] gap-2 mb-4">
      <input id="ppl-q" type="search" class="field" placeholder="Search by name, email, phone or number" value="${esc(q)}" autocomplete="off">
      <select id="ppl-team" class="field"><option value="">All teams</option>
        ${teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
    </div>
    <div class="panel overflow-x-auto">
      <table class="grid-table">
        <thead><tr><th>Name</th><th>#</th><th>Pos</th><th>Team</th><th>Status</th><th>Paid</th><th>Contact</th></tr></thead>
        <tbody id="ppl-body"></tbody>
      </table>
    </div>`);

  let shown = [];
  const draw = () => {
    const fn = PEOPLE_FILTERS.find(([k]) => k === filter)[2];
    const needle = q.toLowerCase().replace(/^#/, '');
    shown = people.filter(fn)
      .filter(p => !team || p.team?.id === team)
      .filter(p => !needle || [p.name, p.email, p.phone, p.number != null ? String(p.number) : '', p.team?.name]
        .some(v => v && String(v).toLowerCase().includes(needle)));
    document.querySelectorAll('#ppl-filters [data-f]').forEach(b => {
      b.classList.toggle('chip-ivy', b.dataset.f !== filter);
      b.style.cssText = b.dataset.f === filter ? 'background:var(--ivy);color:#fff' : '';
    });
    document.getElementById('ppl-sub').textContent = `${shown.length} ${shown.length === 1 ? 'person' : 'people'}`;
    document.getElementById('ppl-body').innerHTML = shown.map(p => {
      const [sl, sc] = STATUS_CHIP[p.status] || [p.status, 'chip-grey'];
      return `
      <tr class="clickrow" data-person="${p.key}">
        <td class="font-semibold whitespace-nowrap">${esc(p.name)}
          ${p.susp ? `<span class="chip chip-red ml-1">Suspended</span>` : ''}</td>
        <td>${p.number ?? ''}</td>
        <td>${esc(p.position ?? '')}</td>
        <td class="whitespace-nowrap">${esc(p.team?.name ?? '')}</td>
        <td>${chip(sl, sc)}</td>
        <td class="whitespace-nowrap">${p.paid ? payChip(p.reg) : '<span class="text-xs text-gray-400">no registration</span>'}</td>
        <td class="text-xs">${esc(p.email ?? '')}${p.phone ? `<br><span class="text-gray-500">${esc(p.phone)}</span>` : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="text-sm text-gray-500">Nobody matches.</td></tr>';
  };
  draw();

  document.getElementById('ppl-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    filter = b.dataset.f; draw();
  });
  document.getElementById('ppl-q').addEventListener('input', e => { q = e.target.value.trim(); draw(); });
  document.getElementById('ppl-team').addEventListener('change', e => { team = e.target.value; draw(); });
  document.getElementById('ppl-body').addEventListener('click', e => {
    const r = e.target.closest('[data-person]'); if (r) go('player', r.dataset.person);
  });
  document.getElementById('ppl-csv').onclick = () => {
    const rows = [['name', 'number', 'position', 'team', 'division', 'status', 'paid', 'payment type', 'amount paid', 'remaining', 'payments made', 'next payment', 'email', 'phone', 'suspended']]
      .concat(shown.map(p => [p.name, p.number ?? '', p.position ?? '', p.team?.name ?? '', p.team?.division ?? '',
        (STATUS_CHIP[p.status] || [p.status])[0], p.paid ? PAY_LABEL[p.paid] ?? p.paid : '',
        p.reg?.payment_type === 'plan' ? 'payment plan' : p.reg?.payment_type === 'full' ? 'full payment' : '',
        p.reg?.amount_paid_cents ? money(p.reg.amount_paid_cents) : '', remainingCents(p.reg) != null ? money(remainingCents(p.reg)) : '',
        p.reg?.payment_type === 'plan' ? `${p.reg.installments_paid ?? 0}${p.reg.installments_total ? ' of ' + p.reg.installments_total : ''}` : '',
        p.reg?.next_payment_at ? fmtDay(p.reg.next_payment_at) : '',
        p.email ?? '', p.phone ?? '', p.susp ? p.susp.label : '']));
    downloadCsv(rows, `ivy-people-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const syncBtn = document.getElementById('ppl-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    const out = await syncStripe(syncBtn);
    if (out) peopleView(`f:${filter}`);
  };
  const hide = document.getElementById('sync-hide');
  if (hide) hide.onclick = () => { lastSync = null; document.getElementById('sync-report').remove(); };
}

/* ================= Stripe sync ================= */
/* Asks the Stripe edge function to look back through the past year of
   Stripe payments and plans and update every registration it can match.
   Returns the result, or null (after a toast) if it failed. */
let lastSync = null;
async function syncStripe(btn) {
  const idle = btn.textContent;
  btn.disabled = true; btn.textContent = 'Syncing with Stripe…';
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${IVY_CONFIG.SUPABASE_URL}/functions/v1/stripe/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: IVY_CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token}` },
      body: '{}'
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(res.status === 404 ? 'The Stripe function isn’t set up in Supabase yet (see STRIPE-SETUP.md).' : out.error || out.msg || 'Sync with Stripe failed.', false);
      return null;
    }
    lastSync = out;
    toast(`Synced ${out.matched} registration${out.matched === 1 ? '' : 's'} with Stripe.`);
    return out;
  } catch {
    toast('Could not reach the Stripe function.', false);
    return null;
  } finally { btn.disabled = false; btn.textContent = idle; }
}

/* The last sync's leftovers: Stripe payments that didn't match any
   registration (a different email, or someone who never registered). */
function syncReport() {
  if (!lastSync) return '';
  const u = lastSync.unmatched || [];
  return `
    <div id="sync-report" class="panel p-5 mb-5" style="border-color:${u.length ? 'var(--brass)' : 'var(--ivy)'}">
      <div class="flex justify-between gap-3 mb-2">
        <p class="font-semibold text-sm">Stripe sync: ${lastSync.matched} registration${lastSync.matched === 1 ? '' : 's'} up to date.
          ${u.length ? `${u.length} Stripe payment${u.length === 1 ? '' : 's'} didn’t match anyone.` : 'Every Stripe payment matched a registration.'}</p>
        <button id="sync-hide" class="text-xs underline text-gray-500">Hide</button>
      </div>
      ${u.length ? `<p class="text-xs text-gray-600 mb-3">Usually they paid with a different email than they registered with. Fix the email on their
        registration (or ask them to register), then sync again.</p>
      <div class="overflow-x-auto"><table class="grid-table !text-sm">
        <thead><tr><th>Name on Stripe</th><th>Email on Stripe</th><th>Type</th><th>Amount</th><th>Date</th></tr></thead>
        <tbody>${u.map(x => `<tr><td>${esc(x.name || '—')}</td><td>${esc(x.email || '—')}</td>
          <td>${x.type === 'plan' ? 'Payment plan' : 'Full payment'}</td><td>${money(x.amount_cents)}${x.type === 'plan' ? ' each' : ''}</td>
          <td class="whitespace-nowrap">${fmtDay(x.created)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`;
}

/* Payment details on a player's profile. */
function payBlock(r) {
  const plan = r.payment_type === 'plan';
  const rem = remainingCents(r);
  const PLAN_LABEL = { active: 'Active, payments up to date', past_due: 'Past due: last payment failed', cancelled: 'Cancelled', completed: 'Finished: paid in full' };
  const rows = [
    ['How they pay', plan ? 'Payment plan' : r.payment_type === 'full' ? 'One full payment' : 'Not paid through Stripe yet'],
    plan && r.plan_status && ['Plan', PLAN_LABEL[r.plan_status] || r.plan_status],
    plan && r.installment_cents && ['Each payment', money(r.installment_cents)],
    plan && ['Payments made', `${r.installments_paid ?? 0}${r.installments_total ? ` of ${r.installments_total}` : ''}`],
    r.amount_paid_cents > 0 && ['Paid so far', money(r.amount_paid_cents)],
    rem != null && r.payment_type && ['Remaining', rem ? money(rem) : 'Nothing'],
    plan && r.next_payment_at && ['Next payment', fmtDay(r.next_payment_at)],
    r.paid_at && ['Paid in full', fmtDay(r.paid_at)],
    (r.stripe_subscription_id || r.stripe_customer_id) && ['Stripe', `<a class="underline" target="_blank" rel="noopener" href="https://dashboard.stripe.com/${
      r.stripe_subscription_id ? 'subscriptions/' + esc(r.stripe_subscription_id) : 'customers/' + esc(r.stripe_customer_id)}">Open in Stripe ↗</a>`]
  ].filter(Boolean);
  return `<dl class="kv mb-3">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === 'Stripe' ? v : esc(v)}</dd>`).join('')}</dl>
    ${r.stripe_synced_at ? `<p class="text-xs text-gray-500 mb-3">Updated from Stripe ${fmtDay(r.stripe_synced_at)}.</p>` : ''}`;
}

function downloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

/* ================= Player profile ================= */
async function playerView(key) {
  if (!key) return go('people');
  mount(`<p class="text-sm text-gray-500">Loading…</p>`);
  const regOnly = key.startsWith('r:');
  const id = regOnly ? key.slice(2) : key;

  const { data: teams } = await sb.from('teams').select('id,name,division').order('name');
  let p = null, reg = null;
  if (regOnly) {
    reg = (await sb.from('registrations').select('*').eq('id', id).maybeSingle()).data;
  } else {
    p = (await sb.from('players').select('*').eq('id', id).maybeSingle()).data;
    reg = (await sb.from('registrations').select('*').eq('player_id', id).order('created_at', { ascending: false }).limit(1)).data?.[0] || null;
  }
  if (view !== 'player') return;
  if (!p && !reg) {
    mount(`<button data-back class="text-sm font-semibold mb-4" style="color:var(--ivy)">← People</button>
      <p class="text-sm text-gray-600">That person isn't in the database any more.</p>`);
    document.querySelector('[data-back]').onclick = () => go('people');
    return;
  }

  const [statsRes, eventsRes, suspRes, active] = p ? await Promise.all([
    sb.from('player_stats').select('*').eq('player_id', id).maybeSingle(),
    sb.from('game_events').select('*, game:game_id(starts_at, home:home_team_id(name), away:away_team_id(name))')
      .or(`player_id.eq.${id},assist1_id.eq.${id},assist2_id.eq.${id}`).order('created_at', { ascending: false }).limit(40),
    sb.from('suspensions').select('*').eq('player_id', id).order('created_at', { ascending: false }),
    IvySusp.loadActive(sb)
  ]) : [{}, {}, {}, []];
  const stats = statsRes.data;
  const events = eventsRes.data || [];
  const suspAll = suspRes.data || [];
  const activeBy = new Map(active.filter(s => s.player_id === id).map(s => [s.id, s]));
  const team = (teams || []).find(t => t.id === (p?.team_id ?? reg?.team_id));
  const name = fullName(p || reg);
  const status = p ? p.status : 'registrant';
  const [sl, sc] = STATUS_CHIP[status] || [status, 'chip-grey'];

  const teamOpts = sel => `<option value="">No team</option>` +
    (teams || []).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const opt = (vals, sel) => vals.map(v => `<option ${v === sel ? 'selected' : ''}>${v}</option>`).join('');

  const eventLine = e => {
    const g = e.game;
    const vs = g ? `${esc(g.away?.name ?? '?')} at ${esc(g.home?.name ?? '?')}` : '';
    const what = e.type === 'goal'
      ? (e.player_id === id ? '<b>Goal</b>' : 'Assist')
      : e.type === 'penalty' ? `<b class="text-red-800">${e.minutes ?? 2} min</b> ${esc(e.infraction ?? 'penalty')}` : esc(e.type);
    return `<tr><td class="whitespace-nowrap text-gray-500">${g ? fmtDay(g.starts_at) : ''}</td><td>${vs}</td>
      <td>${what}</td><td class="text-gray-500 whitespace-nowrap">${e.period ? ordinal(e.period) : ''} ${esc(e.clock ?? '')}</td></tr>`;
  };

  mount(`
    <button data-back class="text-sm font-semibold mb-4" style="color:var(--ivy)">← People</button>

    <div class="panel-deep p-6 mb-6 flex flex-wrap items-center gap-5">
      <div class="scoreline text-5xl w-20 text-center" style="color:var(--brass-soft)">${(p ?? reg).jersey_number ?? '–'}</div>
      <div class="flex-1 min-w-0">
        <h2 class="display text-3xl">${esc(name)}</h2>
        <p class="text-sm text-white/70 mt-1">${esc((p ?? reg).position ?? '')}${team ? ` · ${esc(team.name)} · ${esc(team.division)}` : ''}</p>
        <div class="flex flex-wrap gap-2 mt-3">
          ${chip(sl, sc)}
          ${reg ? payChip(reg) : ''}
          ${[...activeBy.values()].map(s => chip(`Suspended · ${s.label}`, 'chip-red')).join('')}
        </div>
      </div>
      ${stats ? `<div class="grid grid-cols-4 gap-5 text-center">
        ${[['G', stats.goals], ['A', stats.assists], ['PTS', stats.points], ['PIM', stats.pim]].map(([l, n]) =>
          `<div><div class="scoreline text-3xl">${n ?? 0}</div><div class="text-[11px] text-white/60 mt-1">${l}</div></div>`).join('')}
      </div>` : ''}
    </div>

    <div class="grid lg:grid-cols-2 gap-6">
      <div class="grid gap-6 content-start">
        ${p ? `
        <section class="panel p-5">
          <div class="rule mb-4">Player details</div>
          <form id="pf" class="grid grid-cols-2 gap-3">
            <div><label class="label">First name</label><input class="field" name="first_name" value="${esc(p.first_name)}" required></div>
            <div><label class="label">Last name</label><input class="field" name="last_name" value="${esc(p.last_name)}" required></div>
            <div><label class="label">Number</label><input class="field" name="jersey_number" type="number" min="0" max="99" value="${p.jersey_number ?? ''}"></div>
            <div><label class="label">Position</label><select class="field" name="position">${opt(['Forward', 'Defence', 'Goalie'], p.position)}</select></div>
            <div><label class="label">Team</label><select class="field" name="team_id">${teamOpts(p.team_id)}</select></div>
            <div><label class="label">Status</label><select class="field" name="status">
              ${[['active', 'Rostered'], ['spare', 'Spare'], ['ap', 'AP'], ['inactive', 'Inactive']].map(([v, l]) =>
                `<option value="${v}" ${v === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="col-span-2"><button class="btn btn-primary">Save details</button></div>
          </form>
        </section>` : `
        <section class="panel p-5" style="border-color:var(--brass)">
          <div class="rule mb-2">Not on a roster yet</div>
          <p class="text-sm text-gray-600 mb-3">This is a registration (${esc(reg.status)}). Pick a team and approve it to put ${esc(reg.first_name)} on the roster.
            ${ROSTER_READY.includes(reg.payment_status) ? '' : `<b class="text-red-800">They haven't paid yet,</b> so once approved they join the roster automatically when payment is complete (or mark them Comped below).`}</p>
          <div class="flex flex-wrap gap-2">
            <select id="rq-team" class="field !w-auto flex-1">${teamOpts(reg.team_id)}</select>
            <button id="rq-approve" class="btn btn-primary">Approve onto team</button>
            <button id="rq-wait" class="btn btn-quiet">Waitlist</button>
          </div>
        </section>`}

        <section class="panel p-5">
          <div class="rule mb-4">Contact and registration</div>
          ${reg ? `
          <dl class="kv mb-4">
            <dt>Email</dt><dd><a class="underline" href="mailto:${esc(reg.email)}">${esc(reg.email)}</a></dd>
            <dt>Phone</dt><dd>${reg.phone ? `<a class="underline" href="tel:${esc(reg.phone)}">${esc(reg.phone)}</a>` : '—'}</dd>
            <dt>Emergency</dt><dd>${esc(reg.emergency_name ?? '—')} ${reg.emergency_phone ? '· ' + esc(reg.emergency_phone) : ''}</dd>
            <dt>Division asked</dt><dd>${esc(reg.division ?? '—')}</dd>
            <dt>Shirt size</dt><dd>${esc(reg.shirt_size ?? '—')}</dd>
            <dt>Terms</dt><dd>${reg.terms_accepted_at
              ? `Agreed ${fmtDay(reg.terms_accepted_at)} · <a class="underline" href="terms.html" target="_blank" rel="noopener">version ${esc(reg.terms_version ?? '?')}</a>`
              : reg.waiver_accepted ? 'Accepted the waiver (before Terms and Conditions existed)' : '<span class="text-red-800 font-semibold">Not accepted</span>'}</dd>
            <dt>Registered</dt><dd>${fmtDay(reg.created_at)}</dd>
            ${reg.notes ? `<dt>Their note</dt><dd class="serif">${esc(reg.notes)}</dd>` : ''}
          </dl>
        </section>

        <section class="panel p-5">
          <div class="rule mb-4">Payment</div>
          ${payBlock(reg)}
          <label class="label" for="pay">Payment status</label>
          <select id="pay" class="field !w-48">${PAY_STATUSES.map(v => `<option value="${v}" ${v === reg.payment_status ? 'selected' : ''}>${PAY_LABEL[v]}</option>`).join('')}</select>
          <p class="text-xs text-gray-500 mt-2">Stripe keeps this up to date by itself. Change it by hand for cash, e-transfer or a comp;
            Stripe won't overwrite Comped or Refunded.</p>`
          : `<p class="text-sm text-gray-600">No registration on file${status === 'ap' ? ': APs check in at the rink and don’t register' : ''}, so there are no contact details or payment to show.</p>`}
        </section>
      </div>

      <div class="grid gap-6 content-start">
        ${p ? `
        <section class="panel p-5">
          <div class="rule mb-4">Suspensions</div>
          <div id="sus-hist" class="mb-4">
            ${suspAll.length ? suspAll.map(s => {
              const a = activeBy.get(s.id);
              return `<div class="flex items-start gap-3 text-sm py-2 border-b" style="border-color:var(--line)">
                <span class="flex-1">${a ? chip('Active', 'chip-red') : chip(s.lifted_at ? 'Lifted' : 'Served', 'chip-grey')}
                  <b class="ml-1">${s.games ? `${s.games} game${s.games === 1 ? '' : 's'}` : s.until_date ? `Until ${esc(s.until_date)}` : 'Until further notice'}</b>
                  ${a ? `<span class="text-red-800">· ${esc(a.label)}</span>` : ''}
                  <span class="block text-xs text-gray-500">${fmtDay(s.created_at)}${s.reason ? ' · ' + esc(s.reason) : ''}</span></span>
                ${a ? `<button data-lift="${s.id}" class="text-xs text-red-700 hover:underline">Lift</button>` : ''}
              </div>`; }).join('') : '<p class="text-sm text-gray-600">Clean record.</p>'}
          </div>
          <details>
            <summary class="text-sm font-semibold cursor-pointer" style="color:var(--ivy)">Add a suspension</summary>
            <div class="grid grid-cols-2 gap-3 mt-3">
              <select id="s-kind" class="field"><option value="games">Number of games</option><option value="until">Until a date</option><option value="open">Until further notice</option></select>
              <input id="s-games" class="field" type="number" min="1" value="1" aria-label="Games">
              <input id="s-until" class="field hidden" type="date" aria-label="Until">
              <input id="s-reason" class="field col-span-2" placeholder="Reason (shows on the public roster)">
              <button id="s-add" class="btn btn-brass col-span-2">Suspend ${esc(p.first_name)}</button>
            </div>
          </details>
        </section>

        <section class="panel p-5">
          <div class="rule mb-3">Game log</div>
          ${events.length ? `<table class="grid-table !text-sm"><tbody>${events.map(eventLine).join('')}</tbody></table>`
            : '<p class="text-sm text-gray-600">No goals, assists or penalties recorded yet.</p>'}
        </section>` : ''}
      </div>
    </div>`);

  const $ = s => document.getElementById(s);
  document.querySelector('[data-back]').onclick = () => history.length > 1 ? history.back() : go('people');

  if (p) {
    $('pf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const row = {
        first_name: f.first_name.trim(), last_name: f.last_name.trim(),
        jersey_number: f.jersey_number === '' ? null : parseInt(f.jersey_number, 10),
        position: f.position, team_id: f.team_id || null, status: f.status
      };
      const { error } = await sb.from('players').update(row).eq('id', id);
      /* keep the registration in step so the roster trigger doesn't undo the change later */
      if (!error && reg && (reg.team_id !== row.team_id || reg.jersey_number !== row.jersey_number || reg.position !== row.position)) {
        await sb.from('registrations').update({ team_id: row.team_id, jersey_number: row.jersey_number, position: row.position }).eq('id', reg.id);
      }
      toast(error ? 'Could not save.' : 'Saved.', !error);
      if (!error) playerView(key);
    });

    $('s-kind').onchange = e => {
      $('s-games').classList.toggle('hidden', e.target.value !== 'games');
      $('s-until').classList.toggle('hidden', e.target.value !== 'until');
    };
    $('s-add').onclick = async () => {
      const kind = $('s-kind').value;
      const games = kind === 'games' ? parseInt($('s-games').value, 10) : null;
      const until = kind === 'until' ? $('s-until').value : null;
      if (kind === 'games' && !(games > 0)) return toast('Enter how many games.', false);
      if (kind === 'until' && !until) return toast('Pick the date it runs until.', false);
      const { error } = await sb.from('suspensions').insert({
        player_id: id, team_id: p.team_id, games, until_date: until,
        reason: $('s-reason').value.trim() || null, created_by: me.id
      });
      if (error) return toast(isMissingTable(error) ? 'Suspensions are not set up in the database yet. Run supabase/suspensions.sql.' : 'Suspension did not save.', false);
      toast('Suspension recorded. It now shows on the roster.');
      playerView(key);
    };
    $('sus-hist').addEventListener('click', async e => {
      const b = e.target.closest('[data-lift]'); if (!b) return;
      if (!confirm('Lift this suspension?')) return;
      const { error } = await sb.from('suspensions').update({ lifted_at: new Date().toISOString(), lifted_by: me.id }).eq('id', b.dataset.lift);
      toast(error ? 'Could not lift it.' : 'Suspension lifted.', !error);
      playerView(key);
    });
  } else {
    const setReg = async (patch, msg) => {
      const { error } = await sb.from('registrations').update(patch).eq('id', reg.id);
      if (error) return toast('Could not update that registration.', false);
      toast(msg); refreshCounts();
      const fresh = (await sb.from('registrations').select('player_id').eq('id', reg.id).single()).data;
      go('player', fresh?.player_id || key);
    };
    $('rq-approve').onclick = () => {
      const t = $('rq-team').value;
      if (!t) return toast('Pick a team first.', false);
      setReg({ team_id: t, status: 'approved' }, ROSTER_READY.includes(reg.payment_status)
        ? `${reg.first_name} is on the roster.` : `Approved. ${reg.first_name} joins the roster once payment is complete.`);
    };
    $('rq-wait').onclick = () => setReg({ status: 'waitlist' }, 'Moved to the waitlist.');
  }

  if (reg) $('pay').onchange = async e => {
    const { error } = await sb.from('registrations').update({ payment_status: e.target.value }).eq('id', reg.id);
    toast(error ? 'Could not update payment.' : `Marked ${PAY_LABEL[e.target.value] || e.target.value}.`, !error);
  };
}

/* ================= Suspensions ================= */
async function suspView() {
  mount(`<p class="text-sm text-gray-500">Loading…</p>`);
  const [{ data: all, error }, active, { data: players }, { data: teams }] = await Promise.all([
    sb.from('suspensions').select('*').order('created_at', { ascending: false }).limit(200),
    IvySusp.loadActive(sb),
    sb.from('players').select('id,first_name,last_name,jersey_number,team_id').neq('status', 'inactive').order('last_name'),
    sb.from('teams').select('id,name').order('name')
  ]);
  if (view !== 'susp') return;
  if (isMissingTable(error)) {
    mount(`<h2 class="display text-3xl mb-3">Suspensions</h2>
      <p class="text-sm text-gray-600 max-w-xl">Suspensions aren't set up in the database yet. Paste <code>supabase/suspensions.sql</code> into the Supabase SQL editor and run it once.</p>`);
    return;
  }
  const pBy = new Map((players || []).map(p => [p.id, p]));
  const tBy = new Map((teams || []).map(t => [t.id, t.name]));
  const activeBy = new Map(active.map(s => [s.id, s]));
  const past = (all || []).filter(s => !activeBy.has(s.id));
  const who = s => { const p = pBy.get(s.player_id); return p ? fullName(p) : 'Removed player'; };
  const length = s => s.games ? `${s.games} game${s.games === 1 ? '' : 's'}` : s.until_date ? `Until ${fmtDay(s.until_date + 'T12:00:00')}` : 'Until further notice';

  mount(`
    <h2 class="display text-3xl mb-1">Suspensions</h2>
    <p class="text-sm text-gray-600 mb-6 max-w-2xl">Game-count suspensions count down by themselves as the player's team finalizes games.
      Suspended players show on the public roster and on the scorekeeper's game sheet. Add one here, from a player's profile, or from the game sheet.</p>

    <div class="rule mb-3">Suspended now · ${active.length}</div>
    <div class="panel overflow-x-auto mb-8">
      <table class="grid-table">
        <thead><tr><th>Player</th><th>Team</th><th>Length</th><th>Left</th><th>Reason</th><th>Issued</th><th></th></tr></thead>
        <tbody>${active.map(s => `
          <tr>
            <td class="font-semibold"><button class="underline" data-player="${s.player_id}">${esc(who(s))}</button></td>
            <td>${esc(tBy.get(s.team_id) ?? '')}</td><td>${length(s)}</td>
            <td class="text-red-800 font-semibold">${esc(s.label)}</td>
            <td class="text-sm">${esc(s.reason ?? '')}</td>
            <td class="text-gray-500 whitespace-nowrap">${fmtDay(s.created_at)}</td>
            <td><button data-lift="${s.id}" class="text-xs text-red-700 hover:underline">Lift</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="text-sm text-gray-500">Nobody is suspended.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="grid lg:grid-cols-[1fr,22rem] gap-6 items-start">
      <section>
        <div class="rule mb-3">History</div>
        <div class="panel overflow-x-auto">
          <table class="grid-table">
            <thead><tr><th>Player</th><th>Length</th><th>Reason</th><th>Issued</th><th>Ended</th></tr></thead>
            <tbody>${past.map(s => `
              <tr><td><button class="underline" data-player="${s.player_id}">${esc(who(s))}</button></td><td>${length(s)}</td>
                <td class="text-sm">${esc(s.reason ?? '')}</td><td class="text-gray-500 whitespace-nowrap">${fmtDay(s.created_at)}</td>
                <td class="text-gray-500">${s.lifted_at ? 'Lifted ' + fmtDay(s.lifted_at) : 'Served'}</td></tr>`).join('')
              || '<tr><td colspan="5" class="text-sm text-gray-500">No past suspensions.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel p-5">
        <div class="rule mb-3">Add a suspension</div>
        <div class="grid gap-3">
          <select id="s-player" class="field"><option value="">Pick a player</option>
            ${(teams || []).map(t => `<optgroup label="${esc(t.name)}">${(players || []).filter(p => p.team_id === t.id)
              .map(p => `<option value="${p.id}">${esc(fullName(p))}${p.jersey_number != null ? ' #' + p.jersey_number : ''}</option>`).join('')}</optgroup>`).join('')}
          </select>
          <select id="s-kind" class="field"><option value="games">Number of games</option><option value="until">Until a date</option><option value="open">Until further notice</option></select>
          <input id="s-games" class="field" type="number" min="1" value="1" aria-label="Games">
          <input id="s-until" class="field hidden" type="date" aria-label="Until">
          <input id="s-reason" class="field" placeholder="Reason (shows on the public roster)">
          <button id="s-add" class="btn btn-brass">Add suspension</button>
        </div>
      </section>
    </div>`);

  const $ = s => document.getElementById(s);
  $('s-kind').onchange = e => {
    $('s-games').classList.toggle('hidden', e.target.value !== 'games');
    $('s-until').classList.toggle('hidden', e.target.value !== 'until');
  };
  $('s-add').onclick = async () => {
    const pid = $('s-player').value;
    if (!pid) return toast('Pick the player.', false);
    const kind = $('s-kind').value;
    const games = kind === 'games' ? parseInt($('s-games').value, 10) : null;
    const until = kind === 'until' ? $('s-until').value : null;
    if (kind === 'games' && !(games > 0)) return toast('Enter how many games.', false);
    if (kind === 'until' && !until) return toast('Pick the date it runs until.', false);
    const { error } = await sb.from('suspensions').insert({
      player_id: pid, team_id: pBy.get(pid)?.team_id ?? null, games, until_date: until,
      reason: $('s-reason').value.trim() || null, created_by: me.id
    });
    toast(error ? 'Suspension did not save.' : 'Suspension recorded.', !error);
    if (!error) suspView();
  };
  document.getElementById('view').addEventListener('click', async e => {
    const pl = e.target.closest('[data-player]'); if (pl) return go('player', pl.dataset.player);
    const b = e.target.closest('[data-lift]'); if (!b) return;
    if (!confirm('Lift this suspension?')) return;
    const { error } = await sb.from('suspensions').update({ lifted_at: new Date().toISOString(), lifted_by: me.id }).eq('id', b.dataset.lift);
    toast(error ? 'Could not lift it.' : 'Suspension lifted.', !error);
    suspView();
  });
}

/* ================= Email lists ================= */
async function commsView() {
  mount(`<p class="text-sm text-gray-500">Loading…</p>`);
  const { people, teams } = await loadPeople();
  if (view !== 'comms') return;
  const divisions = [...new Set(teams.map(t => t.division).filter(Boolean))];
  const withEmail = people.filter(p => p.email && p.status !== 'inactive');

  const groups = [
    ['all', 'Everyone with an email', p => true],
    ['rostered', 'Rostered players', p => p.status === 'active'],
    ['spares', 'Spares', p => p.status === 'spare'],
    ['unpaid', 'Haven’t paid (incl. past-due plans)', p => owes(p)],
    ['plan', 'On a payment plan', p => p.reg?.payment_type === 'plan'],
    ['registrants', 'Registered, not on a team yet', p => p.status === 'registrant'],
    ['waitlist', 'Waitlist', p => p.reg?.status === 'waitlist'],
    ...divisions.map(d => [`div:${d}`, `${d} division`, p => p.team?.division === d]),
    ...teams.map(t => [`team:${t.id}`, t.name, p => p.team?.id === t.id])
  ];

  mount(`
    <h2 class="display text-3xl mb-1">Email lists</h2>
    <p class="text-sm text-gray-600 mb-6 max-w-2xl">Pick who you want to reach. Copy their addresses into your email, or open a new email
      with everyone in BCC so nobody sees each other's address. Emails come from registrations, so APs and hand-added players
      without a registration aren't included.</p>
    <div class="grid lg:grid-cols-[20rem,1fr] gap-6 items-start">
      <div class="panel p-2" id="groups">
        ${groups.map(([k, l, fn], i) => `
          ${i === 7 && divisions.length ? '<p class="text-[11px] font-bold uppercase tracking-wider text-gray-500 px-3 pt-3 pb-1">Divisions</p>' : ''}
          ${i === 7 + divisions.length ? '<p class="text-[11px] font-bold uppercase tracking-wider text-gray-500 px-3 pt-3 pb-1">Teams</p>' : ''}
          <button data-g="${esc(k)}" class="w-full flex justify-between px-3 py-2 rounded text-sm text-left hover:bg-[var(--ice)]">
            <span>${esc(l)}</span><span class="text-gray-500">${withEmail.filter(fn).length}</span></button>`).join('')}
      </div>
      <div class="panel p-5">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <p id="g-title" class="display text-xl"></p>
          <div class="flex flex-wrap gap-2">
            <button id="g-copy" class="btn btn-primary !text-sm">Copy emails</button>
            <button id="g-mail" class="btn btn-quiet !text-sm">New email (BCC)</button>
            <button id="g-csv" class="btn btn-quiet !text-sm">CSV</button>
          </div>
        </div>
        <p id="g-warn" class="text-xs text-gray-500 mb-3 hidden"></p>
        <div id="g-list" class="text-sm max-h-[60vh] overflow-y-auto"></div>
      </div>
    </div>`);

  let current = [];
  const pick = k => {
    const [, label, fn] = groups.find(g => g[0] === k);
    /* one entry per address: a player could have registered twice */
    const seen = new Set();
    current = withEmail.filter(fn).filter(p => { const e = p.email.toLowerCase(); return seen.has(e) ? false : seen.add(e); });
    document.querySelectorAll('#groups [data-g]').forEach(b => {
      b.style.background = b.dataset.g === k ? 'var(--ice)' : '';
      b.style.fontWeight = b.dataset.g === k ? '700' : '';
    });
    document.getElementById('g-title').textContent = `${label} · ${current.length}`;
    document.getElementById('g-list').innerHTML = current.map(p => `
      <div class="flex justify-between gap-3 py-1.5 border-b" style="border-color:var(--line)">
        <span>${esc(p.name)} <span class="text-gray-500">${esc(p.team?.name ?? '')}</span></span>
        <span class="text-gray-600">${esc(p.email)}</span></div>`).join('') || '<p class="text-gray-500">Nobody in this group has an email on file.</p>';
    const mailto = bccLink();
    const warn = document.getElementById('g-warn');
    warn.classList.toggle('hidden', mailto.length < 1900);
    warn.textContent = 'This list is long, so some email apps may cut the BCC short. If that happens, use Copy emails and paste into BCC.';
  };
  const bccLink = () => `mailto:${encodeURIComponent(IVY_CONFIG.CONTACT_EMAIL || '')}?bcc=${current.map(p => encodeURIComponent(p.email)).join(',')}`;

  document.getElementById('groups').addEventListener('click', e => {
    const b = e.target.closest('[data-g]'); if (b) pick(b.dataset.g);
  });
  document.getElementById('g-copy').onclick = async () => {
    if (!current.length) return toast('Nobody to copy.', false);
    try { await navigator.clipboard.writeText(current.map(p => p.email).join(', ')); toast(`${current.length} emails copied.`); }
    catch { toast('Your browser blocked copying. Select the list and copy it by hand.', false); }
  };
  document.getElementById('g-mail').onclick = () => { if (current.length) location.href = bccLink(); };
  document.getElementById('g-csv').onclick = () => downloadCsv([['name', 'email', 'phone', 'team']]
    .concat(current.map(p => [p.name, p.email, p.phone ?? '', p.team?.name ?? ''])), 'ivy-email-list.csv');
  pick('all');
}
