/* ---------------------------------------------------------------
   admin.js — staff portal
   Tabs: Scorekeeping · Registrations · Schedule · Teams · Pages ·
         Payments · News
   Scorekeepers see Scorekeeping only; admins see everything.
--------------------------------------------------------------- */
const sb = window.sb;
const TZ = IVY_CONFIG.TIMEZONE || 'America/Toronto';
 
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = iso => new Date(iso).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
const fmtClock = s => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const ordinal = n => ['', '1st', '2nd', '3rd', 'OT', 'SO'][n] || `${n}`;
const toLocalInput = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
 
let me = null, view = 'score', tick = null;
 
function toast(text, ok = true) {
  const t = document.createElement('div');
  t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded text-sm text-white shadow-lg';
  t.style.background = ok ? 'var(--ivy)' : '#B3261E';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
 
/* ================= auth ================= */
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('login-msg');
  msg.classList.add('hidden');
  const { error } = await sb.auth.signInWithPassword({
    email: document.getElementById('li-email').value.trim(),
    password: document.getElementById('li-pass').value
  });
  if (error) { msg.textContent = 'That email and password did not match. Try again or ask an admin to reset it.'; msg.classList.remove('hidden'); }
});
 
document.getElementById('signout').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
 
sb.auth.onAuthStateChange(async (_e, session) => { if (session) boot(session); });
sb.auth.getSession().then(({ data }) => { if (data.session) boot(data.session); });
 
async function boot(session) {
  const { data: staff } = await sb.from('staff').select('*').eq('id', session.user.id).maybeSingle();
  if (!staff) {
    document.getElementById('login-msg').textContent = 'That account is not on the staff list. Ask an admin to add you.';
    document.getElementById('login-msg').classList.remove('hidden');
    await sb.auth.signOut();
    return;
  }
  me = staff;
  document.getElementById('login').classList.add('hidden');
  document.getElementById('portal').classList.remove('hidden');
  document.getElementById('who').textContent = `${staff.full_name || staff.email} · ${staff.role}`;
 
  const tabs = me.role === 'admin'
    ? [['score', 'Scorekeeping'], ['regs', 'Registrations'], ['sched', 'Schedule'], ['teams', 'Teams & rosters'], ['pages', 'Pages'], ['photos', 'Photos'], ['pay', 'Payments'], ['news', 'News']]
    : [['score', 'Scorekeeping']];
 
  document.getElementById('tabs').innerHTML = tabs.map(([k, l]) =>
    `<button data-tab="${k}" class="px-4 py-2 text-sm font-semibold rounded-sm whitespace-nowrap">${l}</button>`).join('');
  document.getElementById('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    view = b.dataset.tab; render();
  });
  render();
}
 
function render() {
  clearInterval(tick);
  document.querySelectorAll('#tabs [data-tab]').forEach(b => {
    b.className = `px-4 py-2 text-sm font-semibold rounded-sm whitespace-nowrap ${b.dataset.tab === view ? 'bg-white/20 text-white' : 'text-white/65 hover:text-white'}`;
  });
  ({ score: scoreView, regs: regsView, sched: schedView, teams: teamsView, pages: pagesView, photos: photosView, pay: payView, news: newsView }[view])();
}
 
const mount = html => { document.getElementById('view').innerHTML = html; };
 
/* ================= 1. Scorekeeping ================= */
async function scoreView() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const { data: games } = await sb.from('games')
    .select('*, home:home_team_id(id,name), away:away_team_id(id,name)')
    .gte('starts_at', from.toISOString())
    .lte('starts_at', new Date(Date.now() + 14 * 864e5).toISOString())
    .neq('status', 'final').order('starts_at');
 
  mount(`
    <h2 class="display text-2xl mb-1">Scorekeeping</h2>
    <p class="text-sm text-gray-600 mb-5">Pick a game. Everything you enter appears on the public scoreboard immediately.</p>
    <div class="grid gap-2 max-w-3xl">
      ${(games || []).length ? games.map(g => `
        <button data-game="${g.id}" class="panel px-5 py-4 text-left grid grid-cols-[1fr,auto] items-center gap-4 hover:bg-[var(--ice)]">
          <div>
            <p class="display text-lg">${esc(g.away?.name ?? 'TBD')} at ${esc(g.home?.name ?? 'TBD')}</p>
            <p class="text-xs text-gray-500 mt-1">${fmtDT(g.starts_at)} · ${esc(g.division ?? '')} · ${esc(g.venue ?? '')}</p>
          </div>
          <span class="text-xs font-bold ${g.status === 'live' ? 'text-red-600 pulse-live' : ''}" style="${g.status !== 'live' ? 'color:var(--ivy)' : ''}">
            ${g.status === 'live' ? 'In progress' : 'Open game sheet'}</span>
        </button>`).join('')
      : '<p class="text-sm text-gray-600">No games scheduled in the next two weeks.</p>'}
    </div>`);
 
  document.getElementById('view').addEventListener('click', e => {
    const b = e.target.closest('[data-game]'); if (b) gameSheet(b.dataset.game);
  });
}
 
