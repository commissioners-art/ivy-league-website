-- ===============================================================
-- APs (call-ups) — paste into the Supabase SQL editor and run once.
-- Safe to run again.
--
-- An AP scans the QR code at the rink (it opens ap.html), types their
-- name, picks the team they're playing for and the number they're
-- wearing. They're added to that team's roster with status 'ap' and
-- show as "AP" on the public roster and the scorekeeper's game sheet.
--
-- The public can't write to the players table directly. They can only
-- call ap_checkin() below, which only ever adds or updates an AP row.
-- Scorekeepers and admins remove anyone who shouldn't be there.
-- ===============================================================

-- 1. Allow 'ap' as a player status.
do $$
declare c text;
begin
  -- Drop whatever check currently limits players.status, whatever it's named.
  for c in select conname from pg_constraint
            where conrelid = 'players'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table players drop constraint %I', c);
  end loop;
end $$;
alter table players add constraint players_status_check
  check (status in ('active','inactive','spare','ap'));

-- 2. The check-in itself.
create or replace function ap_checkin(
  p_first    text,
  p_last     text,
  p_team_id  uuid,
  p_number   int  default null,
  p_position text default 'Forward'
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_first text := initcap(btrim(regexp_replace(coalesce(p_first, ''), '\s+', ' ', 'g')));
  v_last  text := initcap(btrim(regexp_replace(coalesce(p_last,  ''), '\s+', ' ', 'g')));
  v_pos   text := case when p_position in ('Forward','Defence','Goalie') then p_position else 'Forward' end;
  v_team  teams%rowtype;
  v_p     players%rowtype;
  v_aps   int;
begin
  if length(v_first) < 1 or length(v_last) < 1 or length(v_first) > 40 or length(v_last) > 40 then
    raise exception 'Enter your first and last name.';
  end if;
  if p_number is not null and (p_number < 0 or p_number > 99) then
    raise exception 'Jersey number must be 0 to 99.';
  end if;

  select * into v_team from teams where id = p_team_id;
  if not found then raise exception 'Pick a team.'; end if;

  -- Already on this team (as a regular or an AP)? Don't make a duplicate.
  select * into v_p from players
   where team_id = p_team_id and lower(first_name) = lower(v_first) and lower(last_name) = lower(v_last)
   order by (status = 'ap') desc, created_at
   limit 1;

  if found then
    if v_p.status in ('ap','spare','inactive') then
      update players set status = case when v_p.status = 'inactive' then 'ap' else v_p.status end,
                         jersey_number = coalesce(p_number, jersey_number),
                         position = v_pos
       where id = v_p.id returning * into v_p;
    end if;
    return json_build_object('id', v_p.id, 'status', v_p.status, 'existed', true,
                             'team', v_team.name, 'jersey_number', v_p.jersey_number);
  end if;

  -- Simple guard against someone spamming the form.
  select count(*) into v_aps from players
   where team_id = p_team_id and status = 'ap' and created_at > now() - interval '1 hour';
  if v_aps >= 10 then raise exception 'Too many APs added to this team in the last hour. Ask the scorekeeper.'; end if;

  insert into players (team_id, first_name, last_name, jersey_number, position, status)
  values (p_team_id, v_first, v_last, p_number, v_pos, 'ap')
  returning * into v_p;

  return json_build_object('id', v_p.id, 'status', v_p.status, 'existed', false,
                           'team', v_team.name, 'jersey_number', v_p.jersey_number);
end $$;

revoke all on function ap_checkin(text, text, uuid, int, text) from public;
grant execute on function ap_checkin(text, text, uuid, int, text) to anon, authenticated;

-- 3. Scorekeepers (not just admins) can remove an AP from the game sheet.
drop policy if exists "staff delete aps" on players;
create policy "staff delete aps" on players for delete using (is_staff() and status = 'ap');
