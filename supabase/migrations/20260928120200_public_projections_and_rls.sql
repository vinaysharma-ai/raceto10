-- raceto10 — the public surface, and the line around it
--
-- Implements `02-BACKEND-SPEC.md` §4 and §5.
--
-- ## The posture, restated
--
-- Two trust zones. The browser holds the publishable key; the server holds the
-- service key. Everything below draws the line between them:
--
--   * No base table grants `anon` anything, with one deliberate exception.
--   * Anything publicly readable is a view listing its columns explicitly.
--   * Nothing grants `anon` a write, anywhere, on anything.
--
-- The views use owner's rights (`security_invoker = false`, PostgreSQL's
-- default, kept deliberately). Supabase warns about this because it bypasses
-- RLS — which is exactly why it is used here: the view's column list IS the
-- security boundary. `public_racers` reads `profiles` precisely because RLS
-- would otherwise block `anon` entirely, and hands back only what is listed.

-- ---------------------------------------------------------------------------
-- RLS on the new private tables
-- ---------------------------------------------------------------------------

alter table profiles              enable row level security;
alter table provider_connections  enable row level security;
alter table provider_credentials  enable row level security;
alter table verification_snapshots enable row level security;
alter table reconciliation_runs   enable row level security;

-- Strip Supabase's default grants. RLS already blocks the rows, but leaving the
-- grants means the only thing between the browser and a table is one policy
-- somebody might add later. Remove the privilege itself.
revoke all on table
  profiles,
  provider_connections,
  provider_credentials,
  verification_snapshots,
  reconciliation_runs
from anon, authenticated;

-- And on the racer table, which after the reshape carries the baseline — the
-- one number a competitor must never see.
revoke all on table racer, race_event, race_customer, race_baseline_customer
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Withdrawing the Realtime grants
-- ---------------------------------------------------------------------------
--
-- The previous migration granted `anon` SELECT on the `sponsorship` and
-- `race_event` base tables, because Realtime's `postgres_changes` is a
-- replication feature that can only publish tables and enforces RLS per
-- subscriber. A view cannot be published.
--
-- Realtime is not wired up. `02` §5 says anon may read public projections only,
-- so the grants are withdrawn until something actually subscribes. When Realtime
-- is built, these come back with a policy narrow enough to be worth having —
-- not as a standing grant on every column of a table that also holds
-- `sponsor_email`'s owner.
--
-- Reads are unaffected: `sponsorship_live` and the event view below both run
-- with owner's rights, so `anon` needs the grant on the view alone.
revoke select on sponsorship, race_event from anon, authenticated;

drop policy if exists sponsorship_public_read on sponsorship;
drop policy if exists race_event_public_read on race_event;

-- Visitor tracking is not part of this product (`00`, "Removes PII and
-- disclosure problems"), so `visit` and `visit_public` are gone from the
-- schema entirely rather than left dormant. There is no deployed table to
-- preserve: the hosted project has never received this schema, so nothing is
-- destroyed by removing them here.

-- `racer_public` and `race_activity` are dropped at the top of
-- `20260928120100`, before the columns they depend on are removed. They are
-- replaced by the views below under the names `02` §4 uses.

-- ---------------------------------------------------------------------------
-- public_racers — the single public source for globe, leaderboard and search
-- ---------------------------------------------------------------------------

-- One view, not `public_racers` plus `public_race_entries`. In the batch model
-- those were two grains — a person, and their entry in a particular batch. Here
-- a racer has their own window, so the person and the entry are the same row
-- and two views would be two names for one thing. `01` §5 requires the globe,
-- the leaderboard and the activity feed to share one source; one view makes
-- that structural rather than a convention.
--
-- ## The consent gate
--
-- `where public_consent_at is not null` is the whole of `01` §13 at the data
-- layer. A racer who has not agreed to be published is absent from every public
-- surface — not hidden by a flag some page might forget to check, but absent
-- from the view those pages read. Consent is a precondition of visibility
-- rather than a display setting.
--
-- ## What is absent, and must stay absent
--
-- email, auth id, provider account reference, credential material, baseline
-- counts, raw verification history, precise location. The baseline is the one
-- that matters most: it exists so that "10 customers" means "10 NEW customers",
-- and publishing it would hand every competitor a racer's starting position.
-- The internal `racer.id` is deliberately not exposed. `public_slug` is the
-- public identifier; it is unique, it is what URLs use, and it is the only
-- handle any public surface needs. Letting the primary key cross the boundary
-- would give every visitor a stable internal reference for every racer, which
-- is a correlation key nobody asked for and nothing needs.
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
  -- Approximate only. These are the edge's city-level centroid, the same class
  -- of data the map already plots, and never an address.
  r.city,
  r.country,
  r.latitude,
  r.longitude
from racer r
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;

-- ---------------------------------------------------------------------------
-- public_race_events — the activity feed
-- ---------------------------------------------------------------------------

-- The feed names people by handle and says what happened. It carries no
-- provider payload, no payment identifier and no customer identity — only the
-- milestone number, which is the public score.
-- No event id either, for the same reason: a public feed row is identified by
-- who it happened to and when, and a consumer that needs a key can build one
-- from those. An opaque internal uuid in a public payload is a reference that
-- outlives its usefulness and cannot be revoked.
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
  r.country
from race_event e
join racer r    on r.id = e.racer_id
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;

-- ---------------------------------------------------------------------------
-- public_search — deliberately narrower than public_racers
-- ---------------------------------------------------------------------------

-- Search returns less than the full public racer: no location, no count, no
-- timing. A result row needs a name, a handle, a product and somewhere to link
-- to — nothing else.
--
-- That is a privacy decision, not an oversight. An endpoint that can be queried
-- with an arbitrary substring and returns location and customer count in the
-- response is a way to enumerate and profile every racer on the board without
-- ever loading the board.
create or replace view public_search
with (security_invoker = false) as
select
  r.public_slug,
  p.name        as founder_name,
  p.x_handle,
  r.product_name
from racer r
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;

-- ---------------------------------------------------------------------------
-- public_sponsor_slots — the ten positions, without the table grant
-- ---------------------------------------------------------------------------

-- The sponsor board read `sponsor_slot` directly, which no grant has ever
-- allowed. A latent bug rather than a live one: no environment has ever had
-- these tables, so the read has only ever failed for a different reason and the
-- two were indistinguishable.
--
-- A position carries nothing private — a number and a placement — but the
-- internal id is dropped anyway, for the same reason as everywhere else.
-- `sponsorship_live` already carries `slot_number`, so the join needs nothing
-- the view does not have.
create or replace view public_sponsor_slots
with (security_invoker = false) as
select slot_number, placement from sponsor_slot;

grant select on public_sponsor_slots to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grants — the complete list of what a browser may read
-- ---------------------------------------------------------------------------

grant select on
  public_racers,
  public_race_events,
  public_search,
  sponsorship_live,
  waitlist_stats
to anon, authenticated;

-- `sponsor_pricing` is read directly rather than through a view, because the
-- sponsor board queries it. The price list is public by design: a sponsor needs
-- to see what a term costs before deciding to buy one, and nothing in it is
-- per-customer.
grant select on sponsor_pricing to anon, authenticated;

-- Deliberately absent from every grant above, and checked by the test in
-- `src/lib/security/anon-cannot-read-private.test.ts`:
--   profiles, racer, provider_connections, provider_credentials,
--   verification_snapshots, reconciliation_runs, race_customer,
--   race_baseline_customer.
