-- ---------------------------------------------------------------------------
-- Migration 007: seat leases.
--
-- One row per account that a game server is currently responsible for. The
-- matchmaker reads it to send a returning player back to the server holding
-- their run, and a game server must win it before it touches an account's
-- escrow, so no two servers can move the same pot.
--
-- It is a lease, not a lock: the holder renews it every few seconds, and a
-- server that crashes simply stops. Nothing has to clean up after it.
--
-- Run on an existing database. A fresh schema.sql already has the table.
-- ---------------------------------------------------------------------------

create table if not exists petri.seats (
  account_id  uuid primary key references petri.accounts(id) on delete cascade,
  holder      text not null,
  expires_at  timestamptz not null
);
create index if not exists seats_holder on petri.seats (holder);

alter table petri.seats enable row level security;
revoke all on petri.seats from anon, authenticated;
