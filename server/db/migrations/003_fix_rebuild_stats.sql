-- ---------------------------------------------------------------------------
-- Corrected petri.rebuild_stats().
--
-- The previous version declared a PL/pgSQL variable `n` and also aliased a CTE
-- column `n`, so Postgres could not tell which one `max(n)` meant:
--
--   ERROR: 42702: column reference "n" is ambiguous
--
-- Fixed by giving the variable a v_ prefix and every CTE column a distinctive
-- name. The correlated subquery that compared against the last match has also
-- been replaced with a plain join, which is clearer and cheaper.
--
-- Safe to run on its own. It only replaces the function definition.
-- ---------------------------------------------------------------------------

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
