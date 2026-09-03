-- ---------------------------------------------------------------------------
-- Migration 004: allow the 'survived' outcome.
--
-- Live rounds have a ten-minute time limit. Players still alive when it
-- expires are recorded with outcome 'survived', which the original check
-- constraint rejects:
--
--   ERROR: 23514 new row for relation "matches" violates check constraint
--
-- Run this before deploying the round timer, or every end-of-round write
-- fails and those matches are lost.
--
-- Only the constraint changes. No rows are rewritten, so this is fast even on
-- a large table.
-- ---------------------------------------------------------------------------

begin;

alter table petri.matches drop constraint if exists matches_outcome_check;

alter table petri.matches
  add constraint matches_outcome_check
  check (outcome in ('eaten','bot','cashed_out','survived','abandoned'));

commit;

-- Verify: should return the constraint definition including 'survived'.
--
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname = 'matches_outcome_check';
