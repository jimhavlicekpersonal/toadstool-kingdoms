-- Toadstool Kingdoms server schema (PostgreSQL 14+). Times are epoch milliseconds.
-- Safe to run on every start: it creates what is missing and upgrades the
-- protocol-1 tables (PvP only) in place.

create table if not exists players (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  trophies integer not null default 0,
  hall_level integer not null default 1,
  shield_until bigint not null default 0,
  base jsonb,
  created_at bigint not null,
  updated_at bigint not null
);
alter table players add column if not exists grove_id text;
alter table players add column if not exists last_seen_at bigint not null default 0;
drop index if exists players_match_idx;
create index if not exists players_match2_idx on players (hall_level, trophies) where base is not null;
create index if not exists players_rank_idx on players (trophies desc) where base is not null;

create table if not exists tickets (
  id text primary key,
  attacker_id text not null references players(id),
  defender_id text references players(id),
  base jsonb not null,
  defender_trophies integer not null,
  created_at bigint not null,
  used boolean not null default false
);
alter table tickets alter column defender_id drop not null;
alter table tickets add column if not exists kind text not null default 'pvp';
alter table tickets add column if not exists defender_name text not null default '';
alter table tickets add column if not exists expires_at bigint not null default 0;
alter table tickets add column if not exists week integer;
alter table tickets add column if not exists grove_id text;
alter table tickets add column if not exists target integer;
create index if not exists tickets_lock_idx on tickets (defender_id, created_at) where not used;

create table if not exists attacks (
  id text primary key,
  at bigint not null,
  attacker_id text not null references players(id),
  defender_id text not null references players(id),
  record jsonb not null
);
create index if not exists attacks_defender_idx on attacks (defender_id, at);
create index if not exists attacks_attacker_idx on attacks (attacker_id, at);

create table if not exists groves (
  id text primary key,
  name text not null,
  color text not null,
  created_at bigint not null
);

-- One Grove per player: the primary key is the player.
create table if not exists grove_members (
  player_id text primary key references players(id),
  grove_id text not null references groves(id),
  role text not null,
  joined_at bigint not null,
  xp integer not null default 0
);
create index if not exists grove_members_grove_idx on grove_members (grove_id);

create table if not exists grove_chat (
  seq bigserial primary key,
  id text not null unique,
  grove_id text not null references groves(id),
  at bigint not null,
  player_id text,
  name text,
  text text not null,
  kind text not null
);
create index if not exists grove_chat_grove_idx on grove_chat (grove_id, seq);
create index if not exists grove_chat_player_idx on grove_chat (player_id, at);

create table if not exists troop_requests (
  id text primary key,
  grove_id text not null references groves(id),
  player_id text not null references players(id),
  name text not null,
  at bigint not null,
  size integer not null,
  filled integer not null default 0,
  open boolean not null default true
);
create index if not exists troop_requests_grove_idx on troop_requests (grove_id, at) where open;
create index if not exists troop_requests_player_idx on troop_requests (player_id, at);

create table if not exists donations (
  id text primary key,
  request_id text not null references troop_requests(id),
  grove_id text not null,
  from_id text not null,
  from_name text not null,
  to_id text not null,
  troop text not null,
  count integer not null,
  level integer not null,
  at bigint not null,
  delivered boolean not null default false
);
create index if not exists donations_inbox_idx on donations (to_id) where not delivered;

create table if not exists raid_pairings (
  week integer not null,
  grove_id text not null,
  opponent_grove_id text,
  opponent_name text not null,
  bot_seed bigint not null,
  roster jsonb not null,
  our_size integer not null,
  our_hall integer not null,
  created_at bigint not null,
  primary key (week, grove_id)
);

create table if not exists raid_attacks (
  id text primary key,
  week integer not null,
  grove_id text not null,
  attacker_id text not null,
  target integer not null,
  stars integer not null,
  destruction real not null,
  at bigint not null
);
create index if not exists raid_attacks_idx on raid_attacks (week, grove_id);

create table if not exists raid_claims (
  week integer not null,
  player_id text not null,
  grove_id text not null,
  outcome text not null,
  at bigint not null,
  primary key (week, player_id)
);
