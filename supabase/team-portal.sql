-- ===============================================================
-- Team portal — paste into the Supabase SQL editor and run once.
-- Safe to run again. Run it after schema.sql and ap.sql.
--
-- ALSO NEEDED (one switch, in the Supabase dashboard):
--   Authentication → Sign In / Providers → "Allow anonymous sign-ins" → on.
--
-- How sign-in works:
--   team.html quietly creates an anonymous Supabase session for the
--   device, then the player types the email and phone number from
--   their registration. portal_claim() checks them against approved
--   registrations and links that device to the player (and their team).
--   No password, no email sent. The device stays signed in.
--   Admins can see every signed-in device and sign any of them out.
--
-- What it adds:
--   players.captain      captains can pin and delete messages
--   players.chat_muted   muted players can read but not post
--   player_logins        which device (auth user) belongs to which player
--   portal_attempts      failed sign-in attempts, for rate limiting
--   team_messages        the team chats (live via Supabase realtime)
--   message_removals     original text of deleted messages (staff only)
--   player_contacts      email/phone for people with no registration
--                        (APs added from the portal) and profile edits.
--                        Staff and the player themselves only, never public.
-- ===============================================================

alter table players add column if not exists captain    boolean not null default false;
alter table players add column if not exists chat_muted boolean not null default false;

-- ---------- devices signed in to the portal ----------------------
create table if not exists player_logins (
  auth_id    uuid not null references auth.users on delete cascade,
  player_id  uuid not null references players  on delete cascade,
  device     text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (auth_id, player_id)
);
create index if not exists player_logins_player_idx on player_logins (player_id);

create table if not exists portal_attempts (
  id      bigserial primary key,
  email   text not null,
  auth_id uuid,
  at      timestamptz not null default now()
);
create index if not exists portal_attempts_email_idx on portal_attempts (email, at);

-- ---------- chat ----------------------------------------------------
create table if not exists team_messages (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams on delete cascade,
  player_id   uuid references players on delete set null,   -- null = league office
  author_name text not null,
  body        text not null default '',
  pinned      boolean not null default false,
  deleted_at  timestamptz,
  deleted_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists team_messages_team_idx on team_messages (team_id, created_at desc);

create table if not exists message_removals (
  message_id    uuid primary key references team_messages on delete cascade,
  original_body text,
  removed_at    timestamptz not null default now()
);

-- ---------- contact details that aren't on a registration -----------
create table if not exists player_contacts (
  player_id  uuid primary key references players on delete cascade,
  email      text,
  phone      text,
  updated_at timestamptz not null default now()
);

-- ---------- helpers -------------------------------------------------
create or replace function my_player_ids() returns setof uuid
language sql security definer stable set search_path = public as $$
  select player_id from player_logins where auth_id = auth.uid();
$$;

create or replace function my_team_ids() returns setof uuid
language sql security definer stable set search_path = public as $$
  select distinct p.team_id from player_logins l join players p on p.id = l.player_id
   where l.auth_id = auth.uid() and p.team_id is not null;
$$;

create or replace function digits10(t text) returns text
language sql immutable as $$
  select right(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 10);
$$;

-- ---------- sign in ------------------------------------------------
create or replace function portal_claim(p_email text, p_phone text, p_device text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := digits10(p_phone);
  v_fails int;
  v_ids   uuid[];
begin
  if auth.uid() is null then raise exception 'Sign-in is not ready yet. Refresh the page and try again.'; end if;
  if v_email = '' or length(v_phone) < 7 then raise exception 'Enter the email and phone number you registered with.'; end if;

  select count(*) into v_fails from portal_attempts
   where (email = v_email or auth_id = auth.uid()) and at > now() - interval '15 minutes';
  if v_fails >= 8 then raise exception 'Too many tries. Wait 15 minutes and try again, or ask the league office.'; end if;

  select array_agg(distinct id) into v_ids from (
    select r.player_id as id
      from registrations r join players p on p.id = r.player_id
     where lower(btrim(r.email)) = v_email and digits10(r.phone) = v_phone
       and r.status = 'approved' and p.team_id is not null and p.status <> 'inactive'
    union
    select c.player_id
      from player_contacts c join players p on p.id = c.player_id
     where lower(btrim(c.email)) = v_email and digits10(c.phone) = v_phone
       and p.team_id is not null and p.status <> 'inactive'
  ) m;

  if v_ids is null then
    -- return (not raise) so the failed attempt is kept for rate limiting
    insert into portal_attempts (email, auth_id) values (v_email, auth.uid());
    return json_build_object('error', 'We couldn''t find you with that email and phone number. Use the ones you registered with, or ask the league office.');
  end if;

  insert into player_logins (auth_id, player_id, device)
  select auth.uid(), unnest(v_ids), left(p_device, 200)
  on conflict (auth_id, player_id) do update set last_seen = now();

  delete from portal_attempts where email = v_email;
  return json_build_object('players', v_ids);
end $$;

-- Who am I? Players this device is signed in as, with their team.
create or replace function portal_me() returns json
language sql security definer stable set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'player_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
           'jersey_number', p.jersey_number, 'captain', p.captain, 'chat_muted', p.chat_muted,
           'team_id', t.id, 'team_name', t.name, 'division', t.division,
           'colour', t.colour, 'logo_url', t.logo_url) order by t.name), '[]'::json)
    from player_logins l join players p on p.id = l.player_id join teams t on t.id = p.team_id
   where l.auth_id = auth.uid();
