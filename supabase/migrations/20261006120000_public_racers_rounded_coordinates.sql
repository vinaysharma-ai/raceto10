-- The public view rounds coordinates, instead of trusting every writer to.
--
-- ## The gap
--
-- `readRequestGeo` returns the platform's city centroid and `completeProfile`
-- rounds it to one decimal before writing, which is correct. But that is a rule
-- held in one caller. `public_racers` republishes `r.latitude` and
-- `r.longitude` verbatim, so a row written by any other path — a backfill, a
-- future admin tool, a hand-run `update` — would publish full precision to every
-- anonymous visitor, and nothing would object.
--
-- One decimal is about 11 km, which is the granularity the header actually
-- carries. More digits are not more accuracy; they are a more precise claim
-- about where a named person was sitting, made by a product whose whole premise
-- is that it does not overstate what it knows.
--
-- ## Rounding here as well, not instead
--
-- The write-side rounding stays. This is the boundary enforcing its own rule
-- rather than relying on its callers, which is the same reason the view has a
-- fixed column list rather than `select *`.
--
-- ## Expression change, not a shape change
--
-- `create or replace view` requires the same column names, in the same order,
-- with the same types. `round(x::numeric, 1)::double precision` keeps the type,
-- so this replaces cleanly. Column order is untouched — the failure the last
-- view migration hit, and the reason it says so in its own header.
--
-- Additive in the sense that matters: one row of logic changes, no column is
-- added or removed, no row is rewritten, and no consent is widened.

create or replace view public_racers
with (security_invoker = false) as
select
  r.public_slug,
  p.name                              as founder_name,
  p.x_handle,
  r.product_name,
  r.status,
  r.current_customer_count,
  r.activated_at,
  r.race_end_at,
  r.reached_ten_at,
  r.created_at,
  r.city,
  r.country,
  -- One decimal, enforced at the boundary rather than trusted from the writer.
  round(r.latitude::numeric, 1)::double precision  as latitude,
  round(r.longitude::numeric, 1)::double precision as longitude,
  r.product_url
from racer r
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;
