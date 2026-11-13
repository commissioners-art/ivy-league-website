/* ---------------------------------------------------------------
   team.js — the team portal (team.html).

   Sign-in: the device gets an anonymous Supabase session (kept under
   its own storage key, so it never clashes with a staff login in the
   league office), then portal_claim() links it to the player whose
   registration matches the email + phone typed in. After that the
   device stays signed in. See supabase/team-portal.sql.

   Tabs: Chat (live, Supabase realtime), Schedule, Roster (+ add an
   AP), My profile. Captains can pin and delete messages.
--------------------------------------------------------------- */
(function () {
  const CFG = window.IVY_CONFIG;
  const TZ = CFG.TIMEZONE || 'America/Toronto';
  const tb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'ivy-team-auth', persistSession: true, autoRefreshToken: true }
  });
  window.tb = tb;

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => new Date(iso).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
  const time = iso => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  const dayKey = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
  const errText = (e, fallback) => (e && e.message && !/fetch|network|JWT|permission/i.test(e.message)) ? e.message : fallback;
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  function toast(text, ok = true) {
    const t = document.createElement('div');
    t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded text-sm text-white shadow-lg';
    t.style.background = ok ? 'var(--ivy)' : '#B3261E';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  let mine = [];          // [{player_id, team_id, team_name, captain, chat_muted, ...}]
  let cur = null;         // the membership being shown
  let msgs = [];
  let channel = null;
  let tab = 'chat';

  /* ================= sign in ================= */
  async function start() {
    const { data } = await tb.auth.getSession();
    if (data.session) {
      const ok = await loadMe();
      if (ok) return openPortal();
    }
    showSignin();
  }

  function showSignin() {
    show('tp-loading', false); show('tp-portal', false); show('tp-signin', true);
  }

  async function loadMe() {
    const { data, error } = await tb.rpc('portal_me');
    if (error) { console.warn('portal_me', error.message); return false; }
    mine = data || [];
    return mine.length > 0;
  }

  $('tp-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('tp-msg'); msg.classList.add('hidden');
    const btn = $('tp-go'); btn.disabled = true; btn.textContent = 'Checking…';
    const fail = text => { msg.textContent = text; msg.classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Open my team'; };
    try {
      let { data } = await tb.auth.getSession();
      if (!data.session) {
        const r = await tb.auth.signInAnonymously();
        if (r.error) return fail('Sign-in isn’t switched on yet. Let the league office know.');
      }
      const { data: res, error } = await tb.rpc('portal_claim', {
        p_email: $('tp-email').value, p_phone: $('tp-phone').value, p_device: navigator.userAgent.slice(0, 200)
      });
      if (error) return fail(errText(error, 'Something went wrong. Try again in a moment.'));
      if (res && res.error) return fail(res.error);
      if (!(await loadMe())) return fail('You’re signed in, but you’re not on a team yet. The league office adds you once your registration is approved.');
      openPortal();
    } catch (err) {
      fail('Couldn’t reach the league. Check your connection and try again.');
    }
  });

  async function signOut() {
    if (!confirm('Sign out of the team portal on this device?')) return;
    const { data } = await tb.auth.getSession();
    if (data.session) await tb.from('player_logins').delete().eq('auth_id', data.session.user.id);
    await tb.auth.signOut();
    location.reload();
  }
  $('tp-out').addEventListener('click', signOut);

  /* ================= portal ================= */
  function openPortal() {
    show('tp-loading', false); show('tp-signin', false); show('tp-portal', true);
    const saved = (() => { try { return localStorage.getItem('ivy.team.cur'); } catch (e) { return null; } })();
    cur = mine.find(m => m.team_id === saved) || mine[0];
    const sw = $('tp-switch');
    sw.classList.toggle('hidden', mine.length < 2);
    sw.innerHTML = mine.map(m => `<option value="${m.team_id}">${esc(m.team_name)}</option>`).join('');
    sw.onchange = () => { cur = mine.find(m => m.team_id === sw.value); try { localStorage.setItem('ivy.team.cur', cur.team_id); } catch (e) {} loadTeam(); };
    tb.rpc('portal_touch');
    loadTeam();
  }

  async function loadTeam() {
    $('tp-switch').value = cur.team_id;
    document.documentElement.style.setProperty('--team', cur.colour || 'var(--ivy)');
    $('tp-logo').src = cur.logo_url || 'assets/img/logo.png';
    $('tp-team').textContent = cur.team_name;
    $('tp-div').textContent = `${cur.division} division`;
    $('tp-hi').textContent = `Signed in as ${cur.first_name} ${cur.last_name}${cur.captain ? ' · Captain' : ''}`;
    document.title = `${cur.team_name} — Milton Ivy League`;
    show('tp-muted', cur.chat_muted); show('tp-compose', !cur.chat_muted);
    await Promise.all([loadChat(), loadSchedule(), loadRoster(), loadProfile(), loadNews()]);
  }

  /* tabs */
  $('tp-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('.tp-tab').forEach(t => { t.classList.toggle('on', t === b); t.setAttribute('aria-selected', t === b); });
    document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
    if (tab === 'chat') scrollChat();
  });

  /* ================= chat ================= */
  async function loadChat() {
    if (channel) { tb.removeChannel(channel); channel = null; }
    const { data, error } = await tb.from('team_messages').select('*')
      .eq('team_id', cur.team_id).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(150);
    if (error) { $('tp-msgs').innerHTML = '<p class="text-sm text-gray-500 m-auto">Chat isn’t available right now.</p>'; return; }
    msgs = (data || []).reverse();
    renderChat(); scrollChat();

    const teamId = cur.team_id;
    channel = tb.channel(`team-chat-${teamId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_messages', filter: `team_id=eq.${teamId}` }, p => {
        if (!cur || cur.team_id !== teamId) return;
        const row = p.new && p.new.id ? p.new : null;
        if (p.eventType === 'INSERT' && row && !row.deleted_at) {
          if (!msgs.some(m => m.id === row.id)) msgs.push(row);
          const atBottom = nearBottom(); renderChat(); if (atBottom || row.player_id === cur.player_id) scrollChat();
        } else if (row) {
          msgs = row.deleted_at ? msgs.filter(m => m.id !== row.id) : msgs.map(m => m.id === row.id ? row : m);
          renderChat();
        }
      })
      .subscribe();
  }

  const nearBottom = () => { const el = $('tp-msgs'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const scrollChat = () => { const el = $('tp-msgs'); el.scrollTop = el.scrollHeight; };
  const myIds = () => new Set(mine.map(m => m.player_id));

  function renderChat() {
    const me = myIds();
    const pinned = msgs.filter(m => m.pinned);
    $('tp-pinned').innerHTML = pinned.map(m => `
      <div class="tp-pin"><span class="tag">Pinned</span><p>${esc(m.body)}<span class="block text-xs text-gray-500 mt-1">${esc(m.author_name)} · ${day(m.created_at)}</span></p>
        ${cur.captain ? `<button data-unpin="${m.id}">Unpin</button>` : ''}</div>`).join('');

    if (!msgs.length) {
      $('tp-msgs').innerHTML = `<p class="text-sm text-gray-500 m-auto text-center">No messages yet. Say hi to your team.</p>`;
      return;
    }
    let lastDay = '';
    $('tp-msgs').innerHTML = msgs.map(m => {
      const k = dayKey(m.created_at);
      const sep = k !== lastDay ? `<div class="tp-day">${day(m.created_at)}</div>` : '';
      lastDay = k;
      const isMine = me.has(m.player_id);
      const office = !m.player_id;
      const canDel = isMine || cur.captain;
      return `${sep}<div class="tp-msg ${isMine ? 'mine' : ''} ${office ? 'office' : ''}">
        ${isMine ? '' : `<div class="who">${esc(m.author_name)}</div>`}
        <div class="bubble">${esc(m.body)}</div>
        <div class="meta">${time(m.created_at)}
          ${cur.captain ? `<button data-pin="${m.id}">${m.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
          ${canDel ? `<button class="del" data-del="${m.id}">Delete</button>` : ''}</div>
      </div>`;
    }).join('');
  }

  async function pin(id, on) {
    const { error } = await tb.rpc('portal_pin_message', { p_id: id, p_pinned: on });
    if (error) return toast(errText(error, 'Couldn’t pin that.'), false);
    msgs = msgs.map(m => m.id === id ? { ...m, pinned: on } : m); renderChat();
  }
  $('tp-msgs').addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'), p = e.target.closest('[data-pin]');
    if (d) {
      if (!confirm('Delete this message for everyone?')) return;
      const { error } = await tb.rpc('portal_delete_message', { p_id: d.dataset.del });
      if (error) return toast(errText(error, 'Couldn’t delete that.'), false);
      msgs = msgs.filter(m => m.id !== d.dataset.del); renderChat();
    } else if (p) {
      const m = msgs.find(x => x.id === p.dataset.pin); if (m) pin(m.id, !m.pinned);
    }
  });
  $('tp-pinned').addEventListener('click', e => { const b = e.target.closest('[data-unpin]'); if (b) pin(b.dataset.unpin, false); });

  const box = $('tp-text');
  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 128) + 'px'; });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('tp-compose').requestSubmit(); } });
  $('tp-compose').addEventListener('submit', async e => {
    e.preventDefault();
    const body = box.value.trim(); if (!body) return;
    box.value = ''; box.style.height = 'auto';
    const { data: id, error } = await tb.rpc('portal_post', { p_team_id: cur.team_id, p_body: body });
    if (error) { box.value = body; return toast(errText(error, 'Message didn’t send. Try again.'), false); }
    /* show it right away; the realtime insert is de-duplicated by id */
    if (!msgs.some(m => m.id === id)) {
      msgs.push({ id, team_id: cur.team_id, player_id: cur.player_id, body, pinned: false,
        author_name: `${cur.first_name} ${cur.last_name[0] || ''}.`, created_at: new Date().toISOString() });
      renderChat(); scrollChat();
    }
  });

  async function loadNews() {
    const { data } = await tb.from('announcements').select('title, published_at').eq('published', true)
      .order('published_at', { ascending: false }).limit(1);
    const a = data && data[0];
    const fresh = a && Date.now() - new Date(a.published_at).getTime() < 14 * 864e5;
    $('tp-news').innerHTML = fresh ? `<a href="news.html" class="block text-sm mb-3"><b style="color:var(--ivy)">League news:</b> ${esc(a.title)} →</a>` : '';
  }

  /* ================= schedule ================= */
  async function loadSchedule() {
    const t = cur.team_id;
    const { data: games } = await tb.from('games')
      .select('*, home:home_team_id(name), away:away_team_id(name)')
      .or(`home_team_id.eq.${t},away_team_id.eq.${t}`).order('starts_at');
    const all = games || [];
    const now = Date.now();
    const upcoming = all.filter(g => g.status !== 'final' && new Date(g.starts_at).getTime() > now - 3 * 3600e3);
    const results = all.filter(g => g.status === 'final').reverse();

    const card = g => {
      const home = g.home_team_id === t;
      const opp = home ? g.away?.name : g.home?.name;
      let res = '';
      if (g.status === 'final') {
        const us = home ? g.home_score : g.away_score, them = home ? g.away_score : g.home_score;
        const r = us > them ? 'W' : us < them ? 'L' : 'T';
        res = `<span class="res ${r === 'W' ? 'w' : r === 'L' ? 'l' : ''}">${r} ${us}–${them}${g.decided_in && g.decided_in !== 'regulation' ? ` ${esc(g.decided_in).toUpperCase()}` : ''}</span>`;
      } else if (g.status === 'live') res = `<a href="live.html" class="res w pulse-live">Live</a>`;
      else if (g.status === 'postponed') res = `<span class="res l">Postponed</span>`;
      return `<div class="panel tp-game">
        <div class="when"><b>${day(g.starts_at)}</b>${time(g.starts_at)}</div>
        <div class="vs">${home ? 'vs' : '@'} ${esc(opp || 'TBD')}<span>${esc(g.venue || '')}</span></div>${res}</div>`;
    };
    $('tp-upcoming').innerHTML = upcoming.length ? upcoming.map(card).join('') : '<p class="text-sm text-gray-500">No games scheduled yet.</p>';
    $('tp-results').innerHTML = results.length ? results.map(card).join('') : '<p class="text-sm text-gray-500">No results yet.</p>';

    const next = upcoming[0];
    $('tp-next').innerHTML = next ? `<div class="panel-deep p-5 flex flex-wrap items-center gap-4">
        <span class="text-xs uppercase tracking-[.14em] text-white/60">Next game</span>
        <span class="display text-xl flex-1">${next.home_team_id === t ? 'vs' : '@'} ${esc((next.home_team_id === t ? next.away : next.home)?.name || 'TBD')}</span>
        <span class="text-sm text-white/80">${day(next.starts_at)} · ${time(next.starts_at)} · ${esc(next.venue || '')}</span></div>` : '';
  }

  /* ================= roster ================= */
  async function loadRoster() {
    const { data } = await tb.from('players').select('id, first_name, last_name, jersey_number, position, status, captain')
      .eq('team_id', cur.team_id).in('status', ['active', 'ap']).order('jersey_number', { nullsFirst: false });
    const rows = (data || []).sort((a, b) => (a.status === 'ap') - (b.status === 'ap'));
    $('tp-roster').innerHTML = rows.length ? rows.map(p => `<tr>
      <td class="font-bold" style="color:var(--ivy)">${p.jersey_number ?? '—'}</td>
      <td class="font-semibold">${esc(p.first_name)} ${esc(p.last_name)}${p.captain ? '<span class="tp-tag cap">C</span>' : ''}${p.status === 'ap' ? '<span class="tp-tag ap">AP</span>' : ''}</td>
      <td class="text-gray-600">${esc(p.position)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="text-sm text-gray-500">No one on the roster yet.</td></tr>';
  }

  $('tp-ap').addEventListener('submit', async e => {
    e.preventDefault();
    const n = $('ap-num').value;
    const { data, error } = await tb.rpc('portal_add_ap', {
      p_team_id: cur.team_id, p_first: $('ap-first').value, p_last: $('ap-last').value,
      p_number: n === '' ? null : parseInt(n, 10), p_position: $('ap-pos').value,
      p_phone: $('ap-phone').value || null, p_email: $('ap-email').value || null
    });
    if (error) return toast(errText(error, 'Couldn’t add that AP.'), false);
    toast(data && data.existed ? 'They’re already on the roster.' : 'AP added to the roster.');
    e.target.reset();
    loadRoster();
  });

  /* ================= profile ================= */
  async function loadProfile() {
    const { data, error } = await tb.rpc('portal_profile', { p_player_id: cur.player_id });
    if (error || !data) return;
    $('pf-name').textContent = `${data.first_name} ${data.last_name}`;
    $('pf-num').value = data.jersey_number ?? '';
    $('pf-pos').value = data.position || 'Forward';
    $('pf-email').value = data.email || '';
    $('pf-phone').value = data.phone || '';
  }

  $('tp-prof').addEventListener('submit', async e => {
    e.preventDefault();
    const n = $('pf-num').value;
    const { error } = await tb.rpc('portal_update_profile', {
      p_player_id: cur.player_id, p_number: n === '' ? null : parseInt(n, 10), p_position: $('pf-pos').value,
      p_email: $('pf-email').value, p_phone: $('pf-phone').value
    });
    if (error) return toast(errText(error, 'Couldn’t save your profile.'), false);
    toast('Profile saved.');
    await loadMe(); cur = mine.find(m => m.team_id === cur.team_id) || mine[0];
    loadRoster();
  });

  /* kicked out by the league office (device removed) → back to sign-in */
  tb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') showSignin(); });

  document.addEventListener('ivy:ready', start);
})();
