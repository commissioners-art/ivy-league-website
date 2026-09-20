-- ===============================================================
-- Milton Ivy League — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it.
-- ===============================================================

-- ---------- staff accounts -------------------------------------
create table if not exists staff (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'scorekeeper'   -- 'admin' | 'scorekeeper'
                check (role in ('admin','scorekeeper')),
  created_at  timestamptz default now()
);

create or replace function is_staff() returns boolean
language sql security definer stable as $$
  select exists (select 1 from staff where id = auth.uid());
$$;

create or replace function is_admin() returns boolean
language sql security definer stable as $$
  select exists (select 1 from staff where id = auth.uid() and role = 'admin');
$$;

-- ---------- editable site content (the "GoDaddy-style" layer) ---
create table if not exists site_content (
  key         text primary key,        -- e.g. 'hero.title'
  value       text,
  label       text,                    -- friendly name shown in the admin editor
  kind        text default 'text'      -- 'text' | 'longtext' | 'image' | 'url'
                check (kind in ('text','longtext','image','url')),
  sort        int default 0,
  updated_at  timestamptz default now()
);

-- ---------- stripe payment links --------------------------------
create table if not exists payment_links (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,           -- 'Lager Division — full season'
  description text,
  price_text  text,                    -- '$425 + HST'
  url         text not null,           -- https://buy.stripe.com/...
  active      boolean default true,
  sort        int default 0,
  updated_at  timestamptz default now()
);

-- ---------- teams & players -------------------------------------
create table if not exists teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  division    text not null,           -- 'Lager' | 'Ale' | ...
  logo_url    text,
  colour      text default '#09522B',
  roster_cap  int default 18,
  sort        int default 0,
  created_at  timestamptz default now()
);

create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid references teams on delete set null,
  first_name    text not null,
  last_name     text not null,
  jersey_number int,
  position      text default 'Forward'
                  check (position in ('Forward','Defence','Goalie')),
  status        text default 'active'
                  check (status in ('active','inactive','spare')),
  created_at    timestamptz default now()
);

-- ---------- registrations ---------------------------------------
-- Anyone may submit. Only staff may read. Approving a registration
-- creates the matching player row automatically (trigger below).
create table if not exists registrations (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  first_name      text not null,
  last_name       text not null,
  email           text not null,
  phone           text,
  position        text default 'Forward',
  jersey_number   int,
  division        text,
  team_id         uuid references teams on delete set null,
  shirt_size      text,
  emergency_name  text,
  emergency_phone text,
  waiver_accepted boolean default false,
  notes           text,
  payment_status  text default 'unpaid'
                    check (payment_status in ('unpaid','paid','refunded','comped')),
  status          text default 'new'
                    check (status in ('new','approved','waitlist','declined')),
  player_id       uuid references players on delete set null
);

create or replace function registration_to_roster() returns trigger
language plpgsql security definer as $$
declare new_player uuid;
begin
  if new.status = 'approved' and new.team_id is not null and new.player_id is null then
    insert into players (team_id, first_name, last_name, jersey_number, position)
    values (new.team_id, new.first_name, new.last_name, new.jersey_number, coalesce(new.position,'Forward'))
    returning id into new_player;
    new.player_id := new_player;
  elsif new.player_id is not null then
    update players set team_id = new.team_id, jersey_number = new.jersey_number,
                       position = coalesce(new.position,'Forward')
    where id = new.player_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_registration_to_roster on registrations;
create trigger trg_registration_to_roster
  before update on registrations
  for each row execute function registration_to_roster();

-- ---------- schedule & live game state ---------------------------
create table if not exists seasons (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  is_current boolean default false
);

create table if not exists games (
  id             uuid primary key default gen_random_uuid(),
  season_id      uuid references seasons on delete set null,
  division       text,
  home_team_id   uuid references teams on delete set null,
  away_team_id   uuid references teams on delete set null,
  starts_at      timestamptz not null,
  venue          text default 'Milton Sports Centre',
  status         text default 'scheduled'
                   check (status in ('scheduled','live','final','postponed')),
  home_score     int default 0,
  away_score     int default 0,
  period         int default 1,
  clock_seconds  int default 1200,         -- time remaining in the period
  clock_running  boolean default false,
  clock_updated_at timestamptz default now(),
  notes          text
);
create index if not exists games_starts_at_idx on games (starts_at);

create table if not exists game_events (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid references games on delete cascade,
  team_id     uuid references teams on delete set null,
  type        text not null check (type in ('goal','assist','penalty','save','note')),
  player_id   uuid references players on delete set null,
  assist1_id  uuid references players on delete set null,
  assist2_id  uuid references players on delete set null,
  period      int,
  clock       text,                        -- '12:04'
  minutes     int default 0,               -- penalty minutes
  infraction  text,
  created_at  timestamptz default now(),
  created_by  uuid references auth.users
);
create index if not exists game_events_game_idx on game_events (game_id);

-- ---------- announcements ----------------------------------------
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  image_url   text,
  link_url    text,
  published   boolean default true,
  published_at timestamptz default now()
);

