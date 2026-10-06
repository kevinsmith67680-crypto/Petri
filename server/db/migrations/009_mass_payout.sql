-- ---------------------------------------------------------------------------
-- Migration 009: paid places are paid the value of their mass.
--
-- A player who finishes in the paid places is paid what the HUD showed for
-- their mass at the whistle (0.005 USDC a point, shared/wager.js), and the
-- house takes their pot. When the winners grew more than was staked, the house
-- funds the difference, so its balance may now go below zero.
--
-- Run on an existing database. A fresh schema.sql already has both changes.
-- Until it is applied the server pays the pot instead (server/db/pg.js).
-- ---------------------------------------------------------------------------

alter table petri.house drop constraint if exists house_balance_check;

create or replace function petri.pay_out(p_account uuid, p_units bigint, p_rake_bps int)
returns table (paid bigint, rake bigint) language plpgsql as $$
declare pot bigint; cut bigint;
begin
  select escrow into pot from petri.balances where account_id = p_account for update;
  if pot is null or pot <= 0 or p_units is null or p_units <= 0 then
    return query select 0::bigint, 0::bigint; return;
  end if;

  cut := (p_units * p_rake_bps) / 10000;
  update petri.balances
     set escrow = 0, balance = balance + (p_units - cut), updated_at = now()
   where account_id = p_account;
  update petri.house set balance = balance + pot - (p_units - cut) where id = 0;
  insert into petri.ledger_entries (kind, account_id, units, meta)
    values ('payout', p_account, p_units - cut,
            jsonb_build_object('pot', pot, 'rake', cut, 'mass_value', p_units));
  return query select (p_units - cut)::bigint, cut::bigint;
end $$;
