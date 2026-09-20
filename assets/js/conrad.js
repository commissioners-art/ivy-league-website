/* ---------------------------------------------------------------
   conrad.js — the league's concierge.
   The widget gathers live context (today's date, upcoming games,
   registration links, current page) and posts it to the `conrad`
   Supabase Edge Function, which talks to Claude with your API key
   kept safely server-side.
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
      <button id="conrad-open" aria-label="Ask Conrad"
        class="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full pl-4 pr-5 py-3 text-white shadow-lg"
        style="background: var(--ivy);">
        <span class="inline-block h-6 w-6 rounded-full" style="background: var(--brass)"></span>
        <span class="text-sm font-semibold">Ask Conrad</span>
      </button>

      <section id="conrad-panel" role="dialog" aria-label="Conrad, league concierge"
        class="hidden fixed bottom-5 right-5 z-50 w-[min(24rem,92vw)] h-[min(34rem,80vh)] bg-white rounded-lg overflow-hidden flex flex-col"
        style="border:1px solid var(--line)">
        <header class="crest-field text-white px-4 py-3 flex items-center justify-between">
          <div>
            <p class="display text-base leading-none">Conrad</p>
            <p class="text-[11px] text-white/70 mt-1">League concierge</p>
          </div>
          <button id="conrad-close" aria-label="Close" class="text-white/80 hover:text-white text-xl leading-none">&times;</button>
        </header>
        <div id="conrad-log" class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3"></div>
        <div id="conrad-chips" class="px-4 pb-2 flex flex-wrap gap-2"></div>
        <form id="conrad-form" class="border-t p-3 flex gap-2" style="border-color: var(--line)">
          <label class="sr-only" for="conrad-input">Message Conrad</label>
          <input id="conrad-input" class="field !py-2" autocomplete="off" placeholder="Ask about schedules, teams, sign-up…">
          <button class="btn btn-primary !py-2 !px-4">Send</button>
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

    bubble('assistant', GREETING);
    chips();
  }

  function chips() {
    const wrap = document.getElementById('conrad-chips');
    wrap.innerHTML = SUGGESTIONS.map(s =>
      `<button class="text-xs px-3 py-1.5 rounded-full btn-quiet" data-q="${s}">${s}</button>`).join('');
    wrap.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { wrap.innerHTML = ''; send(b.dataset.q); });
  }

  function toggle() {
    open = !open;
    document.getElementById('conrad-panel').classList.toggle('hidden', !open);
    document.getElementById('conrad-open').classList.toggle('hidden', open);
    if (open) setTimeout(() => document.getElementById('conrad-input').focus(), 50);
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
    d.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  }

  /* Live facts Conrad is allowed to reason over. */
  async function context() {
    const sb = window.sb;
    const nowISO = new Date().toISOString();
    const out = { now: new Date().toLocaleString('en-CA', { timeZone: window.Ivy.TZ }), page: location.pathname.split('/').pop() || 'index.html' };

    const [games, teams, links, content] = await Promise.all([
      sb.from('games').select('starts_at, venue, division, status, home_score, away_score, period, home:home_team_id(name), away:away_team_id(name)')
        .gte('starts_at', new Date(Date.now() - 6 * 3600e3).toISOString()).order('starts_at').limit(25),
      sb.from('teams').select('name, division'),
      sb.from('payment_links').select('label, description, price_text, url').eq('active', true),
      sb.from('site_content').select('key, value')
    ]);

    out.upcoming_games = (games.data || []).map(g => ({
      when: `${window.Ivy.fmtDate(g.starts_at, { year: 'numeric' })} at ${window.Ivy.fmtTime(g.starts_at)}`,
      matchup: `${g.away?.name ?? 'TBD'} at ${g.home?.name ?? 'TBD'}`,
      division: g.division, venue: g.venue, status: g.status,
      score: g.status === 'final' || g.status === 'live' ? `${g.away_score}-${g.home_score}` : null
    }));
    out.teams = (teams.data || []).map(t => `${t.name} (${t.division})`);
    out.registration_options = links.data || [];
    out.page_copy = Object.fromEntries((content.data || []).map(r => [r.key, r.value]).slice(0, 40));
    out.reference_time_iso = nowISO;
    return out;
  }

  async function send(text) {
    busy = true;
    bubble('user', text);
    document.getElementById('conrad-chips').innerHTML = '';
    const dots = typing();
    history.push({ role: 'user', content: text });

    try {
      const ctx = await context();
      const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/${CFG.CONRAD_FUNCTION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ messages: history.slice(-12), context: ctx })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      dots.remove();
      bubble('assistant', data.reply);
      history.push({ role: 'assistant', content: data.reply });
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
