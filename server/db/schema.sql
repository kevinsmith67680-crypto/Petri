-- ---------------------------------------------------------------------------
-- Petri schema for Supabase / Postgres.
--
-- Paste this into the Supabase SQL Editor and run it once.
--
-- WHY A DEDICATED SCHEMA, NOT public:
-- Supabase exposes every table in the `public` schema through PostgREST, which
-- means anyone holding your anon key can query them over HTTP. Password hashes
-- and balances must never be reachable that way. Tables here live in `petri`,
-- which PostgREST does not expose unless you explicitly add it to the exposed
-- schemas list. Do not add it. RLS is enabled with no policies as a second
-- layer, so even if the schema were exposed, no anon request could read a row.
--
-- The game server connects as the `postgres` role, which bypasses RLS. That is
-- correct here: the server IS the trusted party, exactly as it is for movement
-- and for the ledger.
--
-- To see these tables in the Supabase Studio table editor, switch the schema
-- dropdown from `public` to `petri`.
-- ---------------------------------------------------------------------------

create schema if not exists petri;

-- ── accounts ────────────────────────────────────────────────────────────────

create table if not exists petri.accounts (
  id                uuid primary key default gen_random_uuid(),
  username          text not null,
  display_name      text not null,
  -- Generated column so uniqueness is enforced case-insensitively by the
  -- database rather than by an application-level scan that can race.
  display_name_key  text generated always as (lower(display_name)) stored,
  -- Null for accounts that sign in with Google. The check constraint below
  -- guarantees every account still has one credential or the other.
  password          text,
  -- Google's stable per-user subject claim. Never the email address: emails
  -- change ownership, and keying accounts to one invites takeover.
  google_sub        text,
  created_at        timestamptz not null default now(),
  created_ip        text,
  name_changed_at   timestamptz
);

create unique index if not exists accounts_username_key
  on petri.accounts (lower(username));
create unique index if not exists accounts_display_name_key
  on petri.accounts (display_name_key);
create unique index if not exists accounts_google_sub_key
  on petri.accounts (google_sub) where google_sub is not null;

alter table petri.accounts drop constraint if exists accounts_has_credential;
alter table petri.accounts
  add constraint accounts_has_credential
  check (password is not null or google_sub is not null);

-- ── sessions ────────────────────────────────────────────────────────────────
-- id is the SHA-256 of the token. The raw token is never stored, so a dump of
-- this table does not hand over live sessions.

