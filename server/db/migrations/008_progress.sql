-- ---------------------------------------------------------------------------
-- Migration 008: experience and skill rating.
--
-- One row per account that has finished a live round: the XP it has earned
-- by finishing in the paid places, and the rating matchmaking seats it by.
-- See shared/progress.js for the rules and README.md, "Levels and skill
-- matchmaking", for how they are used.
--
-- Run on an existing database. A fresh schema.sql already has the table.
-- ---------------------------------------------------------------------------

create table if not exists petri.progress (
  account_id   uuid primary key references petri.accounts(id) on delete cascade,
  xp           bigint not null default 0 check (xp >= 0),
  rating       double precision not null default 1000,
  rated_games  int not null default 0 check (rated_games >= 0),
  updated_at   timestamptz not null default now()
);

alter table petri.progress enable row level security;
revoke all on petri.progress from anon, authenticated;
