-- ---------------------------------------------------------------------------
-- Migration 006: 18+ gate on account creation.
--
-- Adds the date of birth declared at signup. Both routes that create an
-- account now require it — the password form and the Google button, which
-- creates an account in one click and would otherwise have walked straight
-- past a gate that only guarded the form.
--
-- NULLABLE, AND THAT IS A GAP, NOT A DESIGN. Accounts created before this
-- migration never declared an age and are not retrospectively gated. Nothing
-- here backfills them, because there is no honest value to backfill with.
-- Before real money is switched on, those accounts need to be prompted on next
-- sign-in and blocked from staking until they answer.
--
-- No CHECK constraint enforcing the age: it would have to compare against
-- current_date, which Postgres refuses in a constraint because it is not
-- immutable — and a row that was valid when written would in any case stay
-- valid for ever. The rule lives in validateDateOfBirth() in server/accounts.js
-- and is applied at the moment of creation.
--
-- Storing the declared date rather than a boolean is deliberate. A flag says
-- only that somebody decided they qualified; the date is what they actually
-- asserted, and it is what a later identity check has to reconcile against.
--
-- Run on an existing database. A fresh schema.sql already has the column.
-- ---------------------------------------------------------------------------

alter table petri.accounts
  add column if not exists date_of_birth date;

comment on column petri.accounts.date_of_birth is
  'Self-declared at account creation. A declaration, not verification: it is '
  'not evidence of age and does not satisfy a licensing requirement for one.';
