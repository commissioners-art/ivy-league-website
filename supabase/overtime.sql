-- ===============================================================
-- Overtime & shootouts (NHL rules) — paste into the Supabase SQL
-- editor and run once. Safe to run again.
--
--  - games.decided_in records how a game ended: REG, OT or SO.
--    The game sheet sets it when the scorekeeper finalizes.
--  - Standings: W = any win (2 pts), L = regulation loss (0 pts),
--    OTL = overtime or shootout loss (1 pt). New column otl.
--  - Shootout goals (period 5) don't count toward player stats.
-- ===============================================================
alter table games add column if not exists decided_in text
  check (decided_in in ('REG','OT','SO'));

create or replace view standings as
with results as (
  select home_team_id as team_id, division, home_score as gf, away_score as ga, decided_in from games where status='final'
  union all
  select away_team_id, division, away_score, home_score, decided_in from games where status='final'
)
select t.id as team_id, t.name, t.division, t.logo_url,
       count(r.*)                                                                  as gp,
       count(*) filter (where r.gf > r.ga)                                         as w,
       count(*) filter (where r.gf < r.ga and coalesce(r.decided_in,'REG') = 'REG') as l,
       count(*) filter (where r.gf = r.ga)                                         as t,
       coalesce(sum(r.gf),0)                                                       as gf,
       coalesce(sum(r.ga),0)                                                       as ga,
       count(*) filter (where r.gf > r.ga) * 2
         + count(*) filter (where r.gf = r.ga)
         + count(*) filter (where r.gf < r.ga and r.decided_in in ('OT','SO'))     as pts,
       count(*) filter (where r.gf < r.ga and r.decided_in in ('OT','SO'))         as otl
from teams t left join results r on r.team_id = t.id
group by t.id, t.name, t.division, t.logo_url;

create or replace view player_stats as
select p.id as player_id, p.first_name, p.last_name, p.jersey_number, p.position,
       t.id as team_id, t.name as team_name, t.division,
       count(*) filter (where e.type='goal' and e.period is distinct from 5 and e.player_id = p.id)                                  as goals,
       count(*) filter (where e.type='goal' and e.period is distinct from 5 and (e.assist1_id = p.id or e.assist2_id = p.id))        as assists,
       count(*) filter (where e.type='goal' and e.period is distinct from 5 and e.player_id = p.id)
         + count(*) filter (where e.type='goal' and e.period is distinct from 5 and (e.assist1_id = p.id or e.assist2_id = p.id))    as points,
       coalesce(sum(e.minutes) filter (where e.type='penalty' and e.player_id = p.id),0)                                             as pim
from players p
left join teams t on t.id = p.team_id
left join game_events e on e.player_id = p.id or e.assist1_id = p.id or e.assist2_id = p.id
group by p.id, p.first_name, p.last_name, p.jersey_number, p.position, t.id, t.name, t.division;
