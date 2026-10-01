-- raceto10 — initial schema
--
-- Implements SYSTEM-ARCHITECTURE.md §2. Column-by-column rationale lives there;
-- this file records the decisions that only make sense in SQL.
--
-- Two things in here are load-bearing beyond ordinary structure:
--
--   1. The unique constraints. They are what let every webhook handler be
--      written without a "has this already happened?" query. A replayed Stripe
--      or Lemon Squeezy event inserts nothing and returns 200, because the
--      database refuses the duplicate. Correctness rests on these, not on the
--      application remembering to check.
--
--   2. The absence of a provider-specific column anywhere in the race tables.
--      `racer.verification_provider` selects an adapter; nothing downstream may
--      branch on it. There is no `stripe_customer_id` column, only
--      `external_customer_id`, which is opaque to us.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- Needed for the sponsorship exclusion constraint, which mixes an equality test
-- on a uuid with a range overlap test. Without it, `EXCLUDE USING gist` cannot
-- index the slot_id.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

-- Which adapter owns the racer's connection. Adding a provider is an
-- ALTER TYPE ... ADD VALUE, which cannot run inside the same transaction that
-- uses the new value — so it is its own migration when it happens.
create type verification_provider as enum ('stripe', 'lemonsqueezy');

-- Connection sub-state, deliberately orthogonal to racer.status. A racer whose
-- connection dies is still 'racing'; they simply stop accumulating.
create type connection_state as enum ('pending', 'connected', 'revoked', 'unavailable');

create type racer_status as enum ('registered', 'racing', 'won', 'expired');
create type race_event_type as enum ('started', 'milestone', 'won');
create type slot_placement as enum ('sidebar-left', 'sidebar-right', 'bar-top', 'bar-bottom');

-- A position has no status. It is free when no confirmed sponsorship covers the
-- current instant, and that is a query rather than a column. This status belongs
-- to a BOOKING.
create type sponsorship_status as enum ('pending', 'confirmed', 'cancelled', 'expired');

-- The landing page's qualifying question: "How many paying customers do you
-- have right now?" — verbatim from SYSTEM-ARCHITECTURE.md §2.
--
-- `payment_status`, `refund_status` and `sponsorship_adjustment_kind` were
-- removed with the sponsor payment, refund and impression-tracking tables.
-- They had no other referent: nothing in the product charges a sponsor, so an
-- enum describing how a charge settled had nothing to describe.
create type customer_band as enum ('0', '1-5', '6+');

-- ---------------------------------------------------------------------------
-- racer
-- ---------------------------------------------------------------------------

create table racer (
  id                              uuid primary key default gen_random_uuid(),
  name                            text not null,
  handle                          text not null,
  email                           text not null,

  verification_provider           verification_provider not null,
  provider_account_id             text,
  -- A REFERENCE to a Supabase Vault secret, never a credential. Writing a raw
  -- key into this column would defeat the entire point of the separation.
  provider_credential_ref         uuid,
  provider_credential_expires_at  timestamptz,

  connection_state                connection_state not null default 'pending',
  connection_revoked_at           timestamptz,

  -- Captured before race_start_at is written. See §4 — the ordering is the
  -- mechanism, not a style choice.
  baseline_customer_count         integer,
  baseline_captured_at            timestamptz,

  race_start_at                   timestamptz,
  race_end_at                     timestamptz,

  -- Derived from race_customer, never incremented. Stored for display only.
  current_customer_count          integer not null default 0,
  count_reconciled_at             timestamptz,
  won_at                          timestamptz,

  connect_state                   text,
  connect_state_expires_at        timestamptz,

  status                          racer_status not null default 'registered',
  created_at                      timestamptz not null default now(),

  -- Only email is unique. The architecture does not claim handle uniqueness,
  -- and adding it would reject legitimate signups on an unstated rule.
  constraint racer_email_key unique (email),

  -- A negative baseline would mean the snapshot ran backwards.
  constraint racer_baseline_non_negative
    check (baseline_customer_count is null or baseline_customer_count >= 0),

  constraint racer_count_non_negative check (current_customer_count >= 0),

  constraint racer_window_ordered
    check (race_start_at is null or race_end_at is null or race_end_at > race_start_at)
);

-- connect_state is a CSRF token. A collision would let one racer's callback
-- complete another racer's registration, so uniqueness is a security property
-- here, not tidiness. Partial, because it is null for every racer who is not
-- mid-registration.
create unique index racer_connect_state_key
  on racer (connect_state)
  where connect_state is not null;

create index racer_status_idx on racer (status);

-- Drives the reconciliation sweep and the lifecycle job.
create index racer_race_end_at_idx on racer (race_end_at)
  where status = 'racing';

-- ---------------------------------------------------------------------------
-- race_event
-- ---------------------------------------------------------------------------

