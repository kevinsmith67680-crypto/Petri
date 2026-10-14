-- ---------------------------------------------------------------------------
-- Migration 010: allow the 'zone' outcome.
--
-- Late in a live round the safe area closes in, and a player whose cells are
-- all drained away outside it was not eaten by anyone. Those runs are recorded
-- with outcome 'zone', which the existing check constraint rejects:
--
--   ERROR: 23514 new row for relation "matches" violates check constraint
--
-- Without this the game still plays and still settles — the stake is
-- forfeited either way — but every such match record fails to write and logs
-- `recordMatch:`, so it is missing from the player's history and stats.
--
-- Only the constraint changes. No rows are rewritten.
-- ---------------------------------------------------------------------------

begin;

alter table petri.matches drop constraint if exists matches_outcome_check;

alter table petri.matches
  add constraint matches_outcome_check
  check (outcome in ('eaten','bot','zone','cashed_out','survived','abandoned'));

commit;

-- Verify: should return the constraint definition including 'zone'.
--
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname = 'matches_outcome_check';