async function gameSheet(id) {
  const { data: g } = await sb.from('games').select('*, home:home_team_id(id,name), away:away_team_id(id,name)').eq('id', id).single();
  const { data: players } = await sb.from('players').select('id,first_name,last_name,jersey_number,team_id')
    .in('team_id', [g.home_team_id, g.away_team_id].filter(Boolean));
 
  const roster = tid => (players || []).filter(p => p.team_id === tid)
    .map(p => `<option value="${p.id}">#${p.jersey_number ?? '–'} ${esc(p.first_name)} ${esc(p.last_name)}</option>`).join('');
 
  mount(`
    <button id="back" class="text-sm font-semibold mb-4" style="color:var(--ivy)">← All games</button>
 
    <div class="panel-deep p-6 mb-5">
      <div class="grid grid-cols-[1fr,auto,1fr] items-center text-center gap-4">
        <div>
          <p class="display text-xl">${esc(g.away?.name ?? 'Away')}</p>
          <div class="flex items-center justify-center gap-2 mt-3">
            <button class="btn btn-ghost !px-3 !py-1" data-score="away" data-delta="-1">−</button>
            <span id="away-score" class="scoreline text-4xl w-16">${g.away_score}</span>
            <button class="btn btn-ghost !px-3 !py-1" data-score="away" data-delta="1">+</button>
          </div>
        </div>
        <div>
          <p id="clock" class="scoreline text-3xl" style="color:var(--brass-soft)">${fmtClock(g.clock_seconds)}</p>
          <p class="text-xs text-white/60 mt-1">${ordinal(g.period)} period</p>
        </div>
        <div>
          <p class="display text-xl">${esc(g.home?.name ?? 'Home')}</p>
          <div class="flex items-center justify-center gap-2 mt-3">
            <button class="btn btn-ghost !px-3 !py-1" data-score="home" data-delta="-1">−</button>
            <span id="home-score" class="scoreline text-4xl w-16">${g.home_score}</span>
            <button class="btn btn-ghost !px-3 !py-1" data-score="home" data-delta="1">+</button>
          </div>
        </div>
      </div>
    </div>
 
    <div class="grid lg:grid-cols-[1fr,1.2fr] gap-5">
      <!-- clock + status -->
      <div class="panel p-5 grid gap-4 h-fit">
        <div class="rule">Clock &amp; period</div>
        <div class="flex gap-2">
          <button id="clock-toggle" class="btn ${g.clock_running ? 'btn-brass' : 'btn-primary'} flex-1">${g.clock_running ? 'Stop clock' : 'Start clock'}</button>
          <button id="clock-set" class="btn btn-quiet">Set time</button>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-quiet flex-1" data-period="-1">− Period</button>
          <button class="btn btn-quiet flex-1" data-period="1">+ Period</button>
        </div>
        <div class="pt-3 border-t grid gap-2" style="border-color:var(--line)">
          <button id="go-live" class="btn ${g.status === 'live' ? 'btn-quiet' : 'btn-primary'}">${g.status === 'live' ? 'Game is live' : 'Start game (go live)'}</button>
          <button id="go-final" class="btn btn-quiet">Finalize game</button>
        </div>
      </div>
 
      <!-- event entry -->
      <div class="panel p-5 grid gap-5">
        <div>
          <div class="rule mb-3">Record a goal</div>
          <div class="grid sm:grid-cols-2 gap-3">
            <select id="goal-team" class="field">
              <option value="${g.away_team_id}">${esc(g.away?.name ?? 'Away')}</option>
              <option value="${g.home_team_id}">${esc(g.home?.name ?? 'Home')}</option>
            </select>
            <select id="goal-scorer" class="field"></select>
            <select id="goal-a1" class="field"><option value="">First assist (optional)</option></select>
            <select id="goal-a2" class="field"><option value="">Second assist (optional)</option></select>
          </div>
          <button id="add-goal" class="btn btn-primary mt-3 w-full">Add goal &amp; update score</button>
        </div>
 
        <div class="pt-4 border-t" style="border-color:var(--line)">
          <div class="rule mb-3">Record a penalty</div>
          <div class="grid sm:grid-cols-2 gap-3">
            <select id="pen-team" class="field">
              <option value="${g.away_team_id}">${esc(g.away?.name ?? 'Away')}</option>
              <option value="${g.home_team_id}">${esc(g.home?.name ?? 'Home')}</option>
            </select>
            <select id="pen-player" class="field"></select>
            <input id="pen-infraction" class="field" placeholder="Infraction (tripping, slashing…)">
            <select id="pen-minutes" class="field">
              <option value="2">2 minutes</option><option value="4">4 minutes</option>
              <option value="5">5 minutes</option><option value="10">10 — misconduct</option>
            </select>
          </div>
          <button id="add-pen" class="btn btn-brass mt-3 w-full">Add penalty</button>
        </div>
      </div>
    </div>
 
    <div class="panel p-5 mt-5">
      <div class="rule mb-3">Game sheet</div>
      <div id="sheet" class="grid"></div>
    </div>`);
 
  /* roster dropdowns follow the team selectors */
  const fillRosters = () => {
    const gt = document.getElementById('goal-team').value;
    document.getElementById('goal-scorer').innerHTML = roster(gt);
    document.getElementById('goal-a1').innerHTML = '<option value="">First assist (optional)</option>' + roster(gt);
    document.getElementById('goal-a2').innerHTML = '<option value="">Second assist (optional)</option>' + roster(gt);
    document.getElementById('pen-player').innerHTML = roster(document.getElementById('pen-team').value);
  };
  document.getElementById('goal-team').onchange = fillRosters;
  document.getElementById('pen-team').onchange = fillRosters;
  fillRosters();
 
  document.getElementById('back').onclick = () => { clearInterval(tick); scoreView(); };
 
  const save = async patch => {
    const { error } = await sb.from('games').update(patch).eq('id', id);
    if (error) toast('Could not save — check your connection.', false);
    return !error;
  };
 
  /* ---- live local clock ---- */
  let state = { ...g };
  const remaining = () => state.clock_running
    ? Math.max(0, state.clock_seconds - (Date.now() - new Date(state.clock_updated_at).getTime()) / 1000)
    : state.clock_seconds;
  tick = setInterval(() => { document.getElementById('clock').textContent = fmtClock(remaining()); }, 250);
 
  document.getElementById('clock-toggle').onclick = async () => {
    const running = !state.clock_running;
    const patch = { clock_running: running, clock_seconds: Math.round(remaining()), clock_updated_at: new Date().toISOString() };
    if (await save(patch)) { state = { ...state, ...patch }; gameSheetRefreshButton(running); }
  };
  const gameSheetRefreshButton = running => {
    const b = document.getElementById('clock-toggle');
    b.textContent = running ? 'Stop clock' : 'Start clock';
    b.className = `btn ${running ? 'btn-brass' : 'btn-primary'} flex-1`;
  };
 
  document.getElementById('clock-set').onclick = async () => {
    const v = prompt('Time remaining in the period (mm:ss)', fmtClock(remaining()));
    if (!v) return;
    const [m, s] = v.split(':').map(n => parseInt(n, 10) || 0);
    const patch = { clock_seconds: m * 60 + s, clock_updated_at: new Date().toISOString() };
    if (await save(patch)) { state = { ...state, ...patch }; }
  };
 
  document.querySelectorAll('[data-period]').forEach(b => b.onclick = async () => {
    const p = Math.max(1, Math.min(5, state.period + Number(b.dataset.period)));
    const patch = { period: p, clock_seconds: 1200, clock_running: false, clock_updated_at: new Date().toISOString() };
    if (await save(patch)) { state = { ...state, ...patch }; gameSheet(id); }
  });
 
  document.querySelectorAll('[data-score]').forEach(b => b.onclick = async () => {
    const side = b.dataset.score, field = side === 'home' ? 'home_score' : 'away_score';
    const val = Math.max(0, state[field] + Number(b.dataset.delta));
    if (await save({ [field]: val })) {
      state[field] = val;
      document.getElementById(`${side}-score`).textContent = val;
    }
  });
 
  document.getElementById('go-live').onclick = async () => {
    if (await save({ status: 'live', clock_updated_at: new Date().toISOString() })) { toast('Game is live on the site.'); gameSheet(id); }
  };
  document.getElementById('go-final').onclick = async () => {
    if (!confirm('Finalize this game? Standings will update.')) return;
    if (await save({ status: 'final', clock_running: false })) { toast('Game finalized.'); clearInterval(tick); scoreView(); }
  };
 
  document.getElementById('add-goal').onclick = async () => {
    const team = document.getElementById('goal-team').value;
    const field = team === state.home_team_id ? 'home_score' : 'away_score';
    const { error } = await sb.from('game_events').insert({
      game_id: id, team_id: team, type: 'goal',
      player_id: document.getElementById('goal-scorer').value || null,
      assist1_id: document.getElementById('goal-a1').value || null,
      assist2_id: document.getElementById('goal-a2').value || null,
      period: state.period, clock: fmtClock(remaining()), created_by: me.id
    });
    if (error) return toast('Goal did not save.', false);
    const val = state[field] + 1;
    await save({ [field]: val });
    state[field] = val;
    document.getElementById(field === 'home_score' ? 'home-score' : 'away-score').textContent = val;
    toast('Goal recorded.');
    loadSheet();
  };
 
  document.getElementById('add-pen').onclick = async () => {
    const { error } = await sb.from('game_events').insert({
      game_id: id, team_id: document.getElementById('pen-team').value, type: 'penalty',
      player_id: document.getElementById('pen-player').value || null,
      infraction: document.getElementById('pen-infraction').value,
      minutes: parseInt(document.getElementById('pen-minutes').value, 10),
      period: state.period, clock: fmtClock(remaining()), created_by: me.id
    });
    if (error) return toast('Penalty did not save.', false);
    document.getElementById('pen-infraction').value = '';
    toast('Penalty recorded.');
    loadSheet();
  };
 
  async function loadSheet() {
    const { data } = await sb.from('game_events')
      .select('id, type, period, clock, minutes, infraction, player:player_id(first_name,last_name,jersey_number), a1:assist1_id(last_name), a2:assist2_id(last_name)')
      .eq('game_id', id).order('created_at', { ascending: false });
    document.getElementById('sheet').innerHTML = (data || []).length ? data.map(e => `
      <div class="flex items-center gap-3 text-sm py-2 border-b" style="border-color:var(--line)">
        <span class="text-gray-400 w-20 tnum">${ordinal(e.period)} ${esc(e.clock ?? '')}</span>
        <span class="font-bold w-12" style="color:${e.type === 'penalty' ? 'var(--brass)' : 'var(--ivy)'}">${e.type === 'penalty' ? 'PEN' : 'GOAL'}</span>
        <span class="flex-1">${e.player ? `#${e.player.jersey_number ?? ''} ${esc(e.player.first_name)} ${esc(e.player.last_name)}` : '—'}
          ${e.type === 'goal' && (e.a1 || e.a2) ? `<span class="text-gray-500">(${[e.a1?.last_name, e.a2?.last_name].filter(Boolean).map(esc).join(', ')})</span>` : ''}
          ${e.type === 'penalty' ? `<span class="text-gray-500">${esc(e.infraction ?? '')} — ${e.minutes} min</span>` : ''}</span>
        <button data-del="${e.id}" class="text-xs text-red-700 hover:underline">Remove</button>
      </div>`).join('') : '<p class="text-sm text-gray-500">Nothing recorded yet.</p>';
 
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this entry? Adjust the score manually if needed.')) return;
      await sb.from('game_events').delete().eq('id', b.dataset.del);
      loadSheet();
    });
  }
  loadSheet();
}
 
/* ================= 2. Registrations ================= */
async function regsView() {
  const { data: regs } = await sb.from('registrations').select('*, team:team_id(name)').order('created_at', { ascending: false });
  const { data: teams } = await sb.from('teams').select('id,name,division').order('name');
 
  const counts = (regs || []).reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  const teamOpts = r => `<option value="">No team</option>` +
    (teams || []).map(t => `<option value="${t.id}" ${t.id === r.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
 
  mount(`
    <div class="flex flex-wrap items-end justify-between gap-4 mb-5">
      <div>
        <h2 class="display text-2xl">Registrations</h2>
        <p class="text-sm text-gray-600 mt-1">${regs?.length ?? 0} total · ${counts.new ?? 0} new · ${counts.approved ?? 0} approved</p>
      </div>
      <button id="export" class="btn btn-quiet">Download CSV</button>
    </div>
    <p class="text-sm text-gray-600 mb-4 max-w-2xl">Set a team and mark the registration approved — the player is added to that
      roster automatically and appears on the public Teams page.</p>
    <div class="panel overflow-x-auto">
      <table class="grid-table">
        <thead><tr><th>Received</th><th>Player</th><th>Contact</th><th>Pos</th><th>#</th>
          <th>Division</th><th>Team</th><th>Paid</th><th>Status</th><th>Emergency</th></tr></thead>
        <tbody>${(regs || []).map(r => `
          <tr data-id="${r.id}">
            <td class="text-gray-500 whitespace-nowrap">${fmtDT(r.created_at)}</td>
            <td class="font-semibold">${esc(r.first_name)} ${esc(r.last_name)}
              ${r.notes ? `<div class="text-xs text-gray-500 font-normal max-w-48">${esc(r.notes)}</div>` : ''}</td>
            <td class="text-xs"><a href="mailto:${esc(r.email)}" class="underline">${esc(r.email)}</a><br>${esc(r.phone ?? '')}</td>
            <td>${esc(r.position ?? '')}</td><td>${r.jersey_number ?? ''}</td>
            <td>${esc(r.division ?? '')}</td>
            <td><select class="field !py-1 !text-xs" data-field="team_id">${teamOpts(r)}</select></td>
            <td><select class="field !py-1 !text-xs" data-field="payment_status">
              ${['unpaid', 'paid', 'refunded', 'comped'].map(s => `<option ${s === r.payment_status ? 'selected' : ''}>${s}</option>`).join('')}
            </select></td>
            <td><select class="field !py-1 !text-xs" data-field="status">
              ${['new', 'approved', 'waitlist', 'declined'].map(s => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select></td>
            <td class="text-xs text-gray-500">${esc(r.emergency_name ?? '')}<br>${esc(r.emergency_phone ?? '')}</td>
          </tr>`).join('') || '<tr><td colspan="10" class="text-sm text-gray-500">No registrations yet.</td></tr>'}
        </tbody>
      </table>
    </div>`);
 
  document.getElementById('view').addEventListener('change', async e => {
    const sel = e.target.closest('[data-field]'); if (!sel) return;
    const id = sel.closest('tr').dataset.id;
    const val = sel.dataset.field === 'team_id' ? (sel.value || null) : sel.value;
    const { error } = await sb.from('registrations').update({ [sel.dataset.field]: val }).eq('id', id);
    toast(error ? 'Could not update that registration.' : 'Updated.', !error);
  });
 
  document.getElementById('export').onclick = () => {
    const cols = ['created_at', 'first_name', 'last_name', 'email', 'phone', 'position', 'jersey_number', 'shirt_size', 'division', 'emergency_name', 'emergency_phone', 'payment_status', 'status', 'notes'];
    const csv = [cols.join(',')].concat((regs || []).map(r =>
      cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `ivy-registrations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
}
 
/* ================= 3. Schedule ================= */
async function schedView() {
  const { data: games } = await sb.from('games').select('*, home:home_team_id(name), away:away_team_id(name)').order('starts_at');
  const { data: teams } = await sb.from('teams').select('id,name,division').order('name');
  const opts = (sel) => (teams || []).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
 
  mount(`
    <h2 class="display text-2xl mb-5">Schedule</h2>
    <div class="panel p-5 mb-6">
      <div class="rule mb-3">Add a game</div>
      <div class="grid md:grid-cols-5 gap-3">
        <select id="n-away" class="field"><option value="">Away team</option>${opts()}</select>
        <select id="n-home" class="field"><option value="">Home team</option>${opts()}</select>
        <input id="n-when" type="datetime-local" class="field">
        <input id="n-div" class="field" placeholder="Division">
        <input id="n-venue" class="field" placeholder="Venue" value="${esc(IVY_CONFIG.VENUE)}">
      </div>
      <div class="flex flex-wrap items-center gap-3 mt-3">
        <button id="add-game" class="btn btn-primary">Add game</button>
        <label class="text-sm text-gray-600 flex items-center gap-2">
          Repeat weekly for
          <input id="n-repeat" type="number" min="1" max="30" value="1" class="field !w-20 !py-1">
          week(s)
        </label>
      </div>
      <p class="text-xs text-gray-500 mt-2">Repeating creates the same matchup at the same time on following weeks — useful for a
        fixed ice slot. Edit or delete any of them below.</p>
    </div>
 
    <div class="panel overflow-x-auto">
      <table class="grid-table">
        <thead><tr><th>Date &amp; time</th><th>Away</th><th>Home</th><th>Score</th><th>Division</th><th>Venue</th><th>Status</th><th></th></tr></thead>
        <tbody>${(games || []).map(g => `
          <tr data-id="${g.id}">
            <td><input type="datetime-local" class="field !py-1 !text-xs" data-f="starts_at" value="${toLocalInput(g.starts_at)}"></td>
            <td><select class="field !py-1 !text-xs" data-f="away_team_id"><option value="">TBD</option>${opts(g.away_team_id)}</select></td>
            <td><select class="field !py-1 !text-xs" data-f="home_team_id"><option value="">TBD</option>${opts(g.home_team_id)}</select></td>
            <td class="whitespace-nowrap">
              <input type="number" min="0" class="field !py-1 !text-xs !w-14" data-f="away_score" value="${g.away_score}">
              <input type="number" min="0" class="field !py-1 !text-xs !w-14" data-f="home_score" value="${g.home_score}">
            </td>
            <td><input class="field !py-1 !text-xs !w-28" data-f="division" value="${esc(g.division ?? '')}"></td>
            <td><input class="field !py-1 !text-xs" data-f="venue" value="${esc(g.venue ?? '')}"></td>
            <td><select class="field !py-1 !text-xs" data-f="status">
              ${['scheduled', 'live', 'final', 'postponed'].map(s => `<option ${s === g.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select></td>
            <td class="whitespace-nowrap">
              <button data-sheet="${g.id}" class="text-xs font-semibold hover:underline" style="color:var(--ivy)">Game sheet</button>
              <button data-del="${g.id}" class="text-xs text-red-700 hover:underline ml-2">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="text-sm text-gray-500">No games scheduled.</td></tr>'}
        </tbody>
      </table>
    </div>`);
 
  document.getElementById('add-game').onclick = async () => {
    const when = document.getElementById('n-when').value;
    if (!when) return toast('Pick a date and time.', false);
    const weeks = Math.max(1, Math.min(30, parseInt(document.getElementById('n-repeat').value, 10) || 1));
    const base = new Date(when);
    const rows = Array.from({ length: weeks }, (_, i) => {
      const d = new Date(base); d.setDate(d.getDate() + i * 7);
      return {
        away_team_id: document.getElementById('n-away').value || null,
        home_team_id: document.getElementById('n-home').value || null,
        starts_at: d.toISOString(),
        division: document.getElementById('n-div').value,
        venue: document.getElementById('n-venue').value
      };
    });
    const { error } = await sb.from('games').insert(rows);
    if (error) return toast('Could not add that game.', false);
    toast(weeks > 1 ? `${weeks} games added.` : 'Game added.');
    schedView();
  };
 
  document.getElementById('view').addEventListener('change', async e => {
    const f = e.target.closest('[data-f]'); if (!f) return;
    const id = f.closest('tr').dataset.id;
    const key = f.dataset.f;
    let val = f.value;
    if (key === 'starts_at') val = new Date(f.value).toISOString();
    else if (key.endsWith('_score')) val = Math.max(0, parseInt(f.value, 10) || 0);
    else if (key.endsWith('_team_id')) val = f.value || null;
    const { error } = await sb.from('games').update({ [key]: val }).eq('id', id);
    toast(error ? 'Not saved.' : 'Saved.', !error);
  });
 
  document.getElementById('view').addEventListener('click', async e => {
    const sheet = e.target.closest('[data-sheet]');
    if (sheet) {
      view = 'score';
      document.querySelectorAll('#tabs [data-tab]').forEach(b => {
        b.className = `px-4 py-2 text-sm font-semibold rounded-sm whitespace-nowrap ${b.dataset.tab === 'score' ? 'bg-white/20 text-white' : 'text-white/65 hover:text-white'}`;
      });
      return gameSheet(sheet.dataset.sheet);
    }
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!confirm('Delete this game? Any goals and penalties recorded on it go too.')) return;
    await sb.from('games').delete().eq('id', b.dataset.del);
    schedView();
  });
}
 
/* ================= 4. Teams & rosters ================= */
async function teamsView() {
  const { data: teams } = await sb.from('teams').select('*').order('division').order('name');
  const { data: players } = await sb.from('players').select('*').order('jersey_number');
 
  mount(`
    <h2 class="display text-2xl mb-5">Teams &amp; rosters</h2>
    <div class="panel p-5 mb-6">
      <div class="rule mb-3">Add a team</div>
      <div class="grid md:grid-cols-4 gap-3">
        <input id="t-name" class="field" placeholder="Team name">
        <input id="t-div" class="field" placeholder="Division">
        <input id="t-colour" type="color" class="field !p-1 h-11" value="#09522B">
        <input id="t-logo" class="field" placeholder="Logo image URL">
      </div>
      <button id="add-team" class="btn btn-primary mt-3">Add team</button>
    </div>
 
    ${(teams || []).map(t => `
      <div class="panel mb-4 overflow-hidden" data-team="${t.id}">
        <div class="p-4 flex flex-wrap items-center gap-3" style="background:${esc(t.colour)};color:#fff">
          <input class="field !py-1 !w-56 !text-sm !text-black" data-tf="name" value="${esc(t.name)}">
          <input class="field !py-1 !w-36 !text-sm !text-black" data-tf="division" value="${esc(t.division)}">
          <input class="field !py-1 !w-64 !text-sm !text-black" data-tf="logo_url" value="${esc(t.logo_url ?? '')}" placeholder="Logo URL">
          <span class="text-xs text-white/70 ml-auto">${(players || []).filter(p => p.team_id === t.id).length} players</span>
        </div>
        <table class="grid-table">
          <thead><tr><th class="w-16">#</th><th>Player</th><th>Position</th><th>Status</th><th></th></tr></thead>
          <tbody>${(players || []).filter(p => p.team_id === t.id).map(p => `
            <tr data-player="${p.id}">
              <td><input class="field !py-1 !w-14 !text-xs" data-pf="jersey_number" value="${p.jersey_number ?? ''}"></td>
              <td class="font-semibold">${esc(p.first_name)} ${esc(p.last_name)}</td>
              <td><select class="field !py-1 !text-xs" data-pf="position">
                ${['Forward', 'Defence', 'Goalie'].map(x => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
              <td><select class="field !py-1 !text-xs" data-pf="status">
                ${['active', 'spare', 'inactive'].map(x => `<option ${x === p.status ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
              <td><button data-delp="${p.id}" class="text-xs text-red-700 hover:underline">Remove</button></td>
            </tr>`).join('') || '<tr><td colspan="5" class="text-sm text-gray-500">Roster empty — add one below, or approve a registration.</td></tr>'}
          </tbody>
        </table>
        <div class="p-4 grid sm:grid-cols-[1fr,1fr,5rem,9rem,auto] gap-2 items-center border-t" style="border-color:var(--line)" data-add-player="${t.id}">
          <input class="field !text-sm" data-af="first_name" placeholder="First name">
          <input class="field !text-sm" data-af="last_name" placeholder="Last name">
          <input class="field !text-sm" data-af="jersey_number" placeholder="#">
          <select class="field !text-sm" data-af="position">
            <option>Forward</option><option>Defence</option><option>Goalie</option>
          </select>
          <button data-addp="${t.id}" class="btn btn-quiet whitespace-nowrap">Add player</button>
        </div>
      </div>`).join('')}`);
 
  document.getElementById('add-team').onclick = async () => {
    const name = document.getElementById('t-name').value.trim();
    if (!name) return toast('Give the team a name.', false);
    await sb.from('teams').insert({
      name, division: document.getElementById('t-div').value || 'Open',
      colour: document.getElementById('t-colour').value,
      logo_url: document.getElementById('t-logo').value || null
    });
    teamsView();
  };
 
  document.getElementById('view').addEventListener('change', async e => {
    const tf = e.target.closest('[data-tf]');
    if (tf) {
      const id = tf.closest('[data-team]').dataset.team;
      const { error } = await sb.from('teams').update({ [tf.dataset.tf]: tf.value }).eq('id', id);
      return toast(error ? 'Not saved.' : 'Saved.', !error);
    }
    const pf = e.target.closest('[data-pf]');
    if (pf) {
      const id = pf.closest('[data-player]').dataset.player;
      const val = pf.dataset.pf === 'jersey_number' ? (parseInt(pf.value, 10) || null) : pf.value;
      const { error } = await sb.from('players').update({ [pf.dataset.pf]: val }).eq('id', id);
      toast(error ? 'Not saved.' : 'Saved.', !error);
    }
  });
 
  document.getElementById('view').addEventListener('click', async e => {
    const addp = e.target.closest('[data-addp]');
    if (addp) {
      const wrap = addp.closest('[data-add-player]');
      const val = f => wrap.querySelector(`[data-af="${f}"]`).value.trim();
      const first = val('first_name'), last = val('last_name');
      if (!first || !last) return toast('Enter a first and last name.', false);
      const { error } = await sb.from('players').insert({
        team_id: addp.dataset.addp,
        first_name: first,
        last_name: last,
        jersey_number: parseInt(val('jersey_number'), 10) || null,
        position: wrap.querySelector('[data-af="position"]').value,
        status: 'active'
      });
      if (error) return toast('Could not add that player.', false);
      toast('Player added.');
      return teamsView();
    }
    const b = e.target.closest('[data-delp]'); if (!b) return;
    if (!confirm('Remove this player from the roster?')) return;
    await sb.from('players').delete().eq('id', b.dataset.delp);
    teamsView();
  });
}
 
/* ================= 5. Pages (the GoDaddy-style editor) ========= */
async function pagesView() {
  const { data: rows } = await sb.from('site_content').select('*').order('sort');
 
  mount(`
    <h2 class="display text-2xl mb-1">Pages</h2>
    <p class="text-sm text-gray-600 mb-5 max-w-2xl">Every editable piece of text, imagery, and colour on the public site. Change it here and save —
      the website updates for everyone on their next page load. The colour swatches near the bottom recolour the green/gold sections site-wide.</p>
    <div class="grid gap-3 max-w-3xl">
      ${(rows || []).map(r => `
        <div class="panel p-4" data-key="${esc(r.key)}">
          <div class="flex items-baseline justify-between mb-2">
            <label class="label !mb-0" for="k-${esc(r.key)}">${esc(r.label || r.key)}</label>
            <span class="text-[11px] text-gray-400">${esc(r.key)}</span>
          </div>
          ${r.kind === 'longtext'
            ? `<textarea id="k-${esc(r.key)}" rows="3" class="field">${esc(r.value ?? '')}</textarea>`
            : r.kind === 'color'
            ? `<input id="k-${esc(r.key)}" type="color" class="field !p-1 h-11 !w-28" value="${esc(r.value || '#09522B')}">`
            : `<input id="k-${esc(r.key)}" class="field" value="${esc(r.value ?? '')}" ${r.kind === 'image' ? 'placeholder="Image URL"' : ''}>`}
          ${r.kind === 'image' && r.value ? `<img src="${esc(r.value)}" alt="" class="h-24 mt-3 rounded object-cover">` : ''}
        </div>`).join('')}
    </div>
    <div class="flex items-center gap-3 mt-5">
      <button id="save-content" class="btn btn-primary">Save changes</button>
      <button id="upload" class="btn btn-quiet">Upload an image</button>
      <input id="file" type="file" accept="image/*" class="hidden">
    </div>
    <p class="text-xs text-gray-500 mt-3 max-w-2xl">Images upload to the <code>media</code> storage bucket and give you a public URL —
      paste it into any image field above, a team logo, or an announcement.</p>`);
 
  document.getElementById('save-content').onclick = async () => {
    const updates = [...document.querySelectorAll('[data-key]')].map(d => ({
      key: d.dataset.key, value: d.querySelector('input, textarea').value
    }));
    const { error } = await sb.from('site_content').upsert(updates.map(u => ({ ...u, updated_at: new Date().toISOString() })));
    toast(error ? 'Changes did not save.' : 'Website updated.', !error);
  };
 
  document.getElementById('upload').onclick = () => document.getElementById('file').click();
  document.getElementById('file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const path = `${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error } = await sb.storage.from('media').upload(path, file, { upsert: true });
    if (error) return toast('Upload failed — check the media bucket exists.', false);
    const { data } = sb.storage.from('media').getPublicUrl(path);
    prompt('Image uploaded. Copy this URL:', data.publicUrl);
  };
}
 
/* ================= 5b. Photos (section image galleries) ======== */
async function photosView() {
  const { data: imgs } = await sb.from('gallery_images').select('*').order('section').order('sort');
  const sections = [...new Set((imgs || []).map(g => g.section))];
 
  mount(`
    <h2 class="display text-2xl mb-1">Photos</h2>
    <p class="text-sm text-gray-600 mb-5 max-w-2xl">Add photos to a section of the site, then use the arrows to reorder them.
      "home" is the photo strip near the bottom of the home page.</p>
 
    <div class="panel p-5 mb-6 max-w-3xl">
      <div class="rule mb-3">Add a photo</div>
      <div class="grid md:grid-cols-[1fr,2fr,auto] gap-3">
        <input id="g-section" class="field" placeholder="Section" value="home">
        <input id="g-url" class="field" placeholder="Image URL">
        <button id="g-upload" class="btn btn-quiet whitespace-nowrap">Upload image</button>
      </div>
      <input id="g-alt" class="field mt-3" placeholder="Short description (for accessibility)">
      <input id="g-file" type="file" accept="image/*" class="hidden">
      <button id="add-photo" class="btn btn-primary mt-3">Add photo</button>
    </div>
 
    ${sections.length ? sections.map(sec => `
      <div class="mb-8 max-w-3xl">
        <div class="rule mb-3">${esc(sec)}</div>
        <div class="grid gap-2">
          ${imgs.filter(g => g.section === sec).map((g, i, arr) => `
            <div class="panel p-3 flex items-center gap-3" data-photo="${g.id}">
              <img src="${esc(g.url)}" alt="" class="h-14 w-20 object-cover rounded">
              <span class="text-xs text-gray-500 flex-1 truncate">${esc(g.alt || g.url)}</span>
              <button data-move="-1" class="btn btn-quiet !px-2 !py-1 !text-xs" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button data-move="1" class="btn btn-quiet !px-2 !py-1 !text-xs" ${i === arr.length - 1 ? 'disabled' : ''}>↓</button>
              <button data-delg="${g.id}" class="text-xs text-red-700 hover:underline">Remove</button>
            </div>`).join('')}
        </div>
      </div>`).join('') : '<p class="text-sm text-gray-500 max-w-3xl">No photos yet — add one above.</p>'}`);
 
  document.getElementById('g-upload').onclick = () => document.getElementById('g-file').click();
  document.getElementById('g-file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const path = `${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error } = await sb.storage.from('media').upload(path, file, { upsert: true });
    if (error) return toast('Upload failed — check the media bucket exists.', false);
    const { data } = sb.storage.from('media').getPublicUrl(path);
    document.getElementById('g-url').value = data.publicUrl;
    toast('Uploaded — click "Add photo" to place it.');
  };
 
  document.getElementById('add-photo').onclick = async () => {
    const section = document.getElementById('g-section').value.trim() || 'home';
    const url = document.getElementById('g-url').value.trim();
    if (!url) return toast('Paste or upload an image first.', false);
    const maxSort = imgs.filter(g => g.section === section).reduce((m, g) => Math.max(m, g.sort), -1);
    const { error } = await sb.from('gallery_images').insert({
      section, url, alt: document.getElementById('g-alt').value || null, sort: maxSort + 1
    });
    if (error) return toast('Could not add that photo.', false);
    photosView();
  };
 
  document.getElementById('view').addEventListener('click', async e => {
    const del = e.target.closest('[data-delg]');
    if (del) {
      if (!confirm('Remove this photo?')) return;
      await sb.from('gallery_images').delete().eq('id', del.dataset.delg);
      return photosView();
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const row = mv.closest('[data-photo]');
      const id = row.dataset.photo;
      const g = imgs.find(x => x.id === id);
      const siblings = imgs.filter(x => x.section === g.section).sort((a, b) => a.sort - b.sort);
      const idx = siblings.findIndex(x => x.id === id);
      const swapWith = siblings[idx + Number(mv.dataset.move)];
      if (!swapWith) return;
      await Promise.all([
        sb.from('gallery_images').update({ sort: swapWith.sort }).eq('id', g.id),
        sb.from('gallery_images').update({ sort: g.sort }).eq('id', swapWith.id)
      ]);
      photosView();
    }
  });
}
 
/* ================= 6. Payment links ================= */
let paymentsUnlocked = false;
 
async function payView() {
  if (!paymentsUnlocked) return payLockView();
  await payViewInner();
}
 
function payLockView() {
  mount(`
    <div class="max-w-sm">
      <h2 class="display text-2xl mb-1">Payments</h2>
      <p class="text-sm text-gray-600 mb-5">This section is PIN-protected so Stripe links can't be changed by mistake.
        Enter the payments PIN to continue.</p>
      <label class="label" for="pin-input">PIN</label>
      <input id="pin-input" type="password" inputmode="numeric" autocomplete="off" class="field">
      <button id="pin-go" class="btn btn-primary mt-3 w-full">Unlock</button>
      <p id="pin-msg" class="text-sm text-red-700 mt-2 hidden"></p>
    </div>`);
 
  const go = async () => {
    const pin = document.getElementById('pin-input').value;
    const { data, error } = await sb.rpc('check_payments_pin', { candidate: pin });
    if (error || !data) {
      const m = document.getElementById('pin-msg');
      m.textContent = 'Wrong PIN.'; m.classList.remove('hidden');
      return;
    }
    paymentsUnlocked = true;
    payView();
  };
  document.getElementById('pin-go').onclick = go;
  document.getElementById('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
 
async function payViewInner() {
  const { data: links } = await sb.from('payment_links').select('*').order('sort');
 
  mount(`
    <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
      <h2 class="display text-2xl">Payment links</h2>
      <button id="set-pin" class="btn btn-quiet !text-xs !py-2">Set / change PIN</button>
    </div>
    <p class="text-sm text-gray-600 mb-5 max-w-2xl">Create the link in Stripe, paste it here, and it appears on the registration page.
      Add as many links as you need — one per division, per season, or per fee type — using "Add a link" below.
      Untick "Active" to retire a link without deleting it.</p>
    <div class="panel p-5 mb-6 max-w-3xl">
      <div class="rule mb-3">Add a link</div>
      <div class="grid md:grid-cols-2 gap-3">
        <input id="p-label" class="field" placeholder="Label — e.g. Lager Division, full season">
        <input id="p-price" class="field" placeholder="Price text — e.g. $425 + HST">
        <input id="p-url" class="field md:col-span-2" placeholder="https://buy.stripe.com/...">
        <input id="p-desc" class="field md:col-span-2" placeholder="Short description (optional)">
      </div>
      <button id="add-link" class="btn btn-primary mt-3">Add link</button>
    </div>
 
    <div class="grid gap-3 max-w-3xl">
      ${(links || []).map(l => `
        <div class="panel p-4 grid md:grid-cols-2 gap-3" data-link="${l.id}">
          <input class="field" data-lf="label" value="${esc(l.label)}">
          <input class="field" data-lf="price_text" value="${esc(l.price_text ?? '')}">
          <input class="field md:col-span-2" data-lf="url" value="${esc(l.url)}">
          <input class="field md:col-span-2" data-lf="description" value="${esc(l.description ?? '')}">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-lf="active" ${l.active ? 'checked' : ''}> Active on the site</label>
          <div class="text-right"><button data-dell="${l.id}" class="text-xs text-red-700 hover:underline">Delete link</button></div>
        </div>`).join('') || '<p class="text-sm text-gray-500">No payment links yet.</p>'}
    </div>`);
 
  document.getElementById('set-pin').onclick = async () => {
    const pin = prompt('Set a new payments PIN (share it only with people you trust to edit Stripe links):');
    if (!pin) return;
    const { error } = await sb.rpc('set_payments_pin', { new_pin: pin });
    toast(error ? 'Could not set the PIN — are you signed in as an admin?' : 'PIN updated.', !error);
  };
 
  document.getElementById('add-link').onclick = async () => {
    const url = document.getElementById('p-url').value.trim();
    if (!url.startsWith('http')) return toast('Paste the full Stripe URL.', false);
    await sb.from('payment_links').insert({
      label: document.getElementById('p-label').value || 'Registration',
      price_text: document.getElementById('p-price').value,
      description: document.getElementById('p-desc').value, url
    });
    payView();
  };
 
  document.getElementById('view').addEventListener('change', async e => {
    const f = e.target.closest('[data-lf]'); if (!f) return;
    const id = f.closest('[data-link]').dataset.link;
    const val = f.type === 'checkbox' ? f.checked : f.value;
    const { error } = await sb.from('payment_links').update({ [f.dataset.lf]: val }).eq('id', id);
    toast(error ? 'Not saved.' : 'Saved.', !error);
  });
 
  document.getElementById('view').addEventListener('click', async e => {
    const b = e.target.closest('[data-dell]'); if (!b) return;
    if (!confirm('Delete this payment link?')) return;
    await sb.from('payment_links').delete().eq('id', b.dataset.dell);
    payView();
  });
}
 
/* ================= 7. News ================= */
async function newsView() {
  const { data: items } = await sb.from('announcements').select('*').order('published_at', { ascending: false });
 
  mount(`
    <h2 class="display text-2xl mb-5">News &amp; announcements</h2>
    <div class="panel p-5 mb-6 max-w-3xl">
      <div class="rule mb-3">Post an announcement</div>
      <div class="grid gap-3">
        <input id="a-title" class="field" placeholder="Headline">
        <textarea id="a-body" rows="3" class="field" placeholder="What's happening"></textarea>
        <div class="grid md:grid-cols-2 gap-3">
          <input id="a-image" class="field" placeholder="Image URL (optional)">
          <input id="a-link" class="field" placeholder="Link URL (optional)">
        </div>
      </div>
      <button id="add-news" class="btn btn-primary mt-3">Publish</button>
    </div>
 
    <div class="grid gap-3 max-w-3xl">
      ${(items || []).map(n => `
        <div class="panel p-4 flex items-start gap-4" data-news="${n.id}">
          ${n.image_url ? `<img src="${esc(n.image_url)}" alt="" class="h-16 w-24 object-cover rounded">` : ''}
          <div class="flex-1">
            <p class="display text-lg">${esc(n.title)}</p>
            <p class="text-xs text-gray-500">${fmtDT(n.published_at)}</p>
            <p class="serif text-sm mt-1">${esc(n.body ?? '')}</p>
          </div>
          <div class="grid gap-2 text-right">
            <label class="text-xs flex items-center gap-1"><input type="checkbox" data-nf="published" ${n.published ? 'checked' : ''}> Live</label>
            <button data-deln="${n.id}" class="text-xs text-red-700 hover:underline">Delete</button>
          </div>
        </div>`).join('') || '<p class="text-sm text-gray-500">Nothing posted yet.</p>'}
    </div>`);
 
  document.getElementById('add-news').onclick = async () => {
    const title = document.getElementById('a-title').value.trim();
    if (!title) return toast('Give it a headline.', false);
    await sb.from('announcements').insert({
      title, body: document.getElementById('a-body').value,
      image_url: document.getElementById('a-image').value || null,
      link_url: document.getElementById('a-link').value || null
    });
    newsView();
  };
 
  document.getElementById('view').addEventListener('change', async e => {
    const f = e.target.closest('[data-nf]'); if (!f) return;
    await sb.from('announcements').update({ published: f.checked }).eq('id', f.closest('[data-news]').dataset.news);
    toast('Updated.');
  });
 
  document.getElementById('view').addEventListener('click', async e => {
    const b = e.target.closest('[data-deln]'); if (!b) return;
    if (!confirm('Delete this announcement?')) return;
    await sb.from('announcements').delete().eq('id', b.dataset.deln);
    newsView();
  });
}