-- ===============================================================
-- Derived views: standings and scoring leaders
-- ===============================================================
create or replace view standings as
with results as (
  select home_team_id as team_id, division, home_score as gf, away_score as ga from games where status='final'
  union all
  select away_team_id, division, away_score, home_score from games where status='final'
)
select t.id as team_id, t.name, t.division, t.logo_url,
       count(r.*)                                   as gp,
       count(*) filter (where r.gf > r.ga)          as w,
       count(*) filter (where r.gf < r.ga)          as l,
       count(*) filter (where r.gf = r.ga)          as t,
       coalesce(sum(r.gf),0)                        as gf,
       coalesce(sum(r.ga),0)                        as ga,
       count(*) filter (where r.gf > r.ga) * 2
         + count(*) filter (where r.gf = r.ga)      as pts
from teams t left join results r on r.team_id = t.id
group by t.id, t.name, t.division, t.logo_url;

create or replace view player_stats as
select p.id as player_id, p.first_name, p.last_name, p.jersey_number, p.position,
       t.id as team_id, t.name as team_name, t.division,
       count(*) filter (where e.type='goal' and e.player_id = p.id)                                  as goals,
       count(*) filter (where e.type='goal' and (e.assist1_id = p.id or e.assist2_id = p.id))        as assists,
       count(*) filter (where e.type='goal' and e.player_id = p.id)
         + count(*) filter (where e.type='goal' and (e.assist1_id = p.id or e.assist2_id = p.id))    as points,
       coalesce(sum(e.minutes) filter (where e.type='penalty' and e.player_id = p.id),0)             as pim
from players p
left join teams t on t.id = p.team_id
left join game_events e on e.player_id = p.id or e.assist1_id = p.id or e.assist2_id = p.id
group by p.id, p.first_name, p.last_name, p.jersey_number, p.position, t.id, t.name, t.division;

-- ===============================================================
-- Row level security
-- ===============================================================
alter table staff          enable row level security;
alter table site_content   enable row level security;
alter table payment_links  enable row level security;
alter table teams          enable row level security;
alter table players        enable row level security;
alter table registrations  enable row level security;
alter table seasons        enable row level security;
alter table games          enable row level security;
alter table game_events    enable row level security;
alter table announcements  enable row level security;

-- Public read for everything that appears on the website
do $$
declare tbl text;
begin
  foreach tbl in array array['site_content','payment_links','teams','players','seasons','games','game_events','announcements']
  loop
    execute format('drop policy if exists "public read" on %I', tbl);
    execute format('create policy "public read" on %I for select using (true)', tbl);
  end loop;
end $$;

-- Staff may see their own record
drop policy if exists "staff self" on staff;
create policy "staff self" on staff for select using (id = auth.uid());

-- Scorekeepers: live game control + event entry
drop policy if exists "staff update games" on games;
create policy "staff update games" on games for update using (is_staff()) with check (is_staff());
drop policy if exists "staff insert events" on game_events;
create policy "staff insert events" on game_events for insert with check (is_staff());
drop policy if exists "staff delete events" on game_events;
create policy "staff delete events" on game_events for delete using (is_staff());

-- Admins: everything else
do $$
declare tbl text;
begin
  foreach tbl in array array['site_content','payment_links','teams','players','seasons','games','announcements']
  loop
    execute format('drop policy if exists "admin write" on %I', tbl);
    execute format('create policy "admin write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;

-- Registrations: public may submit, staff may read and manage
drop policy if exists "public submit" on registrations;
create policy "public submit" on registrations for insert with check (true);
drop policy if exists "staff read regs" on registrations;
create policy "staff read regs" on registrations for select using (is_staff());
drop policy if exists "staff manage regs" on registrations;
create policy "staff manage regs" on registrations for update using (is_staff()) with check (is_staff());
drop policy if exists "admin delete regs" on registrations;
create policy "admin delete regs" on registrations for delete using (is_admin());

-- ---------- realtime ---------------------------------------------
alter publication supabase_realtime add table games;
alter publication supabase_realtime add table game_events;

-- ===============================================================
-- Starter content
-- ===============================================================
insert into site_content (key, value, label, kind, sort) values
  ('hero.kicker',   'Season nine · Milton, Ontario', 'Hero kicker', 'text', 1),
  ('hero.title',    'Beer-league hockey, properly run.', 'Hero headline', 'text', 2),
  ('hero.body',     'Two divisions, real officials, a live scoreboard, and a pint waiting afterwards. Registration for the 2026 season is open.', 'Hero paragraph', 'longtext', 3),
  ('hero.image',    'assets/img/logo.png', 'Hero image', 'image', 4),
  ('about.title',   'Hockey for every level', 'About heading', 'text', 5),
  ('about.body',    'Whether you last played junior or last played in 2009, there is a division here that fits. Balanced teams, a fixed weekly slot, and no one keeping score of how seriously you take it — except Conrad, who keeps score of everything.', 'About paragraph', 'longtext', 6),
  ('register.intro','Pick your division, fill in the form, then pay through the secure Stripe link. You will get a confirmation email and your name appears on the roster once payment clears.', 'Registration intro', 'longtext', 7),
  ('footer.tagline','Where pucks meet pints in Milton.', 'Footer tagline', 'text', 8),
  ('footer.email',  'info@miltonivyleague.ca', 'Contact email', 'text', 9)
on conflict (key) do nothing;

insert into seasons (name, is_current) values ('2026 Season', true)
on conflict do nothing;
