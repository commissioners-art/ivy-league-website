/* ---------------------------------------------------------------
   admin.js — the league office (admin/index.html)
   Sidebar sections are listed in NAV below. The CRM views
   (Dashboard, People, player profiles, Suspensions, Email lists)
   live in office.js; the rest are here.
   Scorekeepers see Scorekeeping only; admins see everything.
--------------------------------------------------------------- */
const sb = window.sb;
const TZ = IVY_CONFIG.TIMEZONE || 'America/Toronto';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = iso => new Date(iso).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
const ordinal = n => ['', '1st', '2nd', '3rd', 'OT', 'SO'][n] || `${n}`;
const toLocalInput = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

let me = null, view = 'home', tick = null;
/* keyboard shortcuts for the open game sheet (set by gameSheet, cleared on every render) */
let sheetKeys = null;
document.addEventListener('keydown', e => sheetKeys && sheetKeys(e));

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

sb.auth.onAuthStateChange(async (_e, session) => {
  if (session && (!me || me.id !== session.user.id)) boot(session);
});
sb.auth.getSession().then(({ data }) => { if (data.session) boot(data.session); });

async function boot(session) {
  if (boot.started) return;          // getSession and onAuthStateChange can both fire on load
  boot.started = true;
  const { data: staff } = await sb.from('staff').select('*').eq('id', session.user.id).maybeSingle();
  if (!staff) {
    document.getElementById('login-msg').textContent = 'That account is not on the staff list. Ask an admin to add you.';
    document.getElementById('login-msg').classList.remove('hidden');
    await sb.auth.signOut();
    boot.started = false;
    return;
  }
  me = staff;
  document.getElementById('login').classList.add('hidden');
  document.getElementById('portal').classList.remove('hidden');
  document.getElementById('who').textContent = `${staff.full_name || staff.email} · ${staff.role}`;

  buildNav();
  if (me.role === 'admin') refreshCounts();
  window.addEventListener('hashchange', route);
  route();
}

/* ---- Sections of the office. Scorekeepers only get Scorekeeping. ---- */
const NAV = [
  ['Overview', [['home', 'Dashboard', () => dashView()]]],
  ['League', [
    ['people', 'People', arg => peopleView(arg)],
    ['regs', 'Registrations', () => regsView()],
    ['teams', 'Teams & rosters', () => teamsView()],
    ['susp', 'Suspensions', () => suspView()],
    ['comms', 'Email lists', () => commsView()]
  ]],
  ['Game day', [
    ['score', 'Scorekeeping', () => scoreView()],
    ['sched', 'Schedule', () => schedView()]
  ]],
  ['Money', [['pay', 'Payments', () => payView()]]],
  ['Website', [
    ['pages', 'Pages', () => pagesView()],
    ['morepages', 'More pages', () => morePagesView()],
    ['photos', 'Photos', () => photosView()],
    ['news', 'News', () => newsView()]
  ]]
];
/* views reached from inside another view, not listed in the sidebar */
const HIDDEN_VIEWS = { player: { parent: 'people', run: arg => playerView(arg) } };

const allowed = key => me.role === 'admin' || key === 'score';

function buildNav() {
  document.getElementById('tabs').innerHTML = NAV.map(([grp, items]) => {
    const mine = items.filter(([k]) => allowed(k));
    return mine.length ? `<p class="grp">${grp}</p>` + mine.map(([k, l]) =>
      `<button data-tab="${k}"><span>${l}</span><span class="count hidden" data-count="${k}"></span></button>`).join('') : '';
  }).join('');
  document.getElementById('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    go(b.dataset.tab);
  });
  const search = document.getElementById('office-search');
  if (me.role !== 'admin') search.classList.add('hidden');
  search.addEventListener('submit', e => {
    e.preventDefault();
    const q = document.getElementById('office-q').value.trim();
    go('people', q);
  });
}

/* #/people, #/player/<id>, #/people/<search> */
function go(key, arg) {
  const h = `#/${key}${arg ? '/' + encodeURIComponent(arg) : ''}`;
  if (location.hash === h) route(); else location.hash = h;
}

function route() {
  const [, key, arg] = (location.hash.match(/^#\/([\w-]+)(?:\/(.*))?$/) || []);
  view = key && (allowed(key) || HIDDEN_VIEWS[key] && me.role === 'admin') ? key : (me.role === 'admin' ? 'home' : 'score');
  render(arg ? decodeURIComponent(arg) : undefined);
}

function highlightNav(key) {
  const on = HIDDEN_VIEWS[key]?.parent || key;
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === on));
}

/* Small badge next to a sidebar item (e.g. new registrations). 0 hides it. */
function setCount(key, n) {
  const el = document.querySelector(`[data-count="${key}"]`); if (!el) return;
  el.textContent = n; el.classList.toggle('hidden', !n);
}

function render(arg) {
  clearInterval(tick);
  sheetKeys = null;
  highlightNav(view);
  window.scrollTo(0, 0);
  if (HIDDEN_VIEWS[view]) return HIDDEN_VIEWS[view].run(arg);
  NAV.flatMap(([, items]) => items).find(([k]) => k === view)[2](arg);
}

const mount = html => {
  const old = document.getElementById('view');
  const fresh = old.cloneNode(false);   // strips every listener attached in previous renders
  old.replaceWith(fresh);
  fresh.innerHTML = html;
};

