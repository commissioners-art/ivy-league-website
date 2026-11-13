/* ---------------------------------------------------------------
   league.js — shared by the public pages and the staff portal.

   1. IvyGameTime: estimated period and time left in a game, worked
      out from its scheduled start. Nobody runs a clock: a game is
      GAME_MINUTES long (default 60) split into PERIODS equal periods
      (default 3), so 7:20 into a 7:00 game is "1st, ~00:40 left".
      Tied after regulation: OT_MINUTES (default 5) of OT, then a shootout.

   2. IvySusp: which suspensions are still active.

   A suspension is one of:
     - a number of games: counts down by itself. Every game the
       player's team finalizes after the game it was issued in
       counts as one game served.
     - until a date: active up to and including that date.
     - until further notice: active until staff lift it.
   Lifting one (lifted_at set) ends it straight away.
--------------------------------------------------------------- */
(function () {
  const TZ = (window.IVY_CONFIG && window.IVY_CONFIG.TIMEZONE) || 'America/Toronto';
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });   // YYYY-MM-DD
  const fmtDay = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

  function describe(s, finals) {
    const team = s.team_id || s.player?.team_id;
    const from = new Date(s.game?.starts_at || s.created_at).getTime();
    const served = (finals || []).filter(g =>
      (g.home_team_id === team || g.away_team_id === team) && new Date(g.starts_at).getTime() > from).length;

    if (s.games) {
      const left = s.games - served;
      return left > 0 ? { ...s, served, games_left: left, label: `${left} game${left === 1 ? '' : 's'} left` } : null;
    }
    if (s.until_date) {
      return today() <= s.until_date ? { ...s, served, label: `until ${fmtDay(s.until_date)}` } : null;
    }
    return { ...s, served, label: 'until further notice' };
  }

  /* Active suspensions, newest first. Returns [] if the table is not set up yet. */
  async function loadActive(sb) {
    const [{ data: susp, error }, { data: finals }] = await Promise.all([
      sb.from('suspensions')
        .select('*, game:game_id(starts_at), player:player_id(team_id)')
        .is('lifted_at', null)
        .order('created_at', { ascending: false }),
      sb.from('games').select('starts_at, home_team_id, away_team_id').eq('status', 'final')
    ]);
    if (error) return [];
    return (susp || []).map(s => describe(s, finals)).filter(Boolean);
  }

  /* player_id -> active suspension (the newest one if there are several) */
  const byPlayer = list => {
    const m = new Map();
    list.forEach(s => { if (!m.has(s.player_id)) m.set(s.player_id, s); });
    return m;
  };

  window.IvySusp = { loadActive, byPlayer };

  /* ---------- estimated game time ---------- */
  const CFG = window.IVY_CONFIG || {};
  const PERIODS = CFG.PERIODS || 3;
  const PERIOD_SECS = ((CFG.GAME_MINUTES || 60) / PERIODS) * 60;
  const mmss = secs => {
    const s = Math.max(0, Math.round(secs));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const REG_SECS = PERIODS * PERIOD_SECS;
  const OT_SECS = (CFG.OT_MINUTES ?? 5) * 60;
  const OT = PERIODS + 1, SO = PERIODS + 2;

  /* { phase: 'pre' | 'play' | 'over', period, left (seconds, or null if unknown), clock ('MM:SS') }
     recordedPeriod: the highest period the scorekeeper has entered (games.period).
     tied: whether the score is level (true/false), or null if unknown.
     NHL rules: tied after regulation -> OT_MINUTES of sudden death -> shootout. */
  function estimate(startsAt, recordedPeriod = 1, now = Date.now(), tied = null) {
    const elapsed = (now - new Date(startsAt).getTime()) / 1000;
    recordedPeriod = recordedPeriod || 1;
    if (recordedPeriod >= SO) return { phase: 'play', period: SO, left: null, clock: '' };
    if (elapsed < 0) return { phase: 'pre', period: 1, left: PERIOD_SECS, clock: mmss(PERIOD_SECS) };

    if (elapsed < REG_SECS) {
      const period = Math.floor(elapsed / PERIOD_SECS) + 1;
      const left = PERIOD_SECS - (elapsed % PERIOD_SECS);
      // Scorekeeper is already ahead of the estimate (late start): trust them, drop the time.
      if (recordedPeriod > period) return { phase: 'play', period: recordedPeriod, left: null, clock: '' };
      return { phase: 'play', period, left, clock: mmss(left) };
    }

    // Past regulation. An OT goal ends it (sudden death), so a lead means it's over.
    if (recordedPeriod === OT && tied === false) return { phase: 'over', period: OT, left: 0, clock: '00:00' };
    const inOT = tied === true || recordedPeriod === OT;
    if (!inOT) return { phase: 'over', period: PERIODS, left: 0, clock: '00:00' };
    if (elapsed < REG_SECS + OT_SECS) {
      const left = REG_SECS + OT_SECS - elapsed;
      return { phase: 'play', period: OT, left, clock: mmss(left) };
    }
    return { phase: 'play', period: SO, left: null, clock: '' };
  }

  const isTied = g => (g.home_score != null && g.away_score != null) ? g.home_score === g.away_score : null;

  /* Short public label, e.g. "2nd · ~12:40 left", "OT · ~03:10 left", "Shootout" */
  function label(game, ordinal) {
    const e = estimate(game.starts_at, game.period, Date.now(), isTied(game));
    if (e.phase === 'pre') return 'Puck drop soon';
    if (e.period === SO) return 'Shootout';
    if (e.phase === 'over') return e.period === OT ? 'OT · winner scored' : `${ordinal(e.period)} · final minutes`;
    if (e.left == null) return ordinal(e.period);
    return `${ordinal(e.period)} · ~${e.clock} left`;
  }

  /* "Final", "Final (OT)" or "Final (SO)" */
  const finalLabel = g => g.decided_in === 'OT' ? 'Final (OT)' : g.decided_in === 'SO' ? 'Final (SO)' : 'Final';

  window.IvyGameTime = { estimate, label, finalLabel, isTied, PERIODS, OT, SO };
})();
