-- raceto10 — the public racer profile, and the activity feed
--
-- Two things the landing page's globe and the leaderboard need, and which the
-- original racer table could not answer:
--
--   1. WHERE a racer is. The globe plots real signups, so a racer needs a real
--      approximate location. Without these columns the globe has nothing to
--      plot and would have to be either empty forever or faked.
--   2. WHAT they are racing with, and how to find them. `product_name` and
--      `x_handle` are what make a race entry worth looking at and worth
--      sharing — an entry that says only "amaranth" is not a race page.
--
-- ---------------------------------------------------------------------------
-- On the location columns, and what they are not
-- ---------------------------------------------------------------------------
--
-- These are the approximate city/country centroid that Vercel's edge reports
-- for the request that submitted the form — the same class of data, and the
-- same granularity, as the `visit` table. They are NOT the racer's address, and
-- they are not derived from anything the racer typed.
--
-- They are nullable on purpose, and that is the honest state, not a gap:
-- outside Vercel's edge (local development, a self-hosted deploy, a request the
-- edge could not geolocate) there is no location to record. A racer with null
-- coordinates simply has no dot on the globe. The alternative — inventing a
-- location so the map looks populated — is the exact failure this product
-- cannot afford.
--
-- ---------------------------------------------------------------------------
-- On adding these as nullable rather than `not null`
-- ---------------------------------------------------------------------------
--
-- `product_name` and `x_handle` are required by the join form, so they could be
-- declared `not null`. They are not, for one reason: this migration may be
-- applied to a database that already has racer rows from the earlier schema,
-- and `alter table ... add column ... not null` without a default fails on a
-- non-empty table. Requiring them in validation instead keeps the migration
-- applicable to any environment, and the form is the only writer.

alter table racer
  add column if not exists product_name text,
  add column if not exists x_handle     text,
  add column if not exists city         text,
  add column if not exists country      text,
  add column if not exists latitude     double precision,
  add column if not exists longitude    double precision;

-- Latitude and longitude are only meaningful together. A row with one and not
-- the other is a bug in whatever wrote it, not a partially-known location, and
-- the globe cannot plot it either way.
alter table racer
  drop constraint if exists racer_coordinates_pair;
alter table racer
  add constraint racer_coordinates_pair
  check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  );

alter table racer
  drop constraint if exists racer_coordinates_range;
alter table racer
  add constraint racer_coordinates_range
  check (
    (latitude is null or (latitude between -90 and 90))
    and (longitude is null or (longitude between -180 and 180))
  );

-- ---------------------------------------------------------------------------
-- racer_public — widened, still without a single private column
-- ---------------------------------------------------------------------------

-- `create or replace view` can only append columns to the end of an existing
-- view's column list; it cannot reorder or remove them. The original list is
-- therefore kept in its original order, and the new columns are appended.
--
-- What is STILL deliberately absent, and must stay absent:
--   email, verification_provider, provider_account_id, provider_credential_ref,
--   provider_credential_expires_at, baseline_customer_count,
--   baseline_captured_at, connect_state, connect_state_expires_at,
--   count_reconciled_at, connection_revoked_at.
--
-- `connect_state` matters most here. The join flow stores a single-use OAuth
-- state token in it, and publishing that column would hand every visitor the
-- token that authorises a racer's Stripe callback.
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
  -- appended by 20260926120000
  product_name,
  x_handle,
  city,
  country,
  latitude,
  longitude
from racer;

-- ---------------------------------------------------------------------------
-- race_activity — the feed under the globe
-- ---------------------------------------------------------------------------

-- One row per thing that actually happened, with just enough about the racer to
-- render a line. Owner's rights like the other public views, and the column
-- list is again the boundary: it joins `racer` so the feed can name someone,
-- and hands back nothing that `racer_public` would not.
--
-- This exists as a view rather than two client queries because PostgREST cannot
-- embed one view inside another — there is no foreign key between them for it to
-- join on — so the join has to happen here or not at all.
create or replace view race_activity
with (security_invoker = false) as
select
  e.id,
  e.type,
  e.customer_number,
  e.created_at,
  r.id       as racer_id,
  r.name     as racer_name,
  r.handle   as racer_handle,
  r.product_name,
  r.city,
  r.country
from race_event e
join racer r on r.id = e.racer_id
-- A racer who never finished connecting has no race and no events; and an event
-- whose racer row somehow vanished is not something to render a blank line for.
where r.status <> 'registered';

grant select on racer_public to anon, authenticated;
grant select on race_activity to anon, authenticated;
