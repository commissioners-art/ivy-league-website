/* ---------------------------------------------------------------
   conrad.js — the league's concierge.
   Rule-based: Conrad reads live data straight from Supabase
   (games, teams, standings, payment links, news) and answers
   with keyword rules. No AI service, API key or Edge Function.
--------------------------------------------------------------- */
(function () {
  const CFG = window.IVY_CONFIG;
  let history = [];
  let open = false;
  let busy = false;

  const GREETING =
    "Good day. I'm Conrad, the Ivy League's concierge. I can point you to the schedule, " +
    "walk you through registration, or look up when your team plays next. What can I help you find?";

  const SUGGESTIONS = [
    'When is my next game?',
    'How do I register?',
    'What divisions do you run?'
  ];

  function mount() {
    const el = document.createElement('div');
    el.innerHTML = `
      <button id="conrad-open" aria-label="Ask Conrad" class="conrad-launch">
        <span class="conrad-orb" aria-hidden="true"><i></i><i></i><b></b></span>
        <span class="conrad-launch-label">Ask Conrad</span>
      </button>

      <section id="conrad-panel" role="dialog" aria-label="Conrad, league concierge" class="hidden conrad-hud">
        <span class="hud-corner tl" aria-hidden="true"></span><span class="hud-corner tr" aria-hidden="true"></span>
        <span class="hud-corner bl" aria-hidden="true"></span><span class="hud-corner br" aria-hidden="true"></span>
        <header class="hud-head">
          <span class="conrad-orb sm" aria-hidden="true"><i></i><i></i><b></b></span>
          <div class="flex-1 min-w-0">
            <p class="hud-name">CONRAD</p>
            <p class="hud-status"><span class="hud-dot"></span><span id="conrad-status">Online · League concierge</span></p>
          </div>
          <button id="conrad-close" aria-label="Close" class="hud-close">&times;</button>
        </header>
        <div class="hud-rule" aria-hidden="true"></div>
        <div id="conrad-log" class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3" aria-live="polite"></div>
        <div id="conrad-chips" class="px-4 pb-2 flex flex-wrap gap-2"></div>
        <form id="conrad-form" class="hud-form">
          <label class="sr-only" for="conrad-input">Message Conrad</label>
          <span class="hud-prompt" aria-hidden="true">&gt;</span>
          <input id="conrad-input" class="hud-input" autocomplete="off" placeholder="Ask about schedules, teams, sign-up…">
          <button class="hud-send">Send</button>
        </form>
      </section>`;
    document.body.appendChild(el);

    document.getElementById('conrad-open').onclick = toggle;
    document.getElementById('conrad-close').onclick = toggle;
    document.getElementById('conrad-form').onsubmit = (e) => {
      e.preventDefault();
      const input = document.getElementById('conrad-input');
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = '';
      send(text);
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(); });

    const saved = loadChat();
    if (saved.history.length) {
      history = saved.history;
      history.forEach(m => bubble(m.role, m.content));
      if (saved.open) toggle();
    } else {
      const t = rememberedTeamName();
      const hello = t
        ? `Welcome back. Last time you were following ${t}. Ask me "when do we play next?" or anything else about the league.`
        : GREETING;
      bubble('assistant', hello);
      history.push({ role: 'assistant', content: hello });
      chips(t);
    }
  }

  /* The conversation survives moving between pages (same browser tab). */
  const CHAT_KEY = 'ivy.conrad.chat';
  function loadChat() {
    try { return JSON.parse(sessionStorage.getItem(CHAT_KEY)) || { history: [] }; } catch (e) { return { history: [] }; }
  }
  function saveChat() {
    try { sessionStorage.setItem(CHAT_KEY, JSON.stringify({ history: history.slice(-40), open, convo })); } catch (e) {}
  }
  function rememberedTeamName() {
    try { return localStorage.getItem('ivy.conrad.teamName'); } catch (e) { return null; }
  }

  function chips(team) {
    const wrap = document.getElementById('conrad-chips');
    const list = team ? [`When do the ${team} play next?`, ...SUGGESTIONS.slice(1)] : SUGGESTIONS;
    wrap.innerHTML = list.map(s =>
      `<button class="hud-chip" data-q="${s}">${s}</button>`).join('');
    wrap.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { wrap.innerHTML = ''; send(b.dataset.q); });
  }

  function toggle() {
    open = !open;
    document.getElementById('conrad-panel').classList.toggle('hidden', !open);
    document.getElementById('conrad-open').classList.toggle('hidden', open);
    if (open) setTimeout(() => document.getElementById('conrad-input').focus(), 50);
    saveChat();
  }

  function bubble(role, text) {
    const log = document.getElementById('conrad-log');
    const div = document.createElement('div');
    div.className = `conrad-bubble ${role === 'user' ? 'conrad-user' : 'conrad-bot'}`;
    div.innerHTML = window.Ivy.esc(text)
      .replace(/\n/g, '<br>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="underline font-semibold" href="$2">$1</a>');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function typing() {
    const log = document.getElementById('conrad-log');
    const d = document.createElement('div');
    d.className = 'conrad-bubble conrad-bot conrad-typing';
    d.innerHTML = '<span></span><span></span><span></span><em>Checking the league records</em>';
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    const panel = document.getElementById('conrad-panel');
    const status = document.getElementById('conrad-status');
    panel.classList.add('is-thinking'); status.textContent = 'Working…';
    const remove = d.remove.bind(d);
    d.remove = () => { remove(); panel.classList.remove('is-thinking'); status.textContent = 'Online · League concierge'; };
    return d;
  }

  /* ================================================================
     The brain. Conrad answers from live Supabase data with simple
     keyword rules: no AI service, no API key, nothing to deploy.
     To teach him a new answer, add a rule to RULES below.
  ================================================================ */
  const TEAM_KEY = 'ivy.conrad.team';
  let cache = null, cacheAt = 0;
  let pending = null;            // intent waiting on "which team?"
  let pendingName = false;       // waiting on "what name did you register under?"
  let pendingNameAsked = false;  // ...because they asked to check the roster

  let myTeam = null;
  const remember = (team) => {
    myTeam = team.id;
    try { localStorage.setItem(TEAM_KEY, team.id); localStorage.setItem('ivy.conrad.teamName', team.name); } catch (e) {}
  };
  const forget = () => { myTeam = null; try { localStorage.removeItem(TEAM_KEY); localStorage.removeItem('ivy.conrad.teamName'); } catch (e) {} };

  /* What this conversation is about, so follow-ups like "and the Ale
     division?", "what about after that?" or "how did they do?" work. */
  let convo = loadChat().convo || { topic: null, teamId: null, shown: 0 };
  const recalled = () => { try { return localStorage.getItem(TEAM_KEY) || myTeam; } catch (e) { return myTeam; } };

  async function data() {
    if (cache && Date.now() - cacheAt < 60e3) return cache;
    const sb = window.sb;
    const from = new Date(Date.now() - 21 * 864e5).toISOString();
    const to = new Date(Date.now() + 120 * 864e5).toISOString();
    const [games, teams, links, table, news] = await Promise.all([
      sb.from('games').select('id, starts_at, venue, division, status, home_score, away_score, period, home_team_id, away_team_id')
        .gte('starts_at', from).lte('starts_at', to).order('starts_at'),
      sb.from('teams').select('id, name, division').order('sort'),
      sb.from('payment_links').select('label, description, price_text, url').eq('active', true).order('sort'),
      sb.from('standings').select('team_id, name, division, gp, w, l, t, pts, gf, ga'),
      sb.from('announcements').select('id, title, published_at').eq('published', true).order('published_at', { ascending: false }).limit(3)
    ]);
    // Games and teams are essential; the rest can be missing.
    if (games.error) throw games.error;
    if (teams.error) throw teams.error;
    const byId = Object.fromEntries((teams.data || []).map(t => [t.id, t]));
    cache = {
      teams: teams.data || [],
      byId,
      games: (games.data || []).map(g => ({ ...g, home: byId[g.home_team_id], away: byId[g.away_team_id] })),
      links: links.data || [],
      table: table.data || [],
      news: news.data || []
    };
    cacheAt = Date.now();
    return cache;
  }

  /* ---------- wording helpers ---------- */
  const TZ = () => window.Ivy.TZ;
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ() });   // YYYY-MM-DD
  function when(iso) {
    const days = Math.round((Date.parse(dayKey(iso)) - Date.parse(dayKey(Date.now()))) / 864e5);
    const time = window.Ivy.fmtTime(iso);
    const hour = Number(new Date(iso).toLocaleString('en-CA', { hour: 'numeric', hour12: false, timeZone: TZ() }));
    if (days === 0) return `${hour >= 17 ? 'tonight' : 'today'} at ${time}`;
    if (days === 1) return `tomorrow at ${time}`;
    if (days === -1) return `yesterday`;
    if (days > 1 && days < 7) return `${new Date(iso).toLocaleDateString('en-CA', { weekday: 'long', timeZone: TZ() })} at ${time}`;
    return `${window.Ivy.fmtDate(iso)} at ${time}`;
  }
  const name = (t) => t?.name ?? 'TBD';
  const matchup = (g) => `${name(g.away)} at ${name(g.home)}`;
  const venue = (g) => g.venue ? ` at ${g.venue}` : '';
  const isUpcoming = (g) => g.status === 'scheduled' && Date.parse(g.starts_at) > Date.now() - 2 * 3600e3;
  const involves = (g, t) => g.home_team_id === t.id || g.away_team_id === t.id;
  const list = (rows) => rows.map(r => `• ${r}`).join('\n');

  function finalLine(g, team) {
    if (team) {
      const mine = g.home_team_id === team.id ? g.home_score : g.away_score;
      const theirs = g.home_team_id === team.id ? g.away_score : g.home_score;
      const opp = g.home_team_id === team.id ? g.away : g.home;
      const res = mine > theirs ? 'beat' : mine < theirs ? 'lost to' : 'tied';
      return `${team.name} ${res} ${name(opp)} ${mine}-${theirs} (${window.Ivy.fmtDate(g.starts_at)})`;
    }
    return `${name(g.away)} ${g.away_score}, ${name(g.home)} ${g.home_score} (${window.Ivy.fmtDate(g.starts_at)})`;
  }

  /* Find a team named in the message: full name, or its last word ("Lagers"). */
  function findTeam(text, d) {
    const q = ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    let hit = d.teams.find(t => q.includes(` ${clean(t.name)} `));
    if (hit) return hit;
    hit = d.teams.find(t => {
      const words = clean(t.name).split(/\s+/).filter(w => w.length >= 4 && !['team', 'the'].includes(w));
      return words.some(w => q.includes(` ${w} `) || q.includes(` ${w.replace(/s$/, '')} `));
    });
    return hit || null;
  }

  function findDivision(text, d) {
    const q = text.toLowerCase();
    return [...new Set(d.teams.map(t => t.division))].find(div => div && q.includes(div.toLowerCase())) || null;
  }

  /* ---------- answers ---------- */
  function askTeam(intent, d) {
    pending = intent;
    if (!d.teams.length) return "The teams haven't been set for this season yet. Keep an eye on the [Schedule page](schedule.html).";
    teamChips(d.teams);
    return 'Which team are you on? Tap it below or type the name, and I\'ll remember it for next time.';
  }

  function nextGame(text, d, team) {
    const up = d.games.filter(isUpcoming);
    if (team) {
      const g = up.find(x => involves(x, team));
      if (!g) return `I don't see an upcoming game for ${team.name} yet. The full list is on the [Schedule page](schedule.html).`;
      const opp = g.home_team_id === team.id ? g.away : g.home;
      const later = up.filter(x => involves(x, team) && x !== g).slice(0, 2);
      let out = `${team.name} play ${name(opp)} ${when(g.starts_at)}${venue(g)}.`;
      if (later.length) out += `\n\nAfter that:\n${list(later.map(x => `${when(x.starts_at)}: ${matchup(x)}`))}`;
      return out;
    }
    if (!up.length) return "There are no games on the schedule right now. The [Schedule page](schedule.html) will show new dates as soon as they're posted.";
    const today = up.filter(g => dayKey(g.starts_at) === dayKey(Date.now()));
    const rows = (today.length ? today : up.slice(0, 4)).map(g => `${when(g.starts_at)}: ${matchup(g)}${venue(g)}`);
    return `${today.length ? "Today's games" : 'Next up'}:\n${list(rows)}\n\nTell me your team and I'll find just yours. Full list on the [Schedule page](schedule.html).`;
  }

  function lastResult(text, d, team) {
    let finals = d.games.filter(g => g.status === 'final').reverse();
    if (team) finals = finals.filter(g => involves(g, team));
    if (!finals.length) return `I don't have any final scores${team ? ` for ${team.name}` : ''} from the last few weeks. Try the [Standings](standings.html).`;
    if (team) return `${finalLine(finals[0], team)}.`;
    return `Latest results:\n${list(finals.slice(0, 4).map(g => finalLine(g)))}`;
  }

  function liveNow(text, d) {
    const live = d.games.filter(g => g.status === 'live');
    if (!live.length) {
      const g = d.games.find(isUpcoming);
      return g ? `Nothing is on the ice right now. Next up is ${matchup(g)} ${when(g.starts_at)}${venue(g)}.` : 'Nothing is on the ice right now.';
    }
    return `On the ice now:\n${list(live.map(g => `${name(g.away)} ${g.away_score}, ${name(g.home)} ${g.home_score} (${window.Ivy.ordinal(g.period)})`))}\n\nFollow along on [Live scores](live.html).`;
  }

  function standings(text, d) {
    if (!d.table.length) return 'Standings will appear once the first games are final. See the [Standings page](standings.html).';
    const div = findDivision(text, d);
    const divs = div ? [div] : [...new Set(d.table.map(r => r.division))];
    const out = divs.map(dv => {
      const rows = d.table.filter(r => r.division === dv)
        .sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga)).slice(0, 3);
      if (!rows.length) return `${dv} division: no results yet.`;
      return `${dv} division:\n${list(rows.map((r, i) => `${i + 1}. ${r.name}, ${r.pts} pts (${r.w}-${r.l}-${r.t})`))}`;
    });
    return `${out.join('\n\n')}\n\nFull table on the [Standings page](standings.html).`;
  }

  async function scorers(text, d) {
    const div = findDivision(text, d);
    let q = window.sb.from('player_stats').select('first_name, last_name, team_name, division, goals, assists, points')
      .order('points', { ascending: false }).order('goals', { ascending: false }).limit(5);
    if (div) q = q.eq('division', div);
    const { data: rows, error } = await q;
    if (error || !rows?.length || !rows[0].points) return 'No one has a point on the board yet. Check the [Standings page](standings.html) as games go final.';
    return `Scoring leaders${div ? ` (${div})` : ''}:\n${list(rows.filter(r => r.points).map(r => `${r.first_name} ${r.last_name} (${r.team_name ?? 'no team'}): ${r.goals}G ${r.assists}A, ${r.points} pts`))}`;
  }

  function register(text, d) {
    const intro = 'Pick your division on the [Registration page](register.html), fill in the form, then pay through the secure Stripe link. Your name appears on the roster once payment clears.';
    if (!d.links.length) return intro;
    return `${intro}\n\nCurrent options:\n${list(d.links.map(l => `${l.label}${l.price_text ? `: ${l.price_text}` : ''}`))}`;
  }

  function divisions(text, d) {
    const divs = [...new Set(d.teams.map(t => t.division).filter(Boolean))];
    if (!divs.length) return 'Divisions for this season are still being set. The [Registration page](register.html) has the latest.';
    return `We run ${divs.length === 1 ? 'one division' : `${divs.length} divisions`}:\n${list(divs.map(dv => `${dv}: ${d.teams.filter(t => t.division === dv).map(t => t.name).join(', ')}`))}\n\nRosters are on the [Teams page](teams.html).`;
  }

  function teamsAnswer(text, d, team) {
    if (team) return `${team.name} play in the ${team.division} division. Their roster is on the [Teams page](teams.html). ${nextGame(text, d, team)}`;
    return divisions(text, d);
  }

  function where(text, d) {
    const g = d.games.find(isUpcoming);
    const v = g?.venue || CFG.VENUE;
    return `Games are at ${v}${CFG.VENUE && v !== CFG.VENUE ? '' : ' in Milton'}. Each game's rink is listed on the [Schedule page](schedule.html).`;
  }

  function contact() {
    const email = window.IVY_CONTENT?.['footer.email'] || CFG.CONTACT_EMAIL;
    return `For anything I can't answer (refunds, roster moves, spares) email the commissioners at [${email}](mailto:${email}).`;
  }

  function news(text, d) {
    if (!d.news.length) return 'No league news posted at the moment.';
    return `Latest from the league:\n${list(d.news.map(n => `[${n.title}](news.html?id=${n.id})`))}`;
  }

  /* ---------- small talk ----------
     Short, in-character replies to chit-chat, each with a nudge back
     toward something useful. pick() varies the wording. */
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const GREET_RE = /^\s*(?:(?:dude|bro|man|ok(?:ay)?|so|conrad)[\s,!]+)?(hi+|hey+|hello+|howdy|yo+|sup|wass?up|wh?at'?s? ?(?:up|good|happening|new|poppin'?g?|crackin'?g?)|how'?s it going|hiya|g'?day|good (morning|afternoon|evening|day)|greetings|evening|morning)\b[\s,!.?]*(there|dude|bro|man|buddy|pal|mate|conrad|guys|all|everyone)?\b[\s,!.?]*/i;

  function smallTalk(text) {
    const t = text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
    const teamName = rememberedTeamName();
    const nudge = teamName
      ? pick([`Want to know when ${teamName} play next?`, `Shall I check on ${teamName}?`])
      : pick(['Want to know when your team plays next?', 'Looking for the schedule, standings, or how to sign up?', 'Ask me about games, scores, or registration.']);

    if (/^(how (are|r) (you|u|ya)|how'?s it going|how are things|how you doing|hows your (day|night)|you good|what'?s new)\b/.test(t))
      return pick(['All systems running and the ice is freshly flooded.', 'Very well, thank you. Busy keeping score.', 'Never better. Nobody has asked me to play goal yet.']) + ' ' + nudge;
    if (/\b(who|what) (are|r) (you|u)\b|\byour name\b|\bare you (a )?(bot|robot|ai|real|human)\b/.test(t))
      return "I'm Conrad, the league's concierge. I'm not a person, but I read the league's records live, so I know the schedule, scores, standings and sign-up details. " + nudge;
    if (/\b(joke|funny|make me laugh)\b/.test(t))
      return pick([
        "Why did the beer-league goalie bring a ladder? He heard the drinks were on the top shelf.",
        "I asked the Zamboni driver how work was going. He said it's mostly going in circles.",
        "Our penalty box has the best seats in the house. Unfortunately, they come with a two-minute limit."
      ]) + ' ' + nudge;
    if (/\b(bye|goodbye|see (ya|you)|later|good ?night|gn|cya|peace)\b/.test(t))
      return pick(['Good night. Keep your stick on the ice.', 'Until next time. Mind the boards.', 'Cheers. See you at the rink.']);
    if (/\b(love (you|it|this)|you('?re| are) (the best|great|awesome|cool|smart)|(this|that|it)('?s| is) (great|cool|awesome|sick|amazing|fire)|nice|cool|awesome|sick|dope|great job|good bot)\b/.test(t))
      return pick(['Much obliged.', 'Kind of you to say.', 'I try to keep it tidy.']) + ' ' + nudge;
    if (/\b(stupid|dumb|useless|suck|sucks|hate you|trash|idiot)\b/.test(t))
      return "Fair enough. I only know league business, so I can miss the mark. Try asking about a team, the schedule, standings or registration, and I'll do better.";
    if (/^(dude|bro|man|conrad|yo|hello\?|you there|anyone there)$/.test(t)) return greeting();
    if (/^(ok(ay)?|k|kk|cool|sure|alright|got it|nice|lol|lmao|haha+|ha|wow|hmm+|yeah|yep|nope|no|yes)$/.test(t))
      return pick(['Anything else I can look up?', 'Right then. What else can I find for you?', nudge]);
    if (/\b(weather|cold|hot|snow)\b/.test(t))
      return "Can't speak for outside, but inside the rink it's always a crisp few degrees. " + nudge;
    if (/\b(beer|pint|drinks?|bar)\b/.test(t))
      return "Pucks first, pints after. That's the league motto, more or less. " + nudge;
    return null;
  }

  function greeting(rest) {
    const teamName = rememberedTeamName();
    const hi = pick(['Hey there.', 'Good to see you.', 'All good here, just keeping an eye on the scoreboard.', 'Hello.', 'Not much, just watching the scoreboard.']);
    return `${hi} ${teamName ? `Want to know when ${teamName} play next, or something else?` : 'What can I find for you? Games, scores, standings, or sign-up.'}`;
  }

  const FALLBACKS = [
    "That one's outside my rink, I'm afraid.",
    "I didn't quite catch that.",
    "Hmm, that's not something I keep in the league records.",
    "You've lost me there."
  ];

  /* ---------- "am I registered?" ----------
     Rosters are public on the Teams page, so Conrad can say whether a
     name is on one. Registrations and payments are private (staff-only
     in Supabase), so he never reads or reveals those. */
  const NAME_KEY = 'ivy.conrad.name';
  const savedName = () => { try { return localStorage.getItem(NAME_KEY); } catch (e) { return null; } };
  const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (e) {} };
  const forgetName = () => { try { localStorage.removeItem(NAME_KEY); } catch (e) {} };
  const titleCase = (n) => n.replace(/\b([a-z])/g, c => c.toUpperCase());
  const NOT_NAMES = new Set(('on with not a an the just looking trying new here good fine ok okay registered signed playing in from ' +
    'going so very interested am and is i on there wondering asking checking sure back done ready still also a team player goalie ' +
    'forward defence defense spare your his her their this that what who it me great awesome cool nice sick amazing bad ' +
    'terrible fun crazy weird dumb stupid wrong right correct confused lost tired hungry bored excited happy sad glad').split(' '));

  function cleanName(raw) {
    const words = String(raw || '').toLowerCase().replace(/[^a-z' -]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const w of words) { if (NOT_NAMES.has(w) || out.length === 3) break; out.push(w); }
    return out.length ? titleCase(out.join(' ')) : null;
  }
  function extractName(text) {
    const m = text.match(/\b(?:my name is|my name's|name's|names|i am|i'm|im|this is|call me)\s+([a-z][a-z' -]*)/i);
    if (m) return cleanName(m[1]);
    return null;
  }
  // "is Jane Smith on a roster?" asks about someone, so it isn't saved as the visitor's name.
  function askedAbout(text) {
    const q = text.match(/\bis ([a-z]+ [a-z]+) (?:on|in) (?:a|the|any)? ?(?:roster|team|list)/i);
    return q ? cleanName(q[1]) : null;
  }
  const ROSTER_RE = /\b(am i|are we|is my|did i|did my|have i|is [a-z]+ [a-z]+)\b[^.]*\b(regist\w*|signed up|on (the |a |any )?(roster|team|list)|on there|in yet|confirmed|go(ne)? through|paid up)\b|\bmy (registration|sign ?up|spot)\b|\bam i (on|in|registered|signed)\b/i;

  async function rosterCheck(name, d, someoneElse) {
    const parts = name.split(' ');
    if (parts.length < 2) {
      pendingName = true; pendingNameAsked = true;
      return `Thanks, ${name}. What's your last name too? Rosters list players by full name.`;
    }
    const first = parts[0], last = parts.slice(1).join(' ');
    const { data: rows, error } = await window.sb.from('players')
      .select('first_name, last_name, jersey_number, status, team_id')
      .ilike('first_name', first).ilike('last_name', last);
    if (error) throw error;
    const hits = (rows || []).filter(r => r.status !== 'inactive');
    const email = window.IVY_CONTENT?.['footer.email'] || CFG.CONTACT_EMAIL;
    if (!hits.length) {
      return `I don't see a ${name} on any roster yet. You go on a roster once the league confirms your registration and payment. If you signed up recently it may still be in progress. ` +
        `To check where it stands, email [${email}](mailto:${email}). New registrations open on the [Registration page](register.html).`;
    }
    const lines = hits.map(r => {
      const team = d.byId[r.team_id];
      const num = r.jersey_number != null ? ` wearing #${r.jersey_number}` : '';
      return `${team ? team.name : 'a team'}${r.status === 'spare' ? ' (as a spare)' : r.status === 'ap' ? ' (as an AP)' : ''}${num}`;
    });
    const team = d.byId[hits[0].team_id];
    if (team && !recalled() && !someoneElse) remember(team);
    return `Yes, ${name} is on the roster: ${lines.join(', and ')}. ` +
      (team && !someoneElse ? `Want to know when ${team.name} play next? Just ask "when do we play?"` : 'Rosters are on the [Teams page](teams.html).');
  }

  const HELP = "I can tell you when your team plays next, recent scores, standings, scoring leaders, how to register and what it costs, or where we play. Try \"when do the Lagers play next?\"";

  /* Order matters: the first rule whose pattern matches wins. */
  const RULES = [
    { re: /\b(thanks|thank you|cheers|thx|ty)\b/i, fn: () => 'My pleasure. Anything else?' },
    { re: /\b(regist|sign ?up|join|price|cost|fee|how much|pay|stripe|spot)/i, fn: register },
    { re: /\b(scor(ing|er)s? lead|top scor|leading scor|points lead|most (goals|points)|scorers?|leaders?)\b/i, fn: scorers, async: true },
    { re: /\b(standing|first place|1st place|table|rank|record|leading|on top|best team)/i, fn: standings },
    { re: /\b(live|right now|on the ice|currently)\b/i, fn: liveNow },
    { re: /\b(where|venue|rink|arena|address|location|park)/i, fn: where },
    { re: /\b(last|result|final|won|win|lost|lose|beat|did .* do|score)/i, fn: lastResult, team: true, askTeam: /\b(my|our|we|us|i)\b/i },
    { re: /\b(next|when|play|schedule|game|tonight|today|tomorrow|this week)/i, fn: nextGame, team: true, askTeam: /\b(my|our|we|us|i)\b/i },
    { re: /\b(division|league|level|skill|beginner|competitive)/i, fn: divisions },
    { re: /\b(teams?|roster|line ?up)\b/i, fn: teamsAnswer, team: true },
    { re: /\b(contact|email|refund|commissioner|question|help me|talk to)/i, fn: contact },
    { re: /\b(news|announce|update)/i, fn: news }
  ];

  const FOLLOW_UP = /^(and|what about|how about|same for|ok(ay)? and|now)\b|\b(them|they|their|that team)\b/i;
  const MORE = /\b(after that|the one after|and then|following|more games|any more|rest of)\b/i;
  const TOPICS = { nextGame, lastResult, standings, scorers, teamsAnswer, liveNow };

  function moreGames(text, d, team) {
    const up = d.games.filter(isUpcoming).filter(g => !team || involves(g, team));
    const rows = up.slice(convo.shown, convo.shown + 4);
    if (!rows.length) return `That's everything I have${team ? ` for ${team.name}` : ''} so far. New dates go up on the [Schedule page](schedule.html).`;
    convo.shown += rows.length;
    return `After that${team ? ` for ${team.name}` : ''}:\n${list(rows.map(g => `${when(g.starts_at)}: ${matchup(g)}${venue(g)}`))}`;
  }

  async function answer(text) {
    // Phones type curly apostrophes ("what’s up"); make them plain.
    text = text.replace(/[\u2018\u2019\u201B`´]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
    // Strip leading greetings ("hey, what's up dude,") so a question after them still works.
    let g = text.match(GREET_RE), greeted = false;
    while (g && g[0].trim()) {
      greeted = true;
      text = text.slice(g[0].length).trim();
      g = text.match(GREET_RE);
    }
    if (greeted) {
      const rest = text;
      if (!rest) return greeting();
      const chat = smallTalk(rest);
      if (chat && !RULES.some(r => r.re.test(rest))) return chat;
      text = rest;
    }
    const chat = smallTalk(text);
    if (chat && !RULES.some(r => r.re.test(text))) return chat;

    const d = await data();
    const named = findTeam(text, d);
    const convoTeam = d.byId[convo.teamId] || null;
    const mine = d.byId[recalled()] || null;

    // "I play for the Lagers" / "my team is ..."
    if (named && /\b(i('?m| am)? (on|with|play (for|on))|my team('?s| is)|we('?re| are))\b/i.test(text)) {
      remember(named);
      convo = { topic: 'nextGame', teamId: named.id, shown: 3 };
      return `Noted: you're with ${named.name}. I'll remember that next time too. ${nextGame(text, d, named)}`;
    }
    if (/\bforget (my team|me|that)\b/i.test(text)) {
      forget();
      if (/\bforget (me|that)\b/i.test(text)) forgetName();
      return /\bforget (me|that)\b/i.test(text) ? "Done. I've forgotten your name and team." : "Done. I've forgotten your team.";
    }

    // Names and "am I registered / on a roster?"
    const wantsRoster = ROSTER_RE.test(text);
    let given = extractName(text);
    if (!given && pendingName && !wantsRoster && !named) {
      // Reply to "what name did you register under?": the message is the name.
      // A one-word reply after we already have a first name is the last name.
      const one = cleanName(text);
      const prior = savedName();
      given = one && !one.includes(' ') && prior && !prior.includes(' ') ? `${prior} ${one}` : one;
    }
    if (given) {
      pendingName = false;
      saveName(given);
      if (wantsRoster || pendingNameAsked) { pendingNameAsked = false; return rosterCheck(given, d); }
      return `Nice to meet you, ${given.split(' ')[0]}. I'll remember that. Want me to check whether you're on a roster yet? Just ask "am I registered?"`;
    }
    const other = askedAbout(text);
    if (other && other.includes(' ')) { pendingName = false; return rosterCheck(other, d, true); }
    if (wantsRoster) {
      const n = savedName();
      if (n) return rosterCheck(n, d);
      pendingName = true; pendingNameAsked = true;
      return "What name did you register under? I'll check the rosters. (Payment details are private, so for those the commissioners are the people to ask.)";
    }
    pendingName = false;

    // Reply to "which team are you on?"
    if (pending && named) {
      const fn = pending; pending = null;
      remember(named);
      convo = { topic: fn.name, teamId: named.id, shown: 3 };
      return fn(text, d, named);
    }
    pending = null;

    // "what about after that?"
    if (MORE.test(text) && convo.topic === 'nextGame') return moreGames(text, d, named || convoTeam);

    // "and the Ale division?" / "how did they do?" / "what about the Lagers?"
    const rule = RULES.find(r => r.re.test(text));
    if (convo.topic && TOPICS[convo.topic] && FOLLOW_UP.test(text) && (!rule || rule.team || named || findDivision(text, d))) {
      const fn = rule && rule.team ? rule.fn : TOPICS[convo.topic];
      const team = named || convoTeam;
      convo = { topic: fn.name, teamId: team?.id || null, shown: 3 };
      return fn(text, d, team);
    }

    if (!rule) {
      if (named) { convo = { topic: 'teamsAnswer', teamId: named.id, shown: 3 }; return teamsAnswer(text, d, named); }
      teamChipsOrSuggestions(d);
      return `${pick(FALLBACKS)} ${HELP}`;
    }
    let team = null;
    if (rule.team) {
      const personal = rule.askTeam?.test(text);
      team = named || (personal ? mine : null) || (FOLLOW_UP.test(text) ? convoTeam : null);
      if (!team && personal) return askTeam(rule.fn, d);
    }
    if (rule.fn.name in TOPICS) convo = { topic: rule.fn.name, teamId: team?.id || null, shown: team ? 3 : 4 };
    return rule.fn(text, d, team);
  }

  function teamChipsOrSuggestions() {
    const wrap = document.getElementById('conrad-chips');
    if (!wrap) return;
    const team = rememberedTeamName();
    const list = [team ? `When do the ${team} play next?` : 'When is my next game?', 'Standings', 'How do I register?'];
    wrap.innerHTML = list.map(q => `<button class="hud-chip" data-q="${window.Ivy.esc(q)}">${window.Ivy.esc(q)}</button>`).join('');
    wrap.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { wrap.innerHTML = ''; send(b.dataset.q); });
  }

  function teamChips(teams) {
    const wrap = document.getElementById('conrad-chips');
    wrap.innerHTML = teams.map(t =>
      `<button class="hud-chip" data-q="${window.Ivy.esc(t.name)}">${window.Ivy.esc(t.name)}</button>`).join('');
    wrap.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { wrap.innerHTML = ''; send(b.dataset.q); });
  }

  async function send(text) {
    busy = true;
    bubble('user', text);
    document.getElementById('conrad-chips').innerHTML = '';
    const dots = typing();
    history.push({ role: 'user', content: text });

    try {
      const [reply] = await Promise.all([answer(text), new Promise(r => setTimeout(r, 350))]);
      dots.remove();
      bubble('assistant', reply);
      history.push({ role: 'assistant', content: reply });
      saveChat();
    } catch (err) {
      dots.remove();
      bubble('assistant',
        "I can't reach the league's records just now. The schedule is on the " +
        "[Schedule page](schedule.html) and sign-up is on the [Registration page](register.html). " +
        "Try me again in a moment.");
      console.error(err);
    } finally {
      busy = false;
    }
  }

  document.addEventListener('ivy:ready', mount);
})();
