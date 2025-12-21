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
