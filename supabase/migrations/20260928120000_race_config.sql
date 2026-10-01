-- raceto10 — race duration as configuration, not a constant
--
-- ## Why this is a table and not an env var
--
-- `00-START-HERE-REVISED.md` requires the duration to be configurable and
-- explicitly forbids hardcoding 7 or 14 into UI copy, database constraints, or
-- business logic. `02-BACKEND-SPEC.md` §18 lists the environment variables and
-- does not include one for this, and tells us to follow existing conventions
-- before inventing a variable.
--
-- The existing convention is `sponsor_pricing`: a value that will change is a
-- row, so changing it is an UPDATE rather than a deploy. The duration will
-- change — 7 days is the current candidate and not yet locked — so it gets the
-- same treatment.
--
-- ## What is deliberately NOT here
--
-- No CHECK pinning the value to 7 or 14. A constraint listing the permitted
-- durations would be exactly the hardcoded business rule the brief rules out;
-- it would turn "let's try 10 days" into a migration. The only constraint is
-- that a race has a positive length.
--
-- ## Why a single row, and how that is enforced
--
-- A boolean primary key with a `check (id)` constraint. The column can only
-- ever hold `true`, so the table can only ever hold one row. That is a real
-- constraint rather than a convention, which matters because a second config
-- row would make "the current duration" ambiguous and the reader would silently
-- pick whichever row the planner returned first.

create table if not exists race_config (
  id            boolean primary key default true,
  duration_days integer not null,
  updated_at    timestamptz not null default now(),

  constraint race_config_singleton check (id),
  constraint race_config_duration_positive check (duration_days > 0)
);

-- Seeded, not assumed. 7 days is the current preferred candidate; changing it
-- is `update race_config set duration_days = ...`.
--
-- `do nothing` on conflict so a replayed migration cannot clobber a value that
-- has since been changed in production — the same rule the sponsor price list
-- follows.
insert into race_config (id, duration_days)
values (true, 7)
on conflict (id) do nothing;

alter table race_config enable row level security;

-- Public on purpose. The duration is printed in the join copy and the
-- leaderboard; it is not a secret and hiding it would only mean every page that
-- shows it needs the service key.
drop policy if exists race_config_public_read on race_config;
create policy race_config_public_read on race_config
  for select to anon, authenticated
  using (true);

grant select on race_config to anon, authenticated;

-- No insert/update/delete for anyone but the service role, which bypasses RLS
-- by design. There is deliberately no policy granting a write to anon or
-- authenticated: changing the length of everyone's race is not a client
-- operation.

comment on table race_config is
  'Singleton. Race duration is configuration, not a constant — see 00-START-HERE-REVISED.md.';
