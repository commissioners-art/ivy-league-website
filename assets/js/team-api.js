/* ---------------------------------------------------------------
   team-api.js — everything the team portal does with the database,
   with no page code in it.

   The screens (team.js) only call these functions. A future phone
   app (Capacitor wrapping these pages, or React Native / Expo with
   its own screens) reuses this file as-is: it needs nothing but
   supabase-js and the URL + anon key from config.js. All the rules
   (who sees which chat, who can pin, rate limits) live in the
   database (supabase/team-portal.sql), so no app can bypass them.

   Every function returns plain data or throws an Error whose
   message is safe to show a player.

   createTeamApi({ url, anonKey, storage }) → api
     storage: optional, e.g. AsyncStorage in React Native.
--------------------------------------------------------------- */
(function (root) {
  function createTeamApi({ url, anonKey, storage, createClient }) {
    const make = createClient || (root.supabase && root.supabase.createClient);
    const db = make(url, anonKey, {
      auth: { storageKey: 'ivy-team-auth', persistSession: true, autoRefreshToken: true, ...(storage ? { storage } : {}) }
    });

    const friendly = (e, fallback) =>
      new Error(e && e.message && !/fetch|network|JWT|permission|schema cache/i.test(e.message) ? e.message : fallback);
    const ok = ({ data, error }, fallback) => { if (error) throw friendly(error, fallback); return data; };
    const rpc = async (fn, args, fallback) => ok(await db.rpc(fn, args), fallback);

    const api = {
      db,

      /* ---------- sign in ---------- */
      async hasSession() { const { data } = await db.auth.getSession(); return !!data.session; },

      /* Email + phone from their registration (or added by their team). No password. */
      async signIn(email, phone, device) {
        if (!(await api.hasSession())) {
          const r = await db.auth.signInAnonymously();
          if (r.error) throw new Error('Sign-in isn’t switched on yet. Let the league office know.');
        }
        const res = await rpc('portal_claim', { p_email: email, p_phone: phone, p_device: (device || '').slice(0, 200) },
          'Something went wrong. Try again in a moment.');
        if (res && res.error) throw new Error(res.error);
        return api.memberships();
      },

      async signOut() {
        const { data } = await db.auth.getSession();
        if (data.session) await db.from('player_logins').delete().eq('auth_id', data.session.user.id);
        await db.auth.signOut();
      },

      onSignedOut(cb) { return db.auth.onAuthStateChange(evt => { if (evt === 'SIGNED_OUT') cb(); }); },

      /* The teams this device is signed in to: [{player_id, team_id, team_name, captain, chat_muted, ...}] */
      async memberships() { return (await rpc('portal_me', {}, 'Couldn’t load your team.')) || []; },
      touch() { return db.rpc('portal_touch'); },

      /* ---------- chat ---------- */
      async messages(teamId, limit = 150) {
        const rows = ok(await db.from('team_messages').select('*').eq('team_id', teamId).is('deleted_at', null)
          .order('created_at', { ascending: false }).limit(limit), 'Chat isn’t available right now.');
        return (rows || []).reverse();   // oldest first
      },
      post(teamId, body) { return rpc('portal_post', { p_team_id: teamId, p_body: body }, 'Message didn’t send. Try again.'); },
      remove(messageId) { return rpc('portal_delete_message', { p_id: messageId }, 'Couldn’t delete that.'); },
      pin(messageId, pinned) { return rpc('portal_pin_message', { p_id: messageId, p_pinned: pinned }, 'Couldn’t pin that.'); },

      /* Live updates. onChange({type: 'insert'|'update'|'delete', row}). Returns an unsubscribe function. */
      subscribe(teamId, onChange) {
        const ch = db.channel(`team-chat-${teamId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'team_messages', filter: `team_id=eq.${teamId}` }, p => {
            const row = p.new && p.new.id ? p.new : p.old;
            if (!row) return;
            const type = p.eventType === 'INSERT' ? 'insert' : (p.eventType === 'DELETE' || row.deleted_at) ? 'delete' : 'update';
            onChange({ type, row });
          })
          .subscribe();
        return () => db.removeChannel(ch);
      },

      /* ---------- schedule, roster, news ---------- */
      async games(teamId) {
        return ok(await db.from('games').select('*, home:home_team_id(name), away:away_team_id(name)')
          .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`).order('starts_at'), 'Couldn’t load the schedule.') || [];
      },
      async roster(teamId) {
        const rows = ok(await db.from('players').select('id, first_name, last_name, jersey_number, position, status, captain')
          .eq('team_id', teamId).in('status', ['active', 'ap']).order('jersey_number', { nullsFirst: false }), 'Couldn’t load the roster.') || [];
        return rows.sort((a, b) => (a.status === 'ap') - (b.status === 'ap'));
      },
      async latestNews() {
        const rows = ok(await db.from('announcements').select('title, published_at').eq('published', true)
          .order('published_at', { ascending: false }).limit(1), '') || [];
        return rows[0] || null;
      },
      addAp(teamId, { first, last, number, position, phone, email }) {
        return rpc('portal_add_ap', {
          p_team_id: teamId, p_first: first, p_last: last, p_number: number ?? null,
          p_position: position, p_phone: phone || null, p_email: email || null
        }, 'Couldn’t add that AP.');
      },

      /* ---------- my profile ---------- */
      profile(playerId) { return rpc('portal_profile', { p_player_id: playerId }, 'Couldn’t load your profile.'); },
      saveProfile(playerId, { number, position, email, phone }) {
        return rpc('portal_update_profile', {
          p_player_id: playerId, p_number: number ?? null, p_position: position, p_email: email, p_phone: phone
        }, 'Couldn’t save your profile.');
      }
    };
    return api;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTeamApi };
  else root.createTeamApi = createTeamApi;
})(typeof window !== 'undefined' ? window : globalThis);
