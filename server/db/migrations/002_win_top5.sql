-- ---------------------------------------------------------------------------
-- Migration 002: a win is now a top-5 finish, not a 1st place.
--
-- Run this ONLY if you already applied schema.sql with the old rule. A fresh
-- database created from the current schema.sql already has the new definition
-- and does not need this.
--
-- Postgres cannot alter a generated expression in place, so the column is
-- dropped and re-added. Nothing is lost: `won` is derived, never written. The
-- re-add recomputes it for every historical row.
--
-- Safe to run inside a transaction. On a large matches table this rewrites the
-- whole table and takes an ACCESS EXCLUSIVE lock, so do it while nobody is
-- playing.
-- ---------------------------------------------------------------------------

begin;

alter table petri.matches drop column if exists won;

alter table petri.matches
  add column won boolean generated always as (
    finish_position <= 5 or (outcome = 'cashed_out' and payout > stake)
  ) stored;

-- Stored `won` values are now correct, but wins / current_streak /
-- longest_streak in player_stats were accumulated under the old rule and are
-- stale. Replay them from the match log.
select petri.rebuild_stats();

commit;

-- Sanity check: these two numbers should agree for every player.
--
--   select s.account_id, s.wins,
--          (select count(*) from petri.matches m
--            where m.account_id = s.account_id and m.won) as recount
--     from petri.player_stats s
--    where s.wins <> (select count(*) from petri.matches m
--                      where m.account_id = s.account_id and m.won);
--
-- An empty result means the rebuild worked.