create table if not exists petri.sessions (
  id          text primary key,
  account_id  uuid not null references petri.accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists sessions_expires_at on petri.sessions (expires_at);
create index if not exists sessions_account_id on petri.sessions (account_id);

-- ── money ───────────────────────────────────────────────────────────────────
-- Amounts are bigint counts of micro-USDC (1 USDC = 1,000,000). Never numeric,
-- never float. The check constraints make "no account may go negative" a
-- guarantee of the database rather than a property of the application code.

create table if not exists petri.balances (
  account_id  uuid primary key references petri.accounts(id) on delete cascade,
  balance     bigint not null default 0 check (balance >= 0),
  escrow      bigint not null default 0 check (escrow >= 0),
  updated_at  timestamptz not null default now()
);

-- House holdings: rake and forfeits. Single row, id = 0.
create table if not exists petri.house (
  id       int primary key default 0 check (id = 0),
  balance  bigint not null default 0 check (balance >= 0)
);
insert into petri.house (id, balance) values (0, 0) on conflict do nothing;

-- Append-only audit. Nothing updates or deletes from this table.
create table if not exists petri.ledger_entries (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  kind          text not null,
  account_id    uuid references petri.accounts(id) on delete set null,
  counterparty  uuid references petri.accounts(id) on delete set null,
  units         bigint not null,
  meta          jsonb
);

create index if not exists ledger_account_at
  on petri.ledger_entries (account_id, at desc);

-- ── settlement functions ────────────────────────────────────────────────────
--
-- Each of these moves money AND writes its audit row in a single statement, so
-- they are atomic without the application managing a transaction. This is the
-- whole reason for using a real database: a crash between "credit the winner"
-- and "debit the loser" is not a state this system can reach.

create or replace function petri.ensure_balance(p_account uuid)
returns void language sql as $$
  insert into petri.balances (account_id) values (p_account)
  on conflict (account_id) do nothing;
$$;

create or replace function petri.deposit(p_account uuid, p_units bigint, p_ref text)
returns table (balance bigint, escrow bigint) language plpgsql as $$
begin
  if p_units <= 0 then raise exception 'deposit must be positive'; end if;
  perform petri.ensure_balance(p_account);
  update petri.balances b
     set balance = b.balance + p_units, updated_at = now()
   where b.account_id = p_account;
  insert into petri.ledger_entries (kind, account_id, units, meta)
    values ('deposit', p_account, p_units, jsonb_build_object('ref', p_ref));
  return query select b.balance, b.escrow from petri.balances b where b.account_id = p_account;
end $$;

create or replace function petri.lock_stake(p_account uuid, p_units bigint)
returns table (balance bigint, escrow bigint) language plpgsql as $$
begin
  if p_units <= 0 then raise exception 'stake must be positive'; end if;
  perform petri.ensure_balance(p_account);
  -- The check constraint rejects this if the balance would go negative, so
  -- there is no read-then-write window for a double spend to slip through.
  update petri.balances b
     set balance = b.balance - p_units,
         escrow  = b.escrow + p_units,
         updated_at = now()
   where b.account_id = p_account;
  insert into petri.ledger_entries (kind, account_id, units)
    values ('stake', p_account, p_units);
  return query select b.balance, b.escrow from petri.balances b where b.account_id = p_account;
end $$;

create or replace function petri.claim_pot(p_winner uuid, p_loser uuid)
returns bigint language plpgsql as $$
declare moved bigint;
begin
  perform petri.ensure_balance(p_winner);
  -- Lock both rows in a deterministic order to avoid deadlocking when two
  -- players eat each other's cells in the same tick.
  perform 1 from petri.balances
   where account_id in (p_winner, p_loser)
   order by account_id
     for update;

  select escrow into moved from petri.balances where account_id = p_loser;
  if moved is null or moved <= 0 then return 0; end if;

  update petri.balances set escrow = 0, updated_at = now() where account_id = p_loser;
  update petri.balances set escrow = escrow + moved, updated_at = now() where account_id = p_winner;
  insert into petri.ledger_entries (kind, account_id, counterparty, units)
    values ('claim', p_winner, p_loser, moved);
  return moved;
end $$;

create or replace function petri.cash_out(p_account uuid, p_rake_bps int)
returns table (paid bigint, rake bigint) language plpgsql as $$
declare pot bigint; cut bigint;
begin
  select escrow into pot from petri.balances where account_id = p_account for update;
  if pot is null or pot <= 0 then return query select 0::bigint, 0::bigint; return; end if;

  cut := (pot * p_rake_bps) / 10000;
  update petri.balances
     set escrow = 0, balance = balance + (pot - cut), updated_at = now()
   where account_id = p_account;
  update petri.house set balance = balance + cut where id = 0;
  insert into petri.ledger_entries (kind, account_id, units, meta)
    values ('cashout', p_account, pot - cut, jsonb_build_object('rake', cut));
  return query select (pot - cut)::bigint, cut::bigint;
end $$;

create or replace function petri.forfeit_pot(p_account uuid)
returns bigint language plpgsql as $$
declare pot bigint;
begin
  select escrow into pot from petri.balances where account_id = p_account for update;
  if pot is null or pot <= 0 then return 0; end if;
  update petri.balances set escrow = 0, updated_at = now() where account_id = p_account;
  update petri.house set balance = balance + pot where id = 0;
  insert into petri.ledger_entries (kind, account_id, units) values ('forfeit', p_account, pot);
  return pot;
end $$;

create or replace function petri.refund_pot(p_account uuid)
returns bigint language plpgsql as $$
declare pot bigint;
begin
  select escrow into pot from petri.balances where account_id = p_account for update;
  if pot is null or pot <= 0 then return 0; end if;
  update petri.balances
     set escrow = 0, balance = balance + pot, updated_at = now()
   where account_id = p_account;
  insert into petri.ledger_entries (kind, account_id, units) values ('refund', p_account, pot);
  return pot;
end $$;

-- Conservation check. Should equal total deposits minus total withdrawals at
-- all times. Run it from the SQL editor, or wire it to a monitor.
create or replace view petri.money_total as
  select
    (select coalesce(sum(balance + escrow), 0) from petri.balances)
      + (select balance from petri.house where id = 0) as held,
    (select coalesce(sum(units) filter (where kind = 'deposit'), 0)
           - coalesce(sum(units) filter (where kind = 'withdraw'), 0)
       from petri.ledger_entries) as expected;

-- ── row level security ──────────────────────────────────────────────────────
-- Enabled with NO policies: deny by default. The server connects as a role
-- that bypasses RLS. Nothing else should ever read these tables.

alter table petri.accounts       enable row level security;
alter table petri.sessions       enable row level security;
alter table petri.balances       enable row level security;
alter table petri.house          enable row level security;
alter table petri.ledger_entries enable row level security;

revoke all on all tables in schema petri from anon, authenticated;
revoke all on schema petri from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Match history and career stats.
--
-- One row per LIFE, not per session: dying and pressing Play again starts a
-- new match, which is what the in-game counters already assume.
--
-- WHAT COUNTS AS A WIN. Agar.io has no win condition, so one has to be chosen
-- rather than discovered. Here a match is won if you finished in the TOP 5 on
-- the leaderboard, or you cashed out a wagered run for more than you staked.
--
-- It is a generated column so the rule lives in exactly one place and old rows
-- cannot disagree with new ones. Changing the threshold requires dropping and
-- re-adding the column (see server/db/migrations/002_win_top5.sql), because
-- Postgres cannot alter a generated expression in place. Stored `won` values
-- recompute on re-add; the streak columns in player_stats do NOT, so follow it
-- with select petri.rebuild_stats();
--
-- CAVEAT: "top 5" is only meaningful when the arena holds more than 5. With
-- the default 14 bots it does, but if you run BOTS=3 then every finish is a
-- win. Guard it by adding `and players_in_arena > 5` to the expression if you
-- ever run small arenas.
-- ---------------------------------------------------------------------------

create table if not exists petri.matches (
  id                bigserial primary key,
  account_id        uuid not null references petri.accounts(id) on delete cascade,

  started_at        timestamptz not null,
  ended_at          timestamptz not null default now(),
  duration_seconds  numeric(10,2) not null check (duration_seconds >= 0),

  -- Standing at the moment of the fatal bite, not after it.
  finish_position   int check (finish_position > 0),
  players_in_arena  int check (players_in_arena > 0),

  orbs_absorbed     int not null default 0 check (orbs_absorbed >= 0),
  players_eaten     int not null default 0 check (players_eaten >= 0),
  peak_mass         int not null default 0 check (peak_mass >= 0),

  -- 'eaten'      swallowed by another player
  -- 'bot'        swallowed by an NPC
  -- 'cashed_out' left voluntarily with the pot
  -- 'survived'   still alive when the round timer expired
  -- 'abandoned'  disconnected and the linger window expired
  outcome           text not null check (outcome in ('eaten','bot','cashed_out','survived','abandoned')),
  killer_id         uuid references petri.accounts(id) on delete set null,

  stake             bigint not null default 0 check (stake >= 0),
  payout            bigint not null default 0 check (payout >= 0),

  -- Top 5, or cashed out ahead. Keep in step with MemoryRepo.isWin.
  won boolean generated always as (
    finish_position <= 5 or (outcome = 'cashed_out' and payout > stake)
  ) stored
);

create index if not exists matches_account_ended on petri.matches (account_id, ended_at desc);
create index if not exists matches_peak_mass     on petri.matches (peak_mass desc);
create index if not exists matches_ended_at      on petri.matches (ended_at desc);

-- Aggregates maintained on write. Deriving these on read would mean scanning a
-- player's whole history every time the menu opens.
create table if not exists petri.player_stats (
  account_id       uuid primary key references petri.accounts(id) on delete cascade,
  matches          int    not null default 0,
  wins             int    not null default 0,
  time_played      numeric(12,2) not null default 0,   -- seconds, all time
  orbs_absorbed    bigint not null default 0,
  players_eaten    bigint not null default 0,
  best_peak_mass   int    not null default 0,
  best_position    int,                                 -- lowest number seen
  first_places     int    not null default 0,
  current_streak   int    not null default 0,
  longest_streak   int    not null default 0,
  total_staked     bigint not null default 0,
  total_won        bigint not null default 0,
  last_played_at   timestamptz
);

-- Records the match and folds it into the career totals in one statement, so
-- a crash cannot leave a match logged but the streak un-updated.
create or replace function petri.record_match(
  p_account          uuid,
  p_started_at       timestamptz,
  p_duration         numeric,
  p_finish_position  int,
  p_players_in_arena int,
  p_orbs             int,
  p_eaten            int,
  p_peak             int,
  p_outcome          text,
  p_killer           uuid,
  p_stake            bigint,
  p_payout           bigint
) returns table (
  match_id bigint, won boolean, current_streak int, longest_streak int
) language plpgsql as $$
declare v_id bigint; v_won boolean; v_streak int; v_longest int;
begin
  insert into petri.matches (
    account_id, started_at, duration_seconds, finish_position, players_in_arena,
    orbs_absorbed, players_eaten, peak_mass, outcome, killer_id, stake, payout
  ) values (
    p_account, p_started_at, p_duration, p_finish_position, p_players_in_arena,
    p_orbs, p_eaten, p_peak, p_outcome, p_killer, p_stake, p_payout
  )
  returning id, matches.won into v_id, v_won;

  insert into petri.player_stats as ps (
    account_id, matches, wins, time_played, orbs_absorbed, players_eaten,
    best_peak_mass, best_position, first_places, current_streak, longest_streak,
    total_staked, total_won, last_played_at
  ) values (
    p_account, 1, case when v_won then 1 else 0 end, p_duration, p_orbs, p_eaten,
    p_peak, p_finish_position, case when p_finish_position = 1 then 1 else 0 end,
    case when v_won then 1 else 0 end, case when v_won then 1 else 0 end,
    p_stake, p_payout, now()
  )
  on conflict (account_id) do update set
    matches        = ps.matches + 1,
    wins           = ps.wins + case when v_won then 1 else 0 end,
    time_played    = ps.time_played + p_duration,
    orbs_absorbed  = ps.orbs_absorbed + p_orbs,
    players_eaten  = ps.players_eaten + p_eaten,
    best_peak_mass = greatest(ps.best_peak_mass, p_peak),
    -- "Best" position is the LOWEST number, so least() not greatest().
    best_position  = case
                       when p_finish_position is null then ps.best_position
                       when ps.best_position is null then p_finish_position
                       else least(ps.best_position, p_finish_position)
                     end,
    first_places   = ps.first_places + case when p_finish_position = 1 then 1 else 0 end,
    current_streak = case when v_won then ps.current_streak + 1 else 0 end,
    longest_streak = greatest(
                       ps.longest_streak,
                       case when v_won then ps.current_streak + 1 else 0 end
                     ),
    total_staked   = ps.total_staked + p_stake,
    total_won      = ps.total_won + p_payout,
    last_played_at = now()
  returning ps.current_streak, ps.longest_streak into v_streak, v_longest;

  return query select v_id, v_won, v_streak, v_longest;
end $$;

-- Recompute every aggregate from the match log. Use after changing the `won`
-- rule, or to repair drift. Streaks are replayed in chronological order.
--
-- Every identifier here is deliberately distinct: an earlier version used a
-- variable `n` and a CTE column `n`, which Postgres rejected as ambiguous.

create or replace function petri.rebuild_stats() returns int language plpgsql as $$
declare v_rows int := 0;
begin
  delete from petri.player_stats;

  insert into petri.player_stats (
    account_id, matches, wins, time_played, orbs_absorbed, players_eaten,
    best_peak_mass, best_position, first_places, current_streak, longest_streak,
    total_staked, total_won, last_played_at
  )
  select
    m.account_id,
    count(*),
    count(*) filter (where m.won),
    coalesce(sum(m.duration_seconds), 0),
    coalesce(sum(m.orbs_absorbed), 0),
    coalesce(sum(m.players_eaten), 0),
    coalesce(max(m.peak_mass), 0),
    min(m.finish_position),
    count(*) filter (where m.finish_position = 1),
    0, 0,
    coalesce(sum(m.stake), 0),
    coalesce(sum(m.payout), 0),
    max(m.ended_at)
  from petri.matches m
  group by m.account_id;

  -- Streaks depend on order, so they are replayed rather than aggregated.
  -- Standard gaps-and-islands: consecutive wins share the same value of
  -- (seq - seq_of_kind), so grouping on that difference yields one row per
  -- unbroken run.
  with ordered as (
    select
      o.account_id,
      o.won,
      row_number() over (partition by o.account_id order by o.ended_at, o.id) as seq,
      row_number() over (partition by o.account_id, o.won order by o.ended_at, o.id) as seq_of_kind
    from petri.matches o
  ),
  islands as (
    select
      ordered.account_id,
      count(*) as run_len,
      max(ordered.seq) as run_end
    from ordered
    where ordered.won
    group by ordered.account_id, (ordered.seq - ordered.seq_of_kind)
  ),
  totals as (
    select ordered.account_id, max(ordered.seq) as last_seq
    from ordered
    group by ordered.account_id
  ),
  streaks as (
    select
      i.account_id,
      max(i.run_len) as longest_run,
      -- The current streak is a run that is still going, i.e. one that ends on
      -- the player's most recent match. If their last match was a loss, no run
      -- qualifies and this is NULL, which coalesces to zero below.
      coalesce(max(i.run_len) filter (where i.run_end = t.last_seq), 0) as current_run
    from islands i
    join totals t on t.account_id = i.account_id
    group by i.account_id
  )
  update petri.player_stats ps
     set longest_streak = coalesce(s.longest_run, 0),
         current_streak = coalesce(s.current_run, 0)
    from streaks s
   where s.account_id = ps.account_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- Public-facing boards. Kept as views so the queries live with the schema.
create or replace view petri.board_mass as
  select a.display_name, s.best_peak_mass as value, s.account_id
    from petri.player_stats s join petri.accounts a on a.id = s.account_id
   where s.best_peak_mass > 0
   order by s.best_peak_mass desc limit 100;

create or replace view petri.board_streak as
  select a.display_name, s.longest_streak as value, s.account_id
    from petri.player_stats s join petri.accounts a on a.id = s.account_id
   where s.longest_streak > 0
   order by s.longest_streak desc limit 100;

create or replace view petri.board_orbs as
  select a.display_name, s.orbs_absorbed as value, s.account_id
    from petri.player_stats s join petri.accounts a on a.id = s.account_id
   where s.orbs_absorbed > 0
   order by s.orbs_absorbed desc limit 100;

alter table petri.matches      enable row level security;
alter table petri.player_stats enable row level security;

revoke all on all tables in schema petri from anon, authenticated;
