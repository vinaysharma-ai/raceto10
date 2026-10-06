-- The activity feed can say how long a race took.
--
-- ## Why
--
-- One of the feed's lines is "Ada finished in 3d 2h". The duration is the
-- distance between when the clock started and when the tenth customer paid, and
-- the second of those is already on the row as `occurred_at` — but the first is
-- not published anywhere. `public_race_events` carries no start time, so the
-- line cannot be written without inventing one.
--
-- The alternative would be to say only "finished", which throws away the single
-- most interesting fact about a win. Every finished racer has ten customers; the
-- time is the whole story.
--
-- ## What it exposes, and why that is already public
--
-- `r.activated_at` is the moment the clock started, and it is already on
-- `public_racers` for every consented racer — the leaderboard's "6d 4h left"
-- depends on `race_end_at` and its ordering on `activated_at`. Publishing the
-- same instant on the event row adds no fact that an anonymous visitor cannot
-- already read from the board. The `where` clause is unchanged, so consent still
-- gates it.
--
-- ## Appended, not inserted
--
-- `create or replace view` requires the same column names, in the same order,
-- with the same types, and a new column may only go at the end. The coordinates
-- migration learned this the hard way; this one is written with it in mind.
--
-- Additive: one column appended, no column removed or retyped, no row rewritten.

create or replace view public_race_events
with (security_invoker = false) as
select
  e.event_type,
  e.milestone_customer_count,
  e.occurred_at,
  r.public_slug,
  p.name          as founder_name,
  p.x_handle,
  r.product_name,
  r.city,
  r.country,
  -- Appended. The feed's "finished in 3d 2h" needs both ends of the race, and
  -- this is the only one that was missing. Already public on public_racers.
  r.activated_at
from race_event e
join racer r    on r.id = e.racer_id
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;
