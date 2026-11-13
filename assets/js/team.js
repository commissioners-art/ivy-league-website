/* ---------------------------------------------------------------
   team.js — the team portal screens (team.html).

   All database work goes through team-api.js (window.createTeamApi),
   so a future phone app can reuse it with its own screens. This file
   only draws the screens and handles taps.

   The portal is also an installable app (PWA): team.webmanifest +
   sw.js. On a phone it shows a bottom tab bar, and once added to the
   home screen it opens full screen without the website header.

   Tabs: Chat (live), Schedule, Roster (+ add an AP), My profile.
   Captains can pin and delete messages.
--------------------------------------------------------------- */
(function () {
  const CFG = window.IVY_CONFIG;
  const TZ = CFG.TIMEZONE || 'America/Toronto';
  const api = window.createTeamApi({ url: CFG.SUPABASE_URL, anonKey: CFG.SUPABASE_ANON_KEY });
  window.teamApi = api;

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => new Date(iso).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
  const time = iso => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  const dayKey = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  function toast(text, ok = true) {
    const t = document.createElement('div');
    t.className = 'tp-toast';
    t.style.background = ok ? 'var(--ivy)' : '#B3261E';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  let mine = [];          // memberships: [{player_id, team_id, team_name, captain, chat_muted, ...}]
  let cur = null;         // the membership being shown
  let msgs = [];
  let unsubscribe = null;
  let tab = 'chat';

  /* ================= sign in ================= */
  async function start() {
    try {
      if (await api.hasSession()) {
        mine = await api.memberships();
        if (mine.length) return openPortal();
      }
    } catch (e) { console.warn(e.message); }
    showSignin();
  }

  function showSignin() {
    show('tp-loading', false); show('tp-portal', false); show('tp-signin', true);
    document.body.classList.remove('tp-in');
  }

  $('tp-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('tp-msg'); msg.classList.add('hidden');
    const btn = $('tp-go'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      mine = await api.signIn($('tp-email').value, $('tp-phone').value, navigator.userAgent);
      if (!mine.length) throw new Error('You’re signed in, but you’re not on a team yet. The league office adds you once your registration is approved.');
      openPortal();
    } catch (err) {
      msg.textContent = err.message || 'Couldn’t reach the league. Check your connection and try again.';
      msg.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = 'Open my team';
  });

  $('tp-out').addEventListener('click', async () => {
    if (!confirm('Sign out of the team portal on this device?')) return;
    await api.signOut();
    location.reload();
  });
  /* signed out by the league office (device removed) → back to sign-in */
  api.onSignedOut(showSignin);

  /* ================= portal ================= */
  function openPortal() {
    show('tp-loading', false); show('tp-signin', false); show('tp-portal', true);
    document.body.classList.add('tp-in');
    document.body.dataset.tab = tab;
    cur = mine.find(m => m.team_id === store.get('ivy.team.cur')) || mine[0];
    const sw = $('tp-switch');
    sw.classList.toggle('hidden', mine.length < 2);
    sw.innerHTML = mine.map(m => `<option value="${m.team_id}">${esc(m.team_name)}</option>`).join('');
    sw.onchange = () => { cur = mine.find(m => m.team_id === sw.value); store.set('ivy.team.cur', cur.team_id); loadTeam(); };
    api.touch();
    loadTeam();
    installHint();
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
    if (tab === 'chat') { fitChat(); scrollChat(); }
  }

  /* tabs (top tabs on desktop, bottom tab bar on phones: same buttons) */
  function setTab(next) {
    tab = next;
    document.querySelectorAll('[data-tab]').forEach(t => { const on = t.dataset.tab === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
    document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
    document.body.dataset.tab = tab;
    window.scrollTo(0, 0);
    if (tab === 'chat') { fitChat(); scrollChat(); }
  }
  document.querySelectorAll('.tp-tabs').forEach(n => n.addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab);
  }));

  /* ================= chat ================= */
  async function loadChat() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    try { msgs = await api.messages(cur.team_id); }
    catch (e) { $('tp-msgs').innerHTML = `<p class="text-sm text-gray-500 m-auto">${esc(e.message)}</p>`; return; }
    renderChat(); scrollChat();

    const teamId = cur.team_id;
    unsubscribe = api.subscribe(teamId, ({ type, row }) => {
      if (!cur || cur.team_id !== teamId) return;
      if (type === 'insert') {
        if (msgs.some(m => m.id === row.id)) return;
        const atBottom = nearBottom(); msgs.push(row); renderChat();
        if (atBottom || row.player_id === cur.player_id) scrollChat();
      } else if (type === 'delete') { msgs = msgs.filter(m => m.id !== row.id); renderChat(); }
      else { msgs = msgs.map(m => m.id === row.id ? row : m); renderChat(); }
    });
  }

  /* Phones: size the chat box to fill the screen down to the tab bar, so the
     message box always sits just above it (like a messaging app). */
  function fitChat() {
    const box = document.querySelector('.tp-chat'); if (!box) return;
    if (!matchMedia('(max-width: 767px)').matches || tab !== 'chat') { box.style.height = ''; return; }
    const bar = document.querySelector('.tp-bottom').getBoundingClientRect().height || 0;
    const top = box.getBoundingClientRect().top + window.scrollY;
    box.style.height = Math.max(320, window.innerHeight - top - bar - 12) + 'px';
  }
  window.addEventListener('resize', () => { fitChat(); if (tab === 'chat') scrollChat(); });

  const nearBottom = () => { const el = $('tp-msgs'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const scrollChat = () => { const el = $('tp-msgs'); el.scrollTop = el.scrollHeight; };

  function renderChat() {
    const me = new Set(mine.map(m => m.player_id));
    $('tp-pinned').innerHTML = msgs.filter(m => m.pinned).map(m => `
      <div class="tp-pin"><span class="tag">Pinned</span><p>${esc(m.body)}<span class="block text-xs text-gray-500 mt-1">${esc(m.author_name)} · ${day(m.created_at)}</span></p>
        ${cur.captain ? `<button data-unpin="${m.id}">Unpin</button>` : ''}</div>`).join('');
    fitChat();

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
      return `${sep}<div class="tp-msg ${isMine ? 'mine' : ''} ${!m.player_id ? 'office' : ''}">
        ${isMine ? '' : `<div class="who">${esc(m.author_name)}</div>`}
        <div class="bubble">${esc(m.body)}</div>
        <div class="meta">${time(m.created_at)}
          ${cur.captain ? `<button data-pin="${m.id}">${m.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
          ${isMine || cur.captain ? `<button class="del" data-del="${m.id}">Delete</button>` : ''}</div>
      </div>`;
    }).join('');
  }

  async function pin(id, on) {
    try { await api.pin(id, on); } catch (e) { return toast(e.message, false); }
    msgs = msgs.map(m => m.id === id ? { ...m, pinned: on } : m); renderChat();
  }
  $('tp-msgs').addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'), p = e.target.closest('[data-pin]');
    if (d) {
      if (!confirm('Delete this message for everyone?')) return;
      try { await api.remove(d.dataset.del); } catch (err) { return toast(err.message, false); }
      msgs = msgs.filter(m => m.id !== d.dataset.del); renderChat();
    } else if (p) {
      const m = msgs.find(x => x.id === p.dataset.pin); if (m) pin(m.id, !m.pinned);
    }
  });
  $('tp-pinned').addEventListener('click', e => { const b = e.target.closest('[data-unpin]'); if (b) pin(b.dataset.unpin, false); });

  const box = $('tp-text');
  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 128) + 'px'; });
  box.addEventListener('keydown', e => {
    /* Enter sends on a keyboard; on phones the return key adds a line and the Send button sends */
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('tp-compose').requestSubmit(); }
  });
  $('tp-compose').addEventListener('submit', async e => {
    e.preventDefault();
    const body = box.value.trim(); if (!body) return;
    box.value = ''; box.style.height = 'auto';
    let id;
    try { id = await api.post(cur.team_id, body); } catch (err) { box.value = body; return toast(err.message, false); }
    /* show it right away; the live insert is de-duplicated by id */
    if (!msgs.some(m => m.id === id)) {
      msgs.push({ id, team_id: cur.team_id, player_id: cur.player_id, body, pinned: false,
        author_name: `${cur.first_name} ${cur.last_name[0] || ''}.`, created_at: new Date().toISOString() });
      renderChat(); scrollChat();
    }
  });

  async function loadNews() {
    let a = null; try { a = await api.latestNews(); } catch (e) {}
    const fresh = a && Date.now() - new Date(a.published_at).getTime() < 14 * 864e5;
    $('tp-news').innerHTML = fresh ? `<a href="news.html" class="block text-sm mb-3"><b style="color:var(--ivy)">League news:</b> ${esc(a.title)} →</a>` : '';
  }

  /* ================= schedule ================= */
  async function loadSchedule() {
    const t = cur.team_id;
    let all = []; try { all = await api.games(t); } catch (e) {}
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
    $('tp-next').innerHTML = next ? `<div class="panel-deep tp-nextgame">
        <span class="text-xs uppercase tracking-[.14em] text-white/60">Next game</span>
        <span class="display text-xl flex-1">${next.home_team_id === t ? 'vs' : '@'} ${esc((next.home_team_id === t ? next.away : next.home)?.name || 'TBD')}</span>
        <span class="text-sm text-white/80">${day(next.starts_at)} · ${time(next.starts_at)} · ${esc(next.venue || '')}</span></div>` : '';
  }

  /* ================= roster ================= */
  async function loadRoster() {
    let rows = []; try { rows = await api.roster(cur.team_id); } catch (e) {}
    $('tp-roster').innerHTML = rows.length ? rows.map(p => `<tr>
      <td class="font-bold" style="color:var(--ivy)">${p.jersey_number ?? '—'}</td>
      <td class="font-semibold">${esc(p.first_name)} ${esc(p.last_name)}${p.captain ? '<span class="tp-tag cap">C</span>' : ''}${p.status === 'ap' ? '<span class="tp-tag ap">AP</span>' : ''}</td>
      <td class="text-gray-600">${esc(p.position)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="text-sm text-gray-500">No one on the roster yet.</td></tr>';
  }

  $('tp-ap').addEventListener('submit', async e => {
    e.preventDefault();
    const n = $('ap-num').value;
    try {
      const r = await api.addAp(cur.team_id, {
        first: $('ap-first').value, last: $('ap-last').value, number: n === '' ? null : parseInt(n, 10),
        position: $('ap-pos').value, phone: $('ap-phone').value, email: $('ap-email').value
      });
      toast(r && r.existed ? 'They’re already on the roster.' : 'AP added to the roster.');
      e.target.reset();
      loadRoster();
    } catch (err) { toast(err.message, false); }
  });

  /* ================= profile ================= */
  async function loadProfile() {
    let d; try { d = await api.profile(cur.player_id); } catch (e) { return; }
    if (!d) return;
    $('pf-name').textContent = `${d.first_name} ${d.last_name}`;
    $('pf-num').value = d.jersey_number ?? '';
    $('pf-pos').value = d.position || 'Forward';
    $('pf-email').value = d.email || '';
    $('pf-phone').value = d.phone || '';
  }

  $('tp-prof').addEventListener('submit', async e => {
    e.preventDefault();
    const n = $('pf-num').value;
    try {
      await api.saveProfile(cur.player_id, { number: n === '' ? null : parseInt(n, 10), position: $('pf-pos').value,
        email: $('pf-email').value, phone: $('pf-phone').value });
    } catch (err) { return toast(err.message, false); }
    toast('Profile saved.');
    mine = await api.memberships().catch(() => mine);
    cur = mine.find(m => m.team_id === cur.team_id) || mine[0];
    loadRoster();
  });

  /* ================= install as an app ================= */
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; installHint(); });

  function installHint() {
    const el = $('tp-install');
    if (!el || standalone() || store.get('ivy.team.installHidden') || $('tp-portal').classList.contains('hidden')) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!deferredPrompt && !ios) return;
    el.innerHTML = `<span class="flex-1"><b>Get the team app.</b> ${deferredPrompt ? 'Add it to your home screen.' : 'Tap the Share button, then “Add to Home Screen”.'}</span>
      ${deferredPrompt ? '<button data-install class="btn btn-primary !py-1.5 !px-3 !text-xs">Install</button>' : ''}
      <button data-hide class="text-xs font-semibold text-gray-500">Not now</button>`;
    el.classList.remove('hidden');
    fitChat();
    el.onclick = async ev => {
      if (ev.target.closest('[data-install]') && deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; el.classList.add('hidden'); }
      if (ev.target.closest('[data-hide]')) { store.set('ivy.team.installHidden', '1'); el.classList.add('hidden'); fitChat(); }
    };
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (standalone()) document.documentElement.classList.add('tp-app');

  document.addEventListener('ivy:ready', start);
})();