create table race_event (
  id               uuid primary key default gen_random_uuid(),
  racer_id         uuid not null references racer (id) on delete cascade,
  type             race_event_type not null,
  customer_number  integer,
  created_at       timestamptz not null default now(),

  -- 1..10 for milestones; null for started/won. Keeps a synthetic "11th
  -- customer" event from ever being written.
  constraint race_event_customer_number_range
    check (customer_number is null or customer_number between 1 and 10)
);

create index race_event_racer_created_idx
  on race_event (racer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- race_baseline_customer — the integrity anchor of the whole product
-- ---------------------------------------------------------------------------

-- One row per customer that already existed when the race started. This is a
-- SET, not a count, and that is the entire point: when an existing customer
-- pays again mid-race, only set membership can tell you they are not new.
create table race_baseline_customer (
  id                    uuid primary key default gen_random_uuid(),
  racer_id              uuid not null references racer (id) on delete cascade,
  external_customer_id  text not null,
  created_at            timestamptz not null default now(),

  constraint race_baseline_customer_key unique (racer_id, external_customer_id)
);

-- ---------------------------------------------------------------------------
-- race_customer — the counted set
-- ---------------------------------------------------------------------------

create table race_customer (
  id                    uuid primary key default gen_random_uuid(),
  racer_id              uuid not null references racer (id) on delete cascade,
  external_customer_id  text not null,
  first_paid_at         timestamptz not null,
  provider_payment_id   text,
  created_at            timestamptz not null default now(),

  -- The constraint that makes replay harmless. current_customer_count is
  -- count(*) over this table and is always safe to recompute from scratch.
  constraint race_customer_key unique (racer_id, external_customer_id)
);

create index race_customer_racer_paid_idx on race_customer (racer_id, first_paid_at);

-- ---------------------------------------------------------------------------
-- Removed before the first push: provider_event, visit
-- ---------------------------------------------------------------------------
--
-- `provider_event` was a webhook ledger. The product verifies a racer's
-- customer count by polling the provider roughly every 30 minutes and
-- reconciling, so there is no inbound webhook and therefore no event to record.
-- A retry sweep over a table nothing writes to is not a safety net.
--
-- `visit` held one row per page view, for a globe of visitor locations and a
-- live activity feed. Visitor tracking is not part of this product: the globe
-- plots RACERS from their activation coordinates, which come from `racer`, and
-- the activity feed is built from `race_event`. Nothing ever queried this
-- table — `src/lib/geo.ts` reads Vercel's `x-vercel-ip-*` request headers
-- directly and only mentions `visit` in a comment explaining the granularity.
--
-- Both are removed here rather than in a later migration because the hosted
-- database has never received this schema. Creating a table and dropping it in
-- the next migration would be churn with no history to preserve.

-- ---------------------------------------------------------------------------
-- waitlist_signup
-- ---------------------------------------------------------------------------
--
-- KEPT, and this one is load-bearing. The landing page has a live waitlist:
-- `src/components/landing/waitlist-form.tsx` posts to
-- `src/app/actions/waitlist.ts`, which calls `addWaitlistSignup` in
-- `src/lib/queries/waitlist.ts` — an INSERT into this table. `waitlist_stats`
-- is the public count over it.

create table waitlist_signup (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  customers_now  customer_band not null,
  created_at     timestamptz not null default now(),

  constraint waitlist_signup_email_key unique (email)
);

-- ---------------------------------------------------------------------------
-- sponsor_slot — the ten positions. Fixed inventory.
-- ---------------------------------------------------------------------------
--
-- A position has NO price, NO holder and NO status. Those all belong to a
-- booking. Splitting them is what makes rotation expressible at all: one table
-- holding both the inventory and whoever currently holds it cannot represent
-- "more than ten sponsors over time", because there is nowhere for the previous
-- sponsor to go.
--
-- A position is free when no confirmed sponsorship covers the current instant.
-- That is a query, not a column — nothing to expire, and nothing that goes
-- stale if a job fails to run.
create table sponsor_slot (
  id           uuid primary key default gen_random_uuid(),

  -- Exactly ten, enforced here rather than trusted to application code.
  slot_number  integer not null,
  placement    slot_placement not null,

  created_at   timestamptz not null default now(),

  constraint sponsor_slot_number_key unique (slot_number),
  constraint sponsor_slot_number_range check (slot_number between 1 and 10)
);

-- ---------------------------------------------------------------------------
-- sponsorship — one booked term. PUBLISHED TO REALTIME.
-- ---------------------------------------------------------------------------

-- ###########################################################################
-- # NO SECRET MAY EVER BE ADDED TO THIS TABLE.                                #
-- #                                                                           #
-- # It is added to the supabase_realtime publication, and Realtime broadcasts #
-- # ENTIRE ROWS to every subscriber, so anything here is readable by any      #
-- # browser on the site.                                                      #
-- #                                                                           #
-- # This is why no sponsor contact address is stored here at all: nothing    #
-- # collects one. A booking is a hold plus a listing, not a purchase, so     #
-- # there is no billing contact to keep. Adding one back for convenience     #
-- # would broadcast that address to every browser on the site.               #
-- #                                                                           #
-- # `hold_expires_at` IS here, deliberately: it is a timestamp, not a secret, #
-- # and splitting it out would force every hold sweep to join for no gain.    #
-- ###########################################################################
create table sponsorship (
  id                  uuid primary key default gen_random_uuid(),
  slot_id             uuid not null references sponsor_slot (id) on delete restrict,

  status              sponsorship_status not null default 'pending',
  term_days           integer not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,

  -- What THIS booking cost, captured at purchase. The current price of a term
  -- lives in sponsor_pricing; this is history and must not move when that does.
  price_cents         integer not null,

  sponsor_name        text not null,
  -- Hard cap of 60, derived from the card geometry in DESIGN-SYSTEM.md
  -- (~170-190px wide, ~90px tall). Enforced here as well as in the form,
  -- because the form is a convenience and this is the boundary.
  sponsor_description text not null,
  sponsor_logo_url    text,
  sponsor_link        text not null,

  -- The 30-minute window in which a pending booking holds the position while
  -- checkout is completed. See §13.
  hold_expires_at     timestamptz,

  created_at          timestamptz not null default now(),

  constraint sponsorship_term_allowed check (term_days in (1, 3, 7)),
  constraint sponsorship_window_ordered check (ends_at > starts_at),
  constraint sponsorship_price_positive check (price_cents > 0),
  constraint sponsorship_description_length
    check (char_length(sponsor_description) <= 60),

  -- #########################################################################
  -- # The constraint that makes double-selling a position impossible.        #
  -- #                                                                         #
  -- # This is the sponsor-side counterpart of the unique constraints that     #
  -- # make webhook replay harmless: it settles who owns a position BEFORE     #
  -- # any money moves, in the database, rather than asking application code   #
  -- # to remember to look. It replaces the old `version` token entirely —     #
  -- # with fixed prices there is no stale-price race left to detect.          #
  -- #                                                                         #
  -- # Cancelled bookings are excluded so a released hold does not block the   #
  -- # next buyer. `expired` ones still occupy their (past) window, which      #
  -- # cannot overlap a future booking anyway.                                 #
  -- #########################################################################
  constraint sponsorship_no_overlap exclude using gist (
    slot_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);

create index sponsorship_slot_window_idx on sponsorship (slot_id, starts_at);

-- Finds live bookings without scanning history. `now()` cannot appear in an
-- index predicate (it is not immutable), so the time comparison happens in the
-- query — this index just narrows to the rows worth comparing.
create index sponsorship_live_idx
  on sponsorship (slot_id, starts_at, ends_at)
  where status = 'confirmed';

-- The sweep's query: pending bookings whose hold has run out.
create index sponsorship_stale_hold_idx
  on sponsorship (hold_expires_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- sponsor_pricing — the only place a price is written down
-- ---------------------------------------------------------------------------

-- Prices are data, not constants. Changing them is an UPDATE, not a deploy, and
-- there is no copy anywhere in the UI that would need hunting down.
create table sponsor_pricing (
  term_days    integer primary key,
  price_cents  integer not null,
  updated_at   timestamptz not null default now(),

  constraint sponsor_pricing_term_allowed check (term_days in (1, 3, 7)),
  constraint sponsor_pricing_positive check (price_cents > 0)
);

-- ---------------------------------------------------------------------------
-- Removed before the first push: sponsor_payment, sponsor_daily_stat,
-- sponsorship_adjustment
-- ---------------------------------------------------------------------------
--
-- These three existed for a sponsor purchase flow this product does not have.
--
-- `sponsor_payment` held Stripe payment-intent and checkout-session ids, the
-- sponsor's billing address, and refund state. `sponsorship_adjustment`
-- recorded platform-failure compensation as time or credit. `sponsor_daily_stat`
-- counted impressions and clicks per booking per day.
--
-- None of them is reachable from any code, and the check was by executed call
-- rather than by name. `src/lib/queries/sponsorship.ts` writes only to
-- `sponsorship`, `sponsor_slot` and `sponsor_pricing`; `NewHold` in
-- `src/lib/sponsors/hold.ts` carries no email and no amount beyond the quoted
-- price; `sponsor_email` appears nowhere under `src/` at all.
--
-- What a booking IS here: a `pending` row carrying `hold_expires_at`, promoted
-- to `confirmed`. The exclusion constraint on `sponsorship` settles ownership
-- before anything else could. That is the whole mechanism, and it needs none of
-- these three tables.
--
-- Removed rather than deferred to a follow-up migration because the hosted
-- database has never received this schema. Creating them and then dropping them
-- would be churn with no history to preserve.
