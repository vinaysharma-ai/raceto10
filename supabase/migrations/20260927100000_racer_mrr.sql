-- raceto10 — MRR, as a nullable column with nothing yet writing to it
--
-- RACETO10-REDESIGN-V2.md adds MRR to the leaderboard as "informational
-- context, not part of the race mechanic". The race is still decided by
-- customer count; MRR is texture for a spectator.
--
-- ---------------------------------------------------------------------------
-- Why this is a column and not a computed value
-- ---------------------------------------------------------------------------
--
-- MRR is genuinely hard to compute correctly from raw payments — monthly versus
-- annual plans, proration, refunds, upgrades mid-cycle. Deriving it at read
-- time from `race_customer` would mean the leaderboard's number changes shape
-- every time someone looked at it, and `race_customer` does not store amounts
-- at all today.
--
-- So MRR is a stored figure that reconciliation will write, exactly like
-- `current_customer_count` is a stored figure derived from `race_customer`.
-- Nothing writes it yet — the reconciliation job is a later step and needs a
-- live provider connection to run.
--
-- ---------------------------------------------------------------------------
-- What that means on screen, today
-- ---------------------------------------------------------------------------
--
-- Every racer's MRR is null, so the leaderboard renders an em dash in that
-- column. That is the honest representation of "we do not know this", and it is
-- deliberately not a zero: zero MRR is a specific claim about a business, and
-- rendering it for a founder whose revenue we simply have not read yet would be
-- a fabricated number. The same rule as everywhere else — real, or absent.

alter table racer
  add column if not exists mrr_cents integer;

alter table racer
  drop constraint if exists racer_mrr_non_negative;
alter table racer
  add constraint racer_mrr_non_negative
  check (mrr_cents is null or mrr_cents >= 0);

-- `create or replace view` may only append, so this lands after the coordinates
-- added by 20260926120000.
create or replace view racer_public
with (security_invoker = false) as
select
  id,
  name,
  handle,
  status,
  connection_state,
  current_customer_count,
  race_start_at,
  race_end_at,
  won_at,
  created_at,
  product_name,
  x_handle,
  city,
  country,
  latitude,
  longitude,
  mrr_cents
from racer;

grant select on racer_public to anon, authenticated;