$$;

-- My profile, including contact details (only ever returned to the player themselves).
create or replace function portal_profile(p_player_id uuid) returns json
language plpgsql security definer stable set search_path = public as $$
declare r json;
begin
  if p_player_id not in (select my_player_ids()) then raise exception 'That isn''t your profile.'; end if;
  select json_build_object(
    'player_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
    'jersey_number', p.jersey_number, 'position', p.position, 'status', p.status, 'captain', p.captain,
    'email', coalesce(c.email, g.email), 'phone', coalesce(c.phone, g.phone))
    into r
    from players p
    left join player_contacts c on c.player_id = p.id
    left join lateral (select email, phone from registrations where player_id = p.id
                        order by created_at desc limit 1) g on true
   where p.id = p_player_id;
  return r;
end $$;

create or replace function portal_update_profile(
  p_player_id uuid, p_number int, p_position text, p_email text, p_phone text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pos   text := case when p_position in ('Forward','Defence','Goalie') then p_position else 'Forward' end;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if p_player_id not in (select my_player_ids()) then raise exception 'That isn''t your profile.'; end if;
  if p_number is not null and (p_number < 0 or p_number > 99) then raise exception 'Number must be 0 to 99.'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email. You sign in with it.'; end if;
  if length(digits10(v_phone)) < 10 then raise exception 'Enter a 10-digit phone number. You sign in with it.'; end if;

  update players set jersey_number = p_number, position = v_pos where id = p_player_id;
  -- keep the registration in step so the roster trigger never undoes the change
  update registrations set jersey_number = p_number, position = v_pos where player_id = p_player_id;
  insert into player_contacts (player_id, email, phone) values (p_player_id, v_email, v_phone)
  on conflict (player_id) do update set email = excluded.email, phone = excluded.phone, updated_at = now();
end $$;

-- Add an AP to your own team from the portal. Same rules as the rink QR
-- check-in (ap_checkin), plus optional contact details so they show up
-- in the league office and can sign in to the portal themselves.
create or replace function portal_add_ap(
  p_team_id uuid, p_first text, p_last text, p_number int, p_position text,
  p_phone text default null, p_email text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare r json;
begin
  if p_team_id not in (select my_team_ids()) then raise exception 'You can only add APs to your own team.'; end if;
  r := ap_checkin(p_first, p_last, p_team_id, p_number, p_position);
  if nullif(btrim(coalesce(p_phone, '')), '') is not null or nullif(btrim(coalesce(p_email, '')), '') is not null then
    -- never overwrite someone's existing details
    insert into player_contacts (player_id, email, phone)
    values ((r->>'id')::uuid, nullif(lower(btrim(coalesce(p_email, ''))), ''), nullif(btrim(coalesce(p_phone, '')), ''))
    on conflict (player_id) do nothing;
  end if;
  return r;
end $$;

create or replace function portal_touch() returns void
language sql security definer set search_path = public as $$
  update player_logins set last_seen = now() where auth_id = auth.uid();
$$;

-- ---------- chat actions -------------------------------------------
create or replace function portal_post(p_team_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_p    players%rowtype;
  v_id   uuid;
  v_recent int;
begin
  if length(v_body) = 0 then raise exception 'Type a message first.'; end if;
  if length(v_body) > 2000 then raise exception 'That message is too long.'; end if;

  if is_staff() and not exists (select 1 from my_team_ids() t where t = p_team_id) then
    insert into team_messages (team_id, player_id, author_name, body)
    values (p_team_id, null, 'League office', v_body) returning id into v_id;
    return v_id;
  end if;

  select p.* into v_p from players p join player_logins l on l.player_id = p.id
   where l.auth_id = auth.uid() and p.team_id = p_team_id limit 1;
  if not found then raise exception 'You''re not signed in to that team.'; end if;
  if v_p.chat_muted then raise exception 'The league office has paused your posting in team chat.'; end if;

  select count(*) into v_recent from team_messages
   where player_id = v_p.id and created_at > now() - interval '1 minute';
  if v_recent >= 15 then raise exception 'Slow down a little. Try again in a minute.'; end if;

  insert into team_messages (team_id, player_id, author_name, body)
  values (p_team_id, v_p.id, v_p.first_name || ' ' || left(v_p.last_name, 1) || '.', v_body)
  returning id into v_id;
  return v_id;
end $$;

-- Who may moderate this message: staff, the team's captains, or (for delete) the author.
create or replace function portal_can_moderate(p_team_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select is_staff() or exists (
    select 1 from player_logins l join players p on p.id = l.player_id
     where l.auth_id = auth.uid() and p.team_id = p_team_id and p.captain);
$$;

create or replace function portal_delete_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m team_messages%rowtype; v_who text;
begin
  select * into m from team_messages where id = p_id;
  if not found or m.deleted_at is not null then return; end if;
  if portal_can_moderate(m.team_id) then
    v_who := case when is_staff() then 'league office' else 'captain' end;
  elsif m.player_id in (select my_player_ids()) then
    v_who := 'author';
  else
    raise exception 'You can''t delete that message.';
  end if;
  insert into message_removals (message_id, original_body) values (m.id, m.body)
  on conflict (message_id) do nothing;
  update team_messages set body = '', pinned = false, deleted_at = now(), deleted_by = v_who where id = m.id;
end $$;

create or replace function portal_pin_message(p_id uuid, p_pinned boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m team_messages%rowtype;
begin
  select * into m from team_messages where id = p_id;
  if not found or m.deleted_at is not null then return; end if;
  if not portal_can_moderate(m.team_id) then raise exception 'Only captains can pin messages.'; end if;
  update team_messages set pinned = coalesce(p_pinned, false) where id = m.id;
end $$;

-- ---------- row level security --------------------------------------
alter table player_logins    enable row level security;
alter table portal_attempts  enable row level security;   -- no policies: functions only
alter table team_messages    enable row level security;
alter table message_removals enable row level security;
alter table player_contacts  enable row level security;

drop policy if exists "staff read contacts" on player_contacts;
create policy "staff read contacts" on player_contacts for select using (is_staff());
drop policy if exists "admin write contacts" on player_contacts;
create policy "admin write contacts" on player_contacts for all using (is_admin()) with check (is_admin());

drop policy if exists "own or staff read" on player_logins;
create policy "own or staff read" on player_logins for select
  using (auth_id = auth.uid() or is_staff());
drop policy if exists "own or admin delete" on player_logins;
create policy "own or admin delete" on player_logins for delete
  using (auth_id = auth.uid() or is_admin());

-- A player only ever sees their own team's chat. Writes go through the functions above.
drop policy if exists "team or staff read" on team_messages;
create policy "team or staff read" on team_messages for select
  using (is_staff() or team_id in (select my_team_ids()));

drop policy if exists "staff read removals" on message_removals;
create policy "staff read removals" on message_removals for select using (is_staff());

-- ---------- grants ----------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'portal_claim(text, text, text)', 'portal_me()', 'portal_touch()',
    'portal_post(uuid, text)', 'portal_delete_message(uuid)', 'portal_pin_message(uuid, boolean)',
    'portal_can_moderate(uuid)', 'portal_profile(uuid)',
    'portal_update_profile(uuid, int, text, text, text)',
    'portal_add_ap(uuid, text, text, int, text, text, text)', 'my_player_ids()', 'my_team_ids()']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------- realtime ----------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table team_messages;
exception when duplicate_object then null;
end $$;
