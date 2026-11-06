-- ===============================================================
-- Suspensions — paste into the Supabase SQL editor and run once.
-- Safe to run again.
--
-- Scorekeepers and admins can add a suspension from the game sheet
-- and lift one. Anyone can read them (they show on the public
-- rosters). Only admins can delete one outright.
-- ===============================================================
create table if not exists suspensions (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players on delete cascade,
  team_id     uuid references teams on delete set null,   -- player's team when suspended
  game_id     uuid references games on delete set null,   -- game it was handed out in
  games       int check (games is null or games > 0),     -- number of games, or
  until_date  date,                                       -- until this date, or neither = until further notice
  reason      text,
  created_at  timestamptz default now(),
  created_by  uuid references auth.users default auth.uid(),
  lifted_at   timestamptz,
  lifted_by   uuid references auth.users
);
create index if not exists suspensions_player_idx on suspensions (player_id);

alter table suspensions enable row level security;

drop policy if exists "public read" on suspensions;
create policy "public read" on suspensions for select using (true);

drop policy if exists "staff insert suspensions" on suspensions;
create policy "staff insert suspensions" on suspensions for insert with check (is_staff());

drop policy if exists "staff update suspensions" on suspensions;
create policy "staff update suspensions" on suspensions for update using (is_staff()) with check (is_staff());

drop policy if exists "admin delete suspensions" on suspensions;
create policy "admin delete suspensions" on suspensions for delete using (is_admin());
