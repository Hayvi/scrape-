create table if not exists sports (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  key text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, external_id),
  unique(source, key)
);

create table if not exists leagues (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  sport_id bigint not null references sports(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, external_id)
);
create index if not exists leagues_sport_id_idx on leagues(sport_id);

create table if not exists games (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  league_id bigint not null references leagues(id) on delete cascade,
  home_team text not null,
  away_team text not null,
  start_time timestamptz not null,
  live boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, external_id)
);
create index if not exists games_league_id_idx on games(league_id);
create index if not exists games_live_idx on games(live);
create index if not exists games_start_time_idx on games(start_time);

create table if not exists markets (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  game_id bigint not null references games(id) on delete cascade,
  key text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, external_id)
);
create index if not exists markets_game_id_idx on markets(game_id);
create index if not exists markets_key_idx on markets(key);

create table if not exists outcomes (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  market_id bigint not null references markets(id) on delete cascade,
  label text not null,
  price numeric not null,
  handicap numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(market_id, label, handicap)
);
create index if not exists outcomes_market_id_idx on outcomes(market_id);

create table if not exists live_meta (
  id bigserial primary key,
  provider_key text not null,
  provider text not null,
  provider_ls_id text,
  provider_event_id text,
  status_name text,
  clock_time integer,
  start_time timestamptz,
  home_team text,
  away_team text,
  home_score integer,
  away_score integer,
  competition_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_key)
);
create index if not exists live_meta_provider_idx on live_meta(provider);
create index if not exists live_meta_provider_ls_id_idx on live_meta(provider_ls_id);
create index if not exists live_meta_start_time_idx on live_meta(start_time);

create table if not exists scrape_queue (
  id bigserial primary key,
  source text not null,
  task text not null,
  external_id text not null,
  status text not null default 'pending',
  priority integer not null default 0,
  not_before_at timestamptz,
  locked_at timestamptz,
  lock_owner text,
  attempts integer not null default 0,
  last_error text,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, task, external_id)
);

create index if not exists scrape_queue_due_idx on scrape_queue(source, task, status, not_before_at);
create index if not exists scrape_queue_locked_idx on scrape_queue(source, task, locked_at);

create or replace function claim_scrape_tasks(p_source text, p_task text, p_limit integer, p_lock_owner text)
returns setof scrape_queue
language plpgsql
as $$
begin
  return query
  update scrape_queue
  set
    status = 'running',
    locked_at = now(),
    lock_owner = p_lock_owner,
    attempts = attempts + 1,
    updated_at = now()
  where id in (
    select id
    from scrape_queue
    where source = p_source
      and task = p_task
      and (
        (status = 'pending' and (not_before_at is null or not_before_at <= now()))
        or (status = 'running' and locked_at is not null and locked_at < now() - interval '15 minutes')
      )
    order by priority desc, not_before_at asc nulls first, created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
end;
$$;

create or replace function stats_prematch_complete_1x2(p_source text)
returns table(games_with_complete_1x2 bigint)
language sql
stable
as $$
  select count(*)::bigint as games_with_complete_1x2
  from (
    select m.game_id
    from markets m
    join outcomes o on o.market_id = m.id
    join games g on g.id = m.game_id
    where m.source = p_source
      and g.source = p_source
      and g.live = false
      and m.key = '1x2'
    group by m.game_id
    having count(distinct o.label) >= 3
  ) x;
$$;
