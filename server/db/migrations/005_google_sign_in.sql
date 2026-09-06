-- ---------------------------------------------------------------------------
-- Migration 005: sign in with Google.
--
-- Adds the Google subject claim and makes passwords optional, because a
-- federated account has none.
--
-- The `sub` is the stable, immutable identifier Google issues per user per
-- application. It is NOT the email address, deliberately: emails change hands
-- and change ownership, and keying an account to one is how account takeover
-- happens. Nothing here stores an email at all.
--
-- Run on an existing database. A fresh schema.sql already has both changes.
-- ---------------------------------------------------------------------------

begin;

alter table petri.accounts add column if not exists google_sub text;

create unique index if not exists accounts_google_sub_key
  on petri.accounts (google_sub)
  where google_sub is not null;

alter table petri.accounts alter column password drop not null;

-- Every account must be reachable by SOMETHING: a password or a Google
-- subject. Without this, a bug could leave an account nobody can sign into.
alter table petri.accounts drop constraint if exists accounts_has_credential;
alter table petri.accounts
  add constraint accounts_has_credential
  check (password is not null or google_sub is not null);

commit;

-- Verify:
--   select count(*) filter (where google_sub is not null) as google,
--          count(*) filter (where password is not null)   as password
--     from petri.accounts;