/* ================= 1. Scorekeeping ================= */
async function scoreView() {
  clearInterval(tick);
  sheetKeys = null;
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

/* Game sheet. No clock to run: the scorekeeper types the period and
   game time for each entry. Both are prefilled from an estimate based
   on the scheduled start (see league.js) so usually they just adjust. */
const INFRACTIONS = ['Tripping', 'Slashing', 'Hooking', 'Holding', 'Interference', 'Roughing', 'High-sticking',
  'Cross-checking', 'Boarding', 'Charging', 'Too many men', 'Delay of game', 'Unsportsmanlike conduct',
  'Body checking', 'Fighting', 'Abuse of officials', 'Game misconduct', 'Match penalty'];

/* '12:34', '1234', '934', '9:4' -> 'MM:SS'; null if it isn't a time */
function parseGameTime(v) {
  v = String(v || '').trim();
  let m, s;
  if (/^\d{1,2}:\d{1,2}$/.test(v)) [m, s] = v.split(':').map(Number);
  else if (/^\d{3,4}$/.test(v)) { m = Number(v.slice(0, -2)); s = Number(v.slice(-2)); }
  else if (/^\d{1,2}$/.test(v)) { m = Number(v); s = 0; }
  else return null;
  if (s > 59 || m > 60) return null;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function gameSheet(id) {
  clearInterval(tick);
  const { data: g } = await sb.from('games').select('*, home:home_team_id(id,name), away:away_team_id(id,name)').eq('id', id).single();
  const loadPlayers = async () => (await sb.from('players').select('id,first_name,last_name,jersey_number,team_id,status')
    .in('team_id', [g.home_team_id, g.away_team_id].filter(Boolean)).order('jersey_number', { nullsFirst: false })).data;
  let players = await loadPlayers();

  const sides = [g.away_team_id, g.home_team_id].filter(Boolean);
  const teamName = tid => tid === g.home_team_id ? (g.home?.name ?? 'Home') : (g.away?.name ?? 'Away');
  const pName = p => `#${p.jersey_number ?? '–'} ${p.first_name} ${p.last_name}${p.status === 'ap' ? ' (AP)' : ''}`;
  let suspBy = new Map(), suspList = [];

  /* One dropdown with both benches, grouped by team. The team is taken from the player. */
  const playerOptions = ({ unlisted = false, team = null, exclude = null, blank = '' } = {}) =>
    (blank ? `<option value="">${esc(blank)}</option>` : '') +
    sides.filter(t => !team || t === team).map(tid => `
      <optgroup label="${esc(teamName(tid))}">
        ${(players || []).filter(p => p.team_id === tid && p.id !== exclude).map(p =>
          `<option value="${p.id}">${esc(pName(p))}${suspBy.has(p.id) ? ' (SUSPENDED)' : ''}</option>`).join('')}
        ${unlisted ? `<option value="team:${tid}">${esc(teamName(tid))}: player not listed</option>` : ''}
      </optgroup>`).join('');
  const pick = v => v?.startsWith('team:')
    ? { team: v.slice(5), player: null }
    : { team: (players || []).find(p => p.id === v)?.team_id ?? null, player: v || null };

  const periodOpts = sel => [1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === sel ? 'selected' : ''}>${ordinal(n)}</option>`).join('');
  const whenFields = () => `
    <select data-when="period" class="field" aria-label="Period">${periodOpts(g.period || 1)}</select>
    <input data-when="time" class="field tnum" placeholder="Time, e.g. 12:34" inputmode="numeric" maxlength="5" aria-label="Game time" autocomplete="off">`;

  mount(`
    <button id="back" class="text-sm font-semibold mb-4" style="color:var(--ivy)">← All games</button>

    <div class="panel-deep p-6 mb-5">
      <div class="grid grid-cols-[1fr,auto,1fr] items-center text-center gap-4">
        <div>
          <p class="display text-xl">${esc(g.away?.name ?? 'Away')}</p>
          <div class="flex items-center justify-center gap-2 mt-3">
            <button class="btn btn-ghost !px-3 !py-1" data-score="away" data-delta="-1" title="Correct the score">−</button>
            <span id="away-score" class="scoreline text-4xl w-16">${g.away_score}</span>
            <button class="btn btn-ghost !px-3 !py-1" data-score="away" data-delta="1" title="Correct the score">+</button>
          </div>
        </div>
        <div>
          <p id="est-period" class="scoreline text-2xl" style="color:var(--brass-soft)"></p>
          <p id="est-time" class="text-xs text-white/60 mt-1"></p>
          <p id="so-tally" class="text-xs font-bold mt-2 hidden" style="color:var(--brass-soft)"></p>
        </div>
        <div>
          <p class="display text-xl">${esc(g.home?.name ?? 'Home')}</p>
          <div class="flex items-center justify-center gap-2 mt-3">
            <button class="btn btn-ghost !px-3 !py-1" data-score="home" data-delta="-1" title="Correct the score">−</button>
            <span id="home-score" class="scoreline text-4xl w-16">${g.home_score}</span>
            <button class="btn btn-ghost !px-3 !py-1" data-score="home" data-delta="1" title="Correct the score">+</button>
          </div>
        </div>
      </div>
      <p class="text-[11px] text-white/45 text-center mt-4">Goals update the score automatically. Use − / + only to correct it.</p>
    </div>

    <div class="grid lg:grid-cols-[1fr,1.4fr] gap-5">
      <div class="grid gap-5 h-fit">
        <div class="panel p-5 grid gap-2">
          <div class="rule mb-1">Game status</div>
          <button id="go-live" class="btn ${g.status === 'live' ? 'btn-quiet' : 'btn-primary'}">${g.status === 'live' ? 'Game is live' : 'Start game (go live)'}</button>
          <button id="go-final" class="btn btn-quiet">Finalize game</button>
        </div>

        <div class="panel p-5 grid gap-2">
          <div class="flex items-center gap-2">
            <div class="rule flex-1">APs tonight</div>
            <button id="ap-refresh" class="text-xs font-semibold hover:underline" style="color:var(--ivy)">Refresh</button>
          </div>
          <div id="ap-list" class="grid"></div>
          <p class="text-xs text-gray-500">APs add themselves by scanning the AP QR code (ap.html). They show up here within 30 seconds. Remove anyone who isn't playing.</p>
        </div>

        <div class="panel p-5 text-xs text-gray-600 grid gap-1">
          <div class="rule mb-1">Keyboard</div>
          <p><kbd class="font-bold">G</kbd> goal · <kbd class="font-bold">P</kbd> penalty · <kbd class="font-bold">S</kbd> suspension</p>
          <p>Each jumps to that form's time box. <kbd class="font-bold">Tab</kbd> through the fields, <kbd class="font-bold">Enter</kbd> saves.</p>
          <p>Time can be typed as 12:34 or 1234. Period and time are prefilled from the scheduled start; just adjust.</p>
        </div>
      </div>

      <div class="panel p-5 grid gap-5">
        <div data-form="goal">
          <div class="rule mb-3">Goal</div>
          <div class="grid sm:grid-cols-2 gap-3">
            ${whenFields()}
            <select id="goal-scorer" class="field sm:col-span-2" aria-label="Scorer"></select>
            <select id="goal-a1" class="field" aria-label="First assist"></select>
            <select id="goal-a2" class="field" aria-label="Second assist"></select>
          </div>
          <button id="add-goal" data-submit class="btn btn-primary mt-3 w-full">Add goal &amp; update score</button>
        </div>

        <div data-form="pen" class="pt-4 border-t" style="border-color:var(--line)">
          <div class="rule mb-3">Penalty</div>
          <div class="grid sm:grid-cols-2 gap-3">
            ${whenFields()}
            <select id="pen-player" class="field sm:col-span-2" aria-label="Player"></select>
            <input id="pen-infraction" class="field" list="infractions" placeholder="Call (tripping, slashing…)" autocomplete="off">
            <select id="pen-minutes" class="field">
              <option value="2">2 minutes</option><option value="4">4 minutes</option>
              <option value="5">5 minutes</option><option value="10">10, misconduct</option>
            </select>
          </div>
          <datalist id="infractions">${INFRACTIONS.map(i => `<option value="${i}">`).join('')}</datalist>
          <button id="add-pen" data-submit class="btn btn-brass mt-3 w-full">Add penalty</button>
        </div>

        <div data-form="sus" class="pt-4 border-t" style="border-color:var(--line)">
          <div class="rule mb-3">Suspension</div>
          <div class="grid sm:grid-cols-2 gap-3">
            <select id="sus-player" class="field sm:col-span-2" aria-label="Player"></select>
            <select id="sus-kind" class="field">
              <option value="games">Number of games</option>
              <option value="until">Until a date</option>
              <option value="open">Until further notice</option>
            </select>
            <input id="sus-games" type="number" min="1" max="99" value="1" class="field" aria-label="Games">
            <input id="sus-until" type="date" class="field hidden" aria-label="Suspended until">
            <input id="sus-reason" class="field sm:col-span-2" placeholder="Reason (e.g. match penalty, fighting)" autocomplete="off">
          </div>
          <button id="add-sus" data-submit class="btn btn-quiet mt-3 w-full !text-red-800">Suspend player</button>
          <p class="text-xs text-gray-500 mt-2">Shows on the team rosters right away. Game suspensions count down as the player's team plays.</p>
          <div id="sus-list" class="grid mt-3"></div>
        </div>
      </div>
    </div>

    <div class="panel p-5 mt-5">
      <div class="rule mb-3">Game sheet</div>
      <div id="sheet" class="grid"></div>
    </div>`);

  const $ = s => document.getElementById(s);
  let state = { ...g };

  /* ---- player dropdowns ---- */
  const fillAssists = () => {
    const { team, player } = pick($('goal-scorer').value);
    const keep = [$('goal-a1').value, $('goal-a2').value];
    $('goal-a1').innerHTML = playerOptions({ team, exclude: player, blank: 'First assist (optional)' });
    $('goal-a2').innerHTML = playerOptions({ team, exclude: player, blank: 'Second assist (optional)' });
    $('goal-a1').value = keep[0]; $('goal-a2').value = keep[1];
    if ($('goal-a1').value !== keep[0]) $('goal-a1').value = '';
    if ($('goal-a2').value !== keep[1]) $('goal-a2').value = '';
  };
  const fillPlayers = () => {
    const keep = { scorer: $('goal-scorer').value, pen: $('pen-player').value, sus: $('sus-player').value };
    $('goal-scorer').innerHTML = playerOptions({ unlisted: true, blank: 'Scorer' });
    $('pen-player').innerHTML = playerOptions({ unlisted: true, blank: 'Player' });
    $('sus-player').innerHTML = playerOptions({ blank: 'Player to suspend' });
    $('goal-scorer').value = keep.scorer; $('pen-player').value = keep.pen; $('sus-player').value = keep.sus;
    fillAssists();
  };
  $('goal-scorer').onchange = fillAssists;

  /* ---- estimated period/time: header + prefill ---- */
  const when = form => document.querySelector(`[data-form="${form}"]`);
  const showEstimate = () => {
    const e = IvyGameTime.estimate(state.starts_at, state.period, Date.now(), IvyGameTime.isTied(state));
    $('est-period').textContent = e.period === IvyGameTime.SO ? 'Shootout' : e.period === IvyGameTime.OT ? 'Overtime' : `${ordinal(e.period)} period`;
    $('est-time').textContent = e.phase === 'pre' ? 'Not started yet (by the schedule)'
      : e.phase === 'over' ? (e.period === IvyGameTime.OT ? 'OT goal scored: finalize the game' : 'Scheduled time is up')
      : e.left == null ? '' : `about ${e.clock} left, by the schedule`;
    return e;
  };
  const prefill = form => {
    const e = showEstimate(), box = when(form);
    if (!box) return;
    box.querySelector('[data-when="period"]').value = String(e.period);
    if (!box.querySelector('[data-when="time"]').value && e.phase === 'play' && e.clock) box.querySelector('[data-when="time"]').placeholder = `Time, e.g. ${e.clock}`;
  };
  ['goal', 'pen'].forEach(prefill);
  let ticks = 0;
  tick = setInterval(() => { showEstimate(); if (++ticks % 2 === 0) reloadPlayers(); }, 15000);
  ['goal', 'pen'].forEach(f => when(f).querySelector('[data-when="time"]').addEventListener('focus', ev => {
    // Fill the estimate on focus so it's one keystroke to accept or overwrite.
    const e = IvyGameTime.estimate(state.starts_at, state.period, Date.now(), IvyGameTime.isTied(state));
    if (!ev.target.value && e.phase === 'play' && e.clock) { ev.target.value = e.clock; ev.target.select(); }
  }));

  /* Read period + time from a form; null (with a message) if the time is missing or wrong */
  const readWhen = form => {
    const box = when(form);
    const period = parseInt(box.querySelector('[data-when="period"]').value, 10);
    const raw = box.querySelector('[data-when="time"]').value;
    const clock = parseGameTime(raw);
    if (!clock && !(period === 5 && !raw.trim())) {
      toast('Enter the game time, like 12:34.', false);
      box.querySelector('[data-when="time"]').focus();
      return null;
    }
    return { period, clock: clock || '' };
  };
  const clearWhen = form => { when(form).querySelector('[data-when="time"]').value = ''; ['goal', 'pen'].forEach(prefill); };

  const save = async patch => {
    const { error } = await sb.from('games').update(patch).eq('id', id);
    if (error) toast('Could not save. Check your connection.', false);
    else state = { ...state, ...patch };
    return !error;
  };
  /* An entry moves the game along: it goes live, and the highest period entered becomes the game's period. */
  const advance = async period => {
    const patch = {};
    if (state.status === 'scheduled') patch.status = 'live';
    if (period > (state.period || 1)) patch.period = period;
    if (Object.keys(patch).length) await save(patch);
    if (patch.status) { $('go-live').textContent = 'Game is live'; $('go-live').className = 'btn btn-quiet'; }
  };
  const setScore = async (field, val) => {
    val = Math.max(0, val);
    if (await save({ [field]: val })) $(field === 'home_score' ? 'home-score' : 'away-score').textContent = val;
  };

  $('back').onclick = () => { clearInterval(tick); scoreView(); };

  document.querySelectorAll('[data-score]').forEach(b => b.onclick = () => {
    const field = b.dataset.score === 'home' ? 'home_score' : 'away_score';
    setScore(field, state[field] + Number(b.dataset.delta));
  });

  $('go-live').onclick = async () => {
    if (await save({ status: 'live' })) { toast('Game is live on the site.'); gameSheet(id); }
  };
  /* Finalize. NHL rules: an OT goal wins it; if still tied, the shootout
     winner gets one goal added to the final score (shootout goals never
     count on the scoreboard or in player stats). */
  $('go-final').onclick = async () => {
    const { data: evs } = await sb.from('game_events').select('type, team_id, period').eq('game_id', id);
    const goals = (evs || []).filter(e => e.type === 'goal');
    const so = goals.filter(e => e.period === IvyGameTime.SO);
    const ot = goals.some(e => e.period === IvyGameTime.OT);
    const tied = state.home_score === state.away_score;
    const patch = { status: 'final', decided_in: ot ? 'OT' : 'REG' };
    let ask = 'Finalize this game? Standings will update.';

    if (tied && so.length) {
      const h = so.filter(e => e.team_id === state.home_team_id).length, a = so.length - h;
      if (h === a) return toast(`The shootout is tied ${a}–${h}. Keep going until one team wins it.`, false);
      const homeWins = h > a;
      patch.decided_in = 'SO';
      patch[homeWins ? 'home_score' : 'away_score'] = state[homeWins ? 'home_score' : 'away_score'] + 1;
      ask = `${teamName(homeWins ? state.home_team_id : state.away_team_id)} win the shootout ${Math.max(a, h)}–${Math.min(a, h)}. ` +
        `Final score: ${teamName(state.away_team_id)} ${patch.away_score ?? state.away_score}, ${teamName(state.home_team_id)} ${patch.home_score ?? state.home_score}. Finalize?`;
    } else if (tied) {
      ask = 'The score is tied. Under NHL rules it goes to 5 minutes of OT, then a shootout. Finalize it as a tie anyway?';
    } else if (so.length) {
      ask = "Shootout goals are on the sheet, but the score isn't tied, so they'll be ignored. Finalize?";
    }
    if (!confirm(ask)) return;

    let { error } = await sb.from('games').update(patch).eq('id', id);
    if (error && /decided_in/.test(error.message || '')) {   // overtime.sql not run yet
      delete patch.decided_in;
      ({ error } = await sb.from('games').update(patch).eq('id', id));
    }
    if (error) return toast('Could not save. Check your connection.', false);
    toast('Game finalized.'); clearInterval(tick); scoreView();
  };

  /* ---- goal ---- */
  $('add-goal').onclick = async () => {
    const w = readWhen('goal'); if (!w) return;
    const v = $('goal-scorer').value;
    if (!v) { $('goal-scorer').focus(); return toast('Pick the scorer.', false); }
    const { team, player } = pick(v);
    const shootout = w.period === IvyGameTime.SO;
    const { error } = await sb.from('game_events').insert({
      game_id: id, team_id: team, type: 'goal', player_id: player,
      assist1_id: shootout ? null : ($('goal-a1').value || null), assist2_id: shootout ? null : ($('goal-a2').value || null),
      period: w.period, clock: w.clock, created_by: me.id
    });
    if (error) return toast('Goal did not save.', false);
    // Shootout goals don't go on the scoreboard; the winner gets one goal when the game is finalized.
    if (!shootout) {
      const field = team === state.home_team_id ? 'home_score' : 'away_score';
      await setScore(field, state[field] + 1);
    }
    await advance(w.period);
    $('goal-scorer').value = ''; fillAssists(); clearWhen('goal');
    toast(shootout ? 'Shootout goal recorded.' : w.period === IvyGameTime.OT ? 'OT goal recorded. Finalize the game when ready.' : 'Goal recorded.');
    loadSheet();
  };

  /* ---- penalty ---- */
  $('add-pen').onclick = async () => {
    const w = readWhen('pen'); if (!w) return;
    const v = $('pen-player').value;
    if (!v) { $('pen-player').focus(); return toast('Pick the player.', false); }
    const call = $('pen-infraction').value.trim();
    if (!call) { $('pen-infraction').focus(); return toast('Enter the call.', false); }
    const { team, player } = pick(v);
    const { error } = await sb.from('game_events').insert({
      game_id: id, team_id: team, type: 'penalty', player_id: player,
      infraction: call, minutes: parseInt($('pen-minutes').value, 10),
      period: w.period, clock: w.clock, created_by: me.id
    });
    if (error) return toast('Penalty did not save.', false);
    await advance(w.period);
    $('pen-player').value = ''; $('pen-infraction').value = ''; clearWhen('pen');
    toast('Penalty recorded.');
    loadSheet();
  };

  /* ---- suspensions ---- */
  $('sus-kind').onchange = () => {
    $('sus-games').classList.toggle('hidden', $('sus-kind').value !== 'games');
    $('sus-until').classList.toggle('hidden', $('sus-kind').value !== 'until');
  };
  $('add-sus').onclick = async () => {
    const pid = $('sus-player').value;
    if (!pid) { $('sus-player').focus(); return toast('Pick the player to suspend.', false); }
    const kind = $('sus-kind').value;
    const games = kind === 'games' ? parseInt($('sus-games').value, 10) : null;
    const until = kind === 'until' ? $('sus-until').value : null;
    if (kind === 'games' && !(games > 0)) return toast('Enter how many games.', false);
    if (kind === 'until' && !until) return toast('Pick the date the suspension runs until.', false);
    const { error } = await sb.from('suspensions').insert({
      player_id: pid, team_id: pick(pid).team, game_id: id,
      games, until_date: until, reason: $('sus-reason').value.trim() || null, created_by: me.id
    });
    if (error) return toast(/relation|does not exist|schema cache/i.test(error.message)
      ? 'Suspensions are not set up in the database yet. Ask an admin to run the SQL.' : 'Suspension did not save.', false);
    $('sus-player').value = ''; $('sus-reason').value = '';
    toast('Suspension recorded. It now shows on the roster.');
    loadSusp();
  };

  async function loadSusp() {
    suspList = (await IvySusp.loadActive(sb)).filter(s => (players || []).some(p => p.id === s.player_id));
    suspBy = IvySusp.byPlayer(suspList);
    fillPlayers();
    const byId = pid => (players || []).find(p => p.id === pid);
    $('sus-list').innerHTML = suspList.length ? `<p class="text-xs font-bold text-gray-500 mb-1">Currently suspended</p>` + suspList.map(s => {
      const p = byId(s.player_id);
      return `
      <div class="flex items-center gap-3 text-sm py-2 border-b" style="border-color:var(--line)">
        <span class="flex-1"><b>${esc(pName(p))}</b> <span class="text-gray-500">${esc(teamName(p.team_id))}</span>
          <span class="text-red-800 font-semibold">· ${esc(s.label)}</span>
          ${s.reason ? `<span class="text-gray-500">· ${esc(s.reason)}</span>` : ''}</span>
        <button data-lift="${s.id}" class="text-xs text-red-700 hover:underline">Lift</button>
      </div>`; }).join('') : '';
  }
  $('sus-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-lift]'); if (!b) return;
    if (!confirm('Lift this suspension? The player will no longer show as suspended.')) return;
    const { error } = await sb.from('suspensions').update({ lifted_at: new Date().toISOString(), lifted_by: me.id }).eq('id', b.dataset.lift);
    toast(error ? 'Could not lift it.' : 'Suspension lifted.', !error);
    loadSusp();
  });

  /* ---- APs: they check themselves in from ap.html, so keep the list fresh ---- */
  const renderAps = () => {
    const aps = (players || []).filter(p => p.status === 'ap');
    $('ap-list').innerHTML = aps.length ? aps.map(p => `
      <div class="flex items-center gap-3 text-sm py-2 border-b" style="border-color:var(--line)">
        <span class="flex-1"><b>${esc(pName(p))}</b> <span class="text-gray-500">${esc(teamName(p.team_id))}</span></span>
        <button data-del-ap="${p.id}" class="text-xs text-red-700 hover:underline">Remove</button>
      </div>`).join('') : '<p class="text-sm text-gray-500">No APs on either team yet.</p>';
  };
  async function reloadPlayers() {
    const fresh = await loadPlayers();
    if (!fresh) return;
    const changed = JSON.stringify(fresh) !== JSON.stringify(players);
    players = fresh;
    if (changed) { fillPlayers(); renderAps(); }
  }
  $('ap-refresh').onclick = async () => { await reloadPlayers(); renderAps(); toast('Players refreshed.'); };
  $('ap-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-del-ap]'); if (!b) return;
    if (!confirm('Remove this AP from the team? Do this only if they are not actually playing.')) return;
    const { error } = await sb.from('players').delete().eq('id', b.dataset.delAp);
    if (error) return toast('Could not remove them.', false);
    toast('AP removed.');
    reloadPlayers();
  });

  /* ---- game sheet log ---- */
  async function loadSheet() {
    const { data } = await sb.from('game_events')
      .select('id, type, team_id, period, clock, minutes, infraction, player:player_id(first_name,last_name,jersey_number), a1:assist1_id(last_name), a2:assist2_id(last_name)')
      .eq('game_id', id).order('period', { ascending: false }).order('created_at', { ascending: false });
    const so = (data || []).filter(e => e.type === 'goal' && e.period === IvyGameTime.SO);
    const soH = so.filter(e => e.team_id === state.home_team_id).length;
    $('so-tally').textContent = so.length ? `Shootout: ${teamName(state.away_team_id)} ${so.length - soH}, ${teamName(state.home_team_id)} ${soH}` : '';
    $('so-tally').classList.toggle('hidden', !so.length);
    $('sheet').innerHTML = (data || []).length ? data.map(e => `
      <div class="flex items-center gap-3 text-sm py-2 border-b" style="border-color:var(--line)">
        <span class="text-gray-400 w-20 tnum">${ordinal(e.period)} ${esc(e.clock ?? '')}</span>
        <span class="font-bold w-12" style="color:${e.type === 'penalty' ? 'var(--brass)' : 'var(--ivy)'}">${e.type === 'penalty' ? 'PEN' : e.period === IvyGameTime.SO ? 'SO' : 'GOAL'}</span>
        <span class="flex-1">${e.player ? `#${e.player.jersey_number ?? ''} ${esc(e.player.first_name)} ${esc(e.player.last_name)}` : esc(teamName(e.team_id))}
          ${e.type === 'goal' && (e.a1 || e.a2) ? `<span class="text-gray-500">(${[e.a1?.last_name, e.a2?.last_name].filter(Boolean).map(esc).join(', ')})</span>` : ''}
          ${e.type === 'penalty' ? `<span class="text-gray-500">${esc(e.infraction ?? '')}, ${e.minutes} min</span>` : ''}</span>
        <button data-del="${e.id}" data-type="${e.type === 'goal' && e.period === IvyGameTime.SO ? 'so' : e.type}" data-team="${e.team_id ?? ''}" class="text-xs text-red-700 hover:underline">Remove</button>
      </div>`).join('') : '<p class="text-sm text-gray-500">Nothing recorded yet.</p>';
  }
  $('sheet').addEventListener('click', async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const goal = b.dataset.type === 'goal';
    if (!confirm(goal ? 'Remove this goal? The score goes down by one.' : 'Remove this entry?')) return;
    const { error } = await sb.from('game_events').delete().eq('id', b.dataset.del);
    if (error) return toast('Could not remove it.', false);
    if (goal && b.dataset.team) {
      const field = b.dataset.team === state.home_team_id ? 'home_score' : 'away_score';
      await setScore(field, state[field] - 1);
    }
    loadSheet();
  });

  /* ---- keyboard: G / P / S jump to a form, Enter saves the form you're in ---- */
  $('view').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    form.querySelector('[data-submit]').click();
  });
  sheetKeys = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const target = { g: '[data-form="goal"] [data-when="time"]', p: '[data-form="pen"] [data-when="time"]', s: '#sus-player' }[e.key.toLowerCase()];
    const el = target && document.querySelector(target);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus();
  };

  fillPlayers();
  renderAps();
  loadSusp();
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
          <th>Division</th><th>Team</th><th>Paid</th><th>Status</th><th>Emergency</th><th></th></tr></thead>
        <tbody>${(regs || []).map(r => `
          <tr data-id="${r.id}">
            <td class="text-gray-500 whitespace-nowrap">${fmtDT(r.created_at)}</td>
            <td class="font-semibold"><button class="underline text-left" data-profile="${r.player_id || 'r:' + r.id}">${esc(r.first_name)} ${esc(r.last_name)}</button>
              ${r.notes ? `<div class="text-xs text-gray-500 font-normal max-w-48">${esc(r.notes)}</div>` : ''}</td>
            <td class="text-xs"><a href="mailto:${esc(r.email)}" class="underline">${esc(r.email)}</a><br>${esc(r.phone ?? '')}</td>
            <td>${esc(r.position ?? '')}</td><td>${r.jersey_number ?? ''}</td>
            <td>${esc(r.division ?? '')}</td>
            <td><select class="field !py-1 !text-xs" data-field="team_id">${teamOpts(r)}</select></td>
            <td><select class="field !py-1 !text-xs" data-field="payment_status">
              ${PAY_STATUSES.map(s => `<option value="${s}" ${s === r.payment_status ? 'selected' : ''}>${PAY_LABEL[s]}${s === r.payment_status && r.payment_type === 'plan' && r.installments_total ? ` ${r.installments_paid ?? 0}/${r.installments_total}` : ''}</option>`).join('')}
            </select></td>
            <td><select class="field !py-1 !text-xs" data-field="status">
              ${['new', 'approved', 'waitlist', 'declined'].map(s => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select></td>
            <td class="text-xs text-gray-500">${esc(r.emergency_name ?? '')}<br>${esc(r.emergency_phone ?? '')}</td>
            <td><button data-delreg="${r.id}" class="text-xs text-red-700 hover:underline">Delete</button></td>
          </tr>`).join('') || '<tr><td colspan="11" class="text-sm text-gray-500">No registrations yet.</td></tr>'}
        </tbody>
      </table>
    </div>`);

  document.getElementById('view').addEventListener('change', async e => {
    const sel = e.target.closest('[data-field]'); if (!sel) return;
    const id = sel.closest('tr').dataset.id;
    const val = sel.dataset.field === 'team_id' ? (sel.value || null) : sel.value;
    const { error } = await sb.from('registrations').update({ [sel.dataset.field]: val }).eq('id', id);
    toast(error ? 'Could not update that registration.' : 'Updated.', !error);
    if (sel.dataset.field === 'status') refreshCounts();
  });

  /* Delete a registration. If it was approved onto a roster, offer to take the
     player off too: they're set inactive (hidden from the public roster) rather
     than deleted, so goals/penalties they already have stay on the record. */
  document.getElementById('view').addEventListener('click', async e => {
    const prof = e.target.closest('[data-profile]'); if (prof) return go('player', prof.dataset.profile);
    const b = e.target.closest('[data-delreg]'); if (!b) return;
    const r = (regs || []).find(x => x.id === b.dataset.delreg); if (!r) return;
    const name = `${r.first_name} ${r.last_name}`;
    if (!confirm(`Delete ${name}'s registration? This can't be undone.`)) return;
    const offRoster = r.player_id &&
      confirm(`${name} is on the ${r.team?.name ?? 'team'} roster.\n\nOK: take them off the roster too (their stats are kept).\nCancel: leave them on the roster.`);
    const { data, error } = await sb.from('registrations').delete().eq('id', r.id).select('id');
    if (error || !data?.length) return toast(error ? 'Could not delete that registration.' : 'Not allowed: only admins can delete registrations.', false);
    if (offRoster) {
      const { error: pe } = await sb.from('players').update({ status: 'inactive' }).eq('id', r.player_id);
      if (pe) toast('Registration deleted, but the player is still on the roster. Remove them in Teams & rosters.', false);
      else toast('Registration deleted and player taken off the roster.');
    } else toast('Registration deleted.');
    regsView();
  });

  document.getElementById('export').onclick = () => {
    const cols = ['created_at', 'first_name', 'last_name', 'email', 'phone', 'position', 'jersey_number', 'shirt_size', 'division', 'emergency_name', 'emergency_phone', 'payment_status', 'payment_type', 'plan_status', 'installments_paid', 'installments_total', 'amount_paid_cents', 'amount_total_cents', 'next_payment_at', 'status', 'notes'];
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
  const { data: divisions } = await sb.from('divisions').select('*').order('sort').order('name');
  const opts = (sel) => (teams || []).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const divOpts = (sel) => (divisions || []).map(d => `<option ${d.name === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

  mount(`
    <h2 class="display text-2xl mb-5">Schedule</h2>
    <div class="panel p-5 mb-6">
      <div class="rule mb-3">Add a game</div>
      <div class="grid md:grid-cols-5 gap-3">
        <select id="n-away" class="field"><option value="">Away team</option>${opts()}</select>
        <select id="n-home" class="field"><option value="">Home team</option>${opts()}</select>
        <input id="n-when" type="datetime-local" class="field">
        <select id="n-div" class="field"><option value="">Division</option>${divOpts()}</select>
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
        fixed ice slot. Edit or delete any of them below. Divisions are managed in the Teams &amp; rosters tab.</p>
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
            <td><select class="field !py-1 !text-xs !w-28" data-f="division"><option value="">—</option>${divOpts(g.division)}</select></td>
            <td><input class="field !py-1 !text-xs" data-f="venue" value="${esc(g.venue ?? '')}"></td>
            <td><select class="field !py-1 !text-xs" data-f="status">
              ${['scheduled', 'live', 'final', 'postponed'].map(s => `<option ${s === g.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <select class="field !py-1 !text-xs mt-1" data-f="decided_in" title="How the game was decided">
              ${[['REG', 'Regulation'], ['OT', 'Overtime'], ['SO', 'Shootout']].map(([v, l]) => `<option value="${v}" ${v === (g.decided_in || 'REG') ? 'selected' : ''}>${l}</option>`).join('')}
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
      history.replaceState(null, '', '#/score');
      highlightNav('score');
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
  const { data: divisions } = await sb.from('divisions').select('*').order('sort').order('name');
  const suspBy = IvySusp.byPlayer(await IvySusp.loadActive(sb));
  const suspTag = p => { const s = suspBy.get(p.id); return s ? `
    <span class="ml-2 inline-block text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-red-700 text-white">Suspended · ${esc(s.label)}</span>
    ${s.reason ? `<span class="text-xs font-normal text-gray-500 ml-1">${esc(s.reason)}</span>` : ''}
    <button data-lift="${s.id}" class="text-xs font-normal text-red-700 hover:underline ml-1">Lift</button>` : ''; };
  const divOpts = sel => (divisions || []).map(d => `<option ${d.name === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

  mount(`
    <h2 class="display text-2xl mb-5">Teams &amp; rosters</h2>

    <div class="panel p-5 mb-6 max-w-2xl">
      <div class="rule mb-3">Divisions</div>
      <div class="grid gap-2 mb-3">
        ${(divisions || []).map(d => `
          <div class="flex items-center gap-2" data-division="${d.id}">
            <input class="field !py-1 !text-sm flex-1" data-df="name" value="${esc(d.name)}">
            <button data-deldiv="${d.id}" class="text-xs text-red-700 hover:underline whitespace-nowrap">Delete</button>
          </div>`).join('') || '<p class="text-sm text-gray-500">No divisions yet — add one below.</p>'}
      </div>
      <div class="flex gap-2">
        <input id="nd-name" class="field" placeholder="New division — e.g. Lager">
        <button id="add-division" class="btn btn-quiet whitespace-nowrap">Add division</button>
      </div>
      <p class="text-xs text-gray-500 mt-2">These are the options offered for a team's division below, and for a game's division in the Schedule tab.
        Renaming one here does not rename it on teams already using the old name.</p>
    </div>

    <div class="panel p-5 mb-6 max-w-2xl flex flex-wrap items-center gap-5">
      <img src="assets/img/ap-qr.png" alt="AP check-in QR code" class="w-28 h-28 rounded-sm border" style="border-color:var(--line)">
      <div class="flex-1 min-w-[14rem]">
        <div class="rule mb-2">AP check-in QR code</div>
        <p class="text-sm text-gray-600">APs scan this, type their name, pick the team and their number. They're added to that roster as an AP.
          Post it at the rink or on the bench door.</p>
        <div class="flex flex-wrap gap-2 mt-3">
          <a href="ap-poster.html" target="_blank" rel="noopener" class="btn btn-primary !py-2 !text-xs">Print poster</a>
          <a href="assets/img/ap-qr.png" download="ivy-ap-qr.png" class="btn btn-quiet !py-2 !text-xs">Download QR</a>
          <a href="ap.html" target="_blank" rel="noopener" class="btn btn-quiet !py-2 !text-xs">Open check-in page</a>
        </div>
      </div>
    </div>

    <div class="panel p-5 mb-6">
      <div class="rule mb-3">Add a team</div>
      <div class="grid md:grid-cols-4 gap-3">
        <input id="t-name" class="field" placeholder="Team name">
        <select id="t-div" class="field"><option value="">Choose a division</option>${divOpts()}</select>
        <input id="t-colour" type="color" class="field !p-1 h-11" value="#09522B">
        <input id="t-logo" class="field" placeholder="Logo image URL">
      </div>
      <button id="add-team" class="btn btn-primary mt-3">Add team</button>
    </div>

    ${(teams || []).map(t => `
      <div class="panel mb-4 overflow-hidden" data-team="${t.id}">
        <div class="p-4 flex flex-wrap items-center gap-3" style="background:${esc(t.colour)};color:#fff">
          <input class="field !py-1 !w-56 !text-sm !text-black" data-tf="name" value="${esc(t.name)}">
          <select class="field !py-1 !w-36 !text-sm !text-black" data-tf="division">${divOpts(t.division)}</select>
          <input class="field !py-1 !w-64 !text-sm !text-black" data-tf="logo_url" value="${esc(t.logo_url ?? '')}" placeholder="Logo URL">
          <span class="text-xs text-white/70 ml-auto">${(players || []).filter(p => p.team_id === t.id).length} players</span>
        </div>
        <table class="grid-table">
          <thead><tr><th class="w-16">#</th><th>Player</th><th>Position</th><th>Status</th><th></th></tr></thead>
          <tbody>${(players || []).filter(p => p.team_id === t.id).map(p => `
            <tr data-player="${p.id}">
              <td><input class="field !py-1 !w-14 !text-xs" data-pf="jersey_number" value="${p.jersey_number ?? ''}"></td>
              <td class="font-semibold">${esc(p.first_name)} ${esc(p.last_name)}${suspTag(p)}</td>
              <td><select class="field !py-1 !text-xs" data-pf="position">
                ${['Forward', 'Defence', 'Goalie'].map(x => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
              <td><select class="field !py-1 !text-xs" data-pf="status">
                ${[['active', 'active'], ['ap', 'AP'], ['spare', 'spare'], ['inactive', 'inactive']].map(([v, l]) => `<option value="${v}" ${v === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
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

  document.getElementById('add-division').onclick = async () => {
    const name = document.getElementById('nd-name').value.trim();
    if (!name) return toast('Give the division a name.', false);
    const { error } = await sb.from('divisions').insert({ name });
    if (error) return toast(error.message.includes('duplicate') ? 'That division already exists.' : 'Could not add it.', false);
    teamsView();
  };

  document.getElementById('view').addEventListener('change', async e => {
    const tf = e.target.closest('[data-tf]');
    if (tf) {
      const id = tf.closest('[data-team]').dataset.team;
      const { error } = await sb.from('teams').update({ [tf.dataset.tf]: tf.value }).eq('id', id);
      return toast(error ? 'Not saved.' : 'Saved.', !error);
    }
    const df = e.target.closest('[data-df]');
    if (df) {
      const id = df.closest('[data-division]').dataset.division;
      const { error } = await sb.from('divisions').update({ name: df.value.trim() }).eq('id', id);
      return toast(error ? 'Could not rename — that name may already exist.' : 'Saved.', !error);
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
    const lift = e.target.closest('[data-lift]');
    if (lift) {
      if (!confirm('Lift this suspension? The player will no longer show as suspended.')) return;
      const { error } = await sb.from('suspensions').update({ lifted_at: new Date().toISOString(), lifted_by: me.id }).eq('id', lift.dataset.lift);
      toast(error ? 'Could not lift it.' : 'Suspension lifted.', !error);
      return teamsView();
    }
    const deldiv = e.target.closest('[data-deldiv]');
    if (deldiv) {
      if (!confirm('Delete this division? Teams already using it keep the name, but it will no longer appear as an option.')) return;
      await sb.from('divisions').delete().eq('id', deldiv.dataset.deldiv);
      return teamsView();
    }
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
  const PAGES = [
    ['index.html', 'Home'], ['schedule.html', 'Schedule'], ['standings.html', 'Standings'],
    ['teams.html', 'Teams'], ['register.html', 'Register'], ['live.html', 'Live scores']
  ];

  mount(`
    <h2 class="display text-2xl mb-1">Pages</h2>
    <p class="text-sm text-gray-600 mb-5 max-w-3xl">Every editable piece of text, imagery, and colour on the public site.
      The preview on the right updates as you type — nothing is public until you click "Save changes".</p>

    <div class="grid lg:grid-cols-[1fr,1.1fr] gap-6 items-start">
      <div>
        <div class="grid gap-3">
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
          paste it into any image field above, a team logo, or an announcement.</p>
      </div>

      <div class="lg:sticky lg:top-6">
        <div class="flex items-center justify-between mb-2">
          <div class="rule !mb-0">Live preview</div>
          <select id="preview-page" class="field !w-40 !py-2 !text-xs">
            ${PAGES.map(([f, l]) => `<option value="${f}">${l}</option>`).join('')}
          </select>
        </div>
        <iframe id="preview-frame" src="index.html" title="Live preview"
          class="w-full rounded-md" style="height:75vh;border:1px solid var(--line)"></iframe>
        <p class="text-xs text-gray-500 mt-2">Only text, images, and colours that appear on the page you've selected will change here —
          e.g. the hero fields won't show on the Schedule page.</p>
      </div>
    </div>`);

  /* ---- live preview: mirror unsaved field values into the iframe ---- */
  const THEME_VARS = { 'theme.ivy': '--ivy', 'theme.ivy_deep': '--ivy-deep', 'theme.brass': '--brass', 'theme.sprig': '--ivy-sprig' };
  function syncPreview() {
    const doc = document.getElementById('preview-frame')?.contentDocument;
    if (!doc) return;
    document.querySelectorAll('[data-key]').forEach(row => {
      const key = row.dataset.key;
      const val = row.querySelector('input, textarea').value;
      if (THEME_VARS[key]) { doc.documentElement.style.setProperty(THEME_VARS[key], val); return; }
      doc.querySelectorAll(`[data-cms="${CSS.escape(key)}"]`).forEach(el => { el.innerHTML = esc(val).replace(/\n/g, '<br>'); });
      doc.querySelectorAll(`[data-cms-src="${CSS.escape(key)}"]`).forEach(el => { if (val) el.src = val; });
      doc.querySelectorAll(`[data-cms-href="${CSS.escape(key)}"]`).forEach(el => { if (val) el.href = val; });
    });
  }
  const frame = document.getElementById('preview-frame');
  frame.addEventListener('load', () => {
    try { frame.contentWindow.document.addEventListener('ivy:ready', syncPreview); } catch (e) {}
    syncPreview();
  });
  document.getElementById('preview-page').addEventListener('change', e => { frame.src = e.target.value; });
  let previewDebounce;
  document.getElementById('view').addEventListener('input', () => {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(syncPreview, 500);
  });

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

/* ================= 5c. More Pages (custom one-off pages) ======== */
async function morePagesView() {
  const { data: pages } = await sb.from('custom_pages').select('*').order('sort');

  mount(`
    <h2 class="display text-2xl mb-1">More Pages</h2>
    <p class="text-sm text-gray-600 mb-5 max-w-2xl">Build a standalone page for a one-off event — a golf tournament, a sponsor page,
      a rules page — styled like the rest of the site. Each one gets its own link: <code>page.html?slug=your-slug</code>.
      Share that link directly, or add a button to it somewhere on the site yourself.</p>

    <div class="panel p-5 mb-6 max-w-3xl">
      <div class="rule mb-3">Create a page</div>
      <div class="grid md:grid-cols-2 gap-3">
        <input id="np-title" class="field" placeholder="Title — e.g. Summer Golf Tournament">
        <input id="np-slug" class="field" placeholder="Slug — e.g. golf-2026 (letters, numbers, dashes)">
      </div>
      <button id="np-create" class="btn btn-primary mt-3">Create page</button>
    </div>

    <div class="grid gap-3 max-w-3xl">
      ${(pages || []).map(p => `
        <div class="panel p-4 grid gap-3" data-page="${p.id}">
          <div class="flex items-center justify-between gap-3">
            <input class="field !text-base font-semibold flex-1" data-pgf="title" value="${esc(p.title)}">
            <a href="page.html?slug=${esc(p.slug)}" target="_blank" class="text-xs underline shrink-0">page.html?slug=${esc(p.slug)}</a>
          </div>
          <input class="field !text-sm" data-pgf="kicker" placeholder="Kicker line above the title (optional)" value="${esc(p.kicker ?? '')}">
          <textarea class="field !text-sm" rows="5" data-pgf="body" placeholder="Page content — leave a blank line between paragraphs">${esc(p.body ?? '')}</textarea>
          <input class="field !text-sm" data-pgf="image_url" placeholder="Image URL (optional)" value="${esc(p.image_url ?? '')}">
          <div class="flex items-center justify-between">
            <label class="text-xs flex items-center gap-1"><input type="checkbox" data-pgf="published" ${p.published ? 'checked' : ''}> Published</label>
            <div class="flex gap-3">
              <button data-savepage="${p.id}" class="btn btn-quiet !py-1.5 !px-3 !text-xs">Save</button>
              <button data-delpage="${p.id}" class="text-xs text-red-700 hover:underline">Delete</button>
            </div>
          </div>
        </div>`).join('') || '<p class="text-sm text-gray-500">No custom pages yet.</p>'}
    </div>`);

  document.getElementById('np-create').onclick = async () => {
    const title = document.getElementById('np-title').value.trim();
    const slug = document.getElementById('np-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!title || !slug) return toast('Give it a title and a slug.', false);
    const { error } = await sb.from('custom_pages').insert({ title, slug, published: false });
    if (error) return toast(error.message.includes('duplicate') ? 'That slug is already used.' : 'Could not create the page.', false);
    toast('Page created — fill it in below, then mark it Published.');
    morePagesView();
  };

  document.getElementById('view').addEventListener('click', async e => {
    const save = e.target.closest('[data-savepage]');
    if (save) {
      const row = save.closest('[data-page]');
      const field = f => row.querySelector(`[data-pgf="${f}"]`);
      const { error } = await sb.from('custom_pages').update({
        title: field('title').value.trim(),
        kicker: field('kicker').value || null,
        body: field('body').value,
        image_url: field('image_url').value || null,
        published: field('published').checked,
        updated_at: new Date().toISOString()
      }).eq('id', save.dataset.savepage);
      toast(error ? 'Could not save.' : 'Saved.', !error);
      return;
    }
    const b = e.target.closest('[data-delpage]'); if (!b) return;
    if (!confirm('Delete this page? The link will stop working.')) return;
    await sb.from('custom_pages').delete().eq('id', b.dataset.delpage);
    morePagesView();
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
  const { data: ov } = await sb.from('site_content').select('value').eq('key', 'register.override').maybeSingle();

  mount(`
    <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
      <h2 class="display text-2xl">Payment options</h2>
      <button id="set-pin" class="btn btn-quiet !text-xs !py-2">Set / change PIN</button>
    </div>
    <p class="text-sm text-gray-600 mb-3 max-w-2xl">Each option shows on the registration page. Give it a <b>Stripe price ID</b>
      (<code>price_…</code>, from the product in Stripe) and players pick it inside the registration form and pay straight away:
      a one-time price is a full payment, a monthly price is a payment plan. Payments then show up in the office by themselves.</p>
    <p class="text-sm text-gray-600 mb-5 max-w-2xl">For a plan, set <b>Number of payments</b> and the plan stops itself after the last one
      (leave it blank to keep charging until cancelled). An option with only a Stripe link and no price ID still shows as a separate
      "Pay with Stripe" button, like before. Untick "Active" to retire an option without deleting it.</p>

    <div class="panel p-5 mb-6 max-w-3xl" style="border-color:var(--brass)">
      <div class="rule mb-3">Registration page override</div>
      <p class="text-sm text-gray-600 mb-3">For a one-off event — a golf tournament, a special fundraiser — that shouldn't use the normal
        hockey sign-up form. Fill this in and the whole registration page switches to showing this text instead (payment links below
        still show underneath it). Clear it back to empty to restore the normal registration form.</p>
      <textarea id="reg-override" rows="5" class="field" placeholder="Leave blank for the normal registration form">${esc(ov?.value ?? '')}</textarea>
      <button id="save-override" class="btn btn-brass mt-3">Save</button>
      <a href="register.html" target="_blank" class="text-xs underline ml-3">Preview registration page</a>
    </div>

    <div class="panel p-5 mb-6 max-w-3xl">
      <div class="rule mb-3">Add an option</div>
      <div class="grid md:grid-cols-2 gap-3">
        <input id="p-label" class="field" placeholder="Label — e.g. Lager Division, full season">
        <input id="p-price" class="field" placeholder="Price text — e.g. $425 + HST">
        <input id="p-stripe" class="field" placeholder="Stripe price ID — price_...">
        <input id="p-inst" class="field" type="number" min="1" placeholder="Number of payments (plans only)">
        <input id="p-url" class="field md:col-span-2" placeholder="Or a Stripe link instead — https://buy.stripe.com/...">
        <input id="p-desc" class="field md:col-span-2" placeholder="Short description (optional) — e.g. 4 monthly payments of $110">
      </div>
      <button id="add-link" class="btn btn-primary mt-3">Add option</button>
    </div>

    <div class="grid gap-3 max-w-3xl">
      ${(links || []).map(l => `
        <div class="panel p-4 grid md:grid-cols-2 gap-3" data-link="${l.id}">
          <input class="field" data-lf="label" value="${esc(l.label)}">
          <input class="field" data-lf="price_text" value="${esc(l.price_text ?? '')}">
          <input class="field" data-lf="stripe_price_id" value="${esc(l.stripe_price_id ?? '')}" placeholder="Stripe price ID — price_...">
          <input class="field" data-lf="installments" type="number" min="1" value="${l.installments ?? ''}" placeholder="Number of payments (plans only)">
          <input class="field md:col-span-2" data-lf="url" value="${esc(l.url ?? '')}" placeholder="Stripe link (only used without a price ID)">
          <input class="field md:col-span-2" data-lf="description" value="${esc(l.description ?? '')}">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-lf="active" ${l.active ? 'checked' : ''}> Active on the site</label>
          <div class="text-right"><button data-dell="${l.id}" class="text-xs text-red-700 hover:underline">Delete option</button></div>
        </div>`).join('') || '<p class="text-sm text-gray-500">No payment links yet.</p>'}
    </div>`);

  document.getElementById('save-override').onclick = async () => {
    const { error } = await sb.from('site_content')
      .upsert({ key: 'register.override', value: document.getElementById('reg-override').value, updated_at: new Date().toISOString() });
    toast(error ? 'Could not save.' : 'Registration page updated.', !error);
  };

  document.getElementById('set-pin').onclick = async () => {
    const pin = prompt('Set a new payments PIN (share it only with people you trust to edit Stripe links):');
    if (!pin) return;
    const { error } = await sb.rpc('set_payments_pin', { new_pin: pin });
    toast(error ? 'Could not set the PIN — are you signed in as an admin?' : 'PIN updated.', !error);
  };

  document.getElementById('add-link').onclick = async () => {
    const url = document.getElementById('p-url').value.trim();
    const priceId = document.getElementById('p-stripe').value.trim();
    const inst = parseInt(document.getElementById('p-inst').value, 10);
    if (priceId && !priceId.startsWith('price_')) return toast('A Stripe price ID starts with price_ (not prod_).', false);
    if (!priceId && !url.startsWith('http')) return toast('Add a Stripe price ID, or paste the full Stripe link.', false);
    const { error } = await sb.from('payment_links').insert({
      label: document.getElementById('p-label').value || 'Registration',
      price_text: document.getElementById('p-price').value,
      description: document.getElementById('p-desc').value, url: url || null,
      stripe_price_id: priceId || null, installments: inst > 0 ? inst : null
    });
    if (error) return toast(/column|schema cache/i.test(error.message) ? 'Run supabase/stripe.sql in Supabase first.' : 'Could not add that option.', false);
    payView();
  };

  document.getElementById('view').addEventListener('change', async e => {
    const f = e.target.closest('[data-lf]'); if (!f) return;
    const id = f.closest('[data-link]').dataset.link;
    let val = f.type === 'checkbox' ? f.checked : f.value.trim();
    if (f.dataset.lf === 'installments') val = parseInt(val, 10) > 0 ? parseInt(val, 10) : null;
    if (f.dataset.lf === 'stripe_price_id' || f.dataset.lf === 'url') val = val || null;
    if (f.dataset.lf === 'stripe_price_id' && val && !val.startsWith('price_')) return toast('A Stripe price ID starts with price_ (not prod_).', false);
    const { error } = await sb.from('payment_links').update({ [f.dataset.lf]: val }).eq('id', id);
    toast(error ? 'Not saved.' : 'Saved.', !error);
  });

  document.getElementById('view').addEventListener('click', async e => {
    const b = e.target.closest('[data-dell]'); if (!b) return;
    if (!confirm('Delete this payment option?')) return;
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
        <div class="panel p-4" data-news="${n.id}">
          <div class="flex items-start gap-4">
            ${n.image_url ? `<img src="${esc(n.image_url)}" alt="" class="h-16 w-24 object-cover rounded shrink-0">` : ''}
            <div class="flex-1 grid gap-2">
              <input class="field !text-base font-semibold" data-nf-text="title" value="${esc(n.title)}">
              <textarea class="field !text-sm" rows="3" data-nf-text="body">${esc(n.body ?? '')}</textarea>
              <p class="text-xs text-gray-500">${fmtDT(n.published_at)} · <a href="news.html?id=${n.id}" target="_blank" class="underline">Preview full article</a></p>
            </div>
            <div class="grid gap-2 text-right shrink-0">
              <label class="text-xs flex items-center gap-1 justify-end"><input type="checkbox" data-nf="published" ${n.published ? 'checked' : ''}> Live</label>
              <button data-savenews="${n.id}" class="btn btn-quiet !py-1.5 !px-3 !text-xs">Save</button>
              <button data-deln="${n.id}" class="text-xs text-red-700 hover:underline">Delete</button>
            </div>
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
    const save = e.target.closest('[data-savenews]');
    if (save) {
      const row = save.closest('[data-news]');
      const title = row.querySelector('[data-nf-text="title"]').value.trim();
      if (!title) return toast('A headline is required.', false);
      const { error } = await sb.from('announcements').update({
        title, body: row.querySelector('[data-nf-text="body"]').value
      }).eq('id', save.dataset.savenews);
      toast(error ? 'Could not save.' : 'Saved.', !error);
      return;
    }
    const b = e.target.closest('[data-deln]'); if (!b) return;
    if (!confirm('Delete this announcement?')) return;
    await sb.from('announcements').delete().eq('id', b.dataset.deln);
    newsView();
  });
}
