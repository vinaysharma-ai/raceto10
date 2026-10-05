-- Two things Phase 4 needs that the schema does not yet have.
--
-- ## 1. `key_last4`, for display
--
-- The join flow has to be able to show a founder which key they connected, and
-- the only safe way to do that is the last four characters. The whole key is
-- sealed in `provider_credentials` and never opened outside an outbound provider
-- call, so there is nothing to render from.
--
-- It goes on `provider_connections` rather than on `provider_credentials`, and
-- that placement is the point. `provider_connections` exists to be the readable
-- half of the split — "non-secret metadata: which provider, which account,
-- whether it is healthy" — while the credentials table holds the ciphertext
-- alone and is read by nothing except the code that calls Stripe. Putting a
-- display string in the vault would mean every page that lists connections
-- touching the vault table, which is the one thing the split was built to
-- prevent.
--
-- Four characters of a key that is already refused unless it is `rk_live_` or
-- `rk_test_` is not a meaningful disclosure: the prefix is public, the key is
-- useless without the rest, and Stripe shows the same four in its own dashboard.
--
-- ## 2. A rate-limit counter
--
-- Key verification is an unauthenticated-by-cost operation: each attempt makes
-- us call Stripe with a key the caller chose. Five per user per hour is the
-- limit, which means something has to count attempts.
--
-- In memory would not be a rate limit — serverless instances are many and
-- short-lived, so a counter that lives in one of them bounds nothing. This is
-- the smallest durable shape: one row per subject per fixed window, incremented
-- in place. It is deliberately generic rather than named for Stripe, because
-- the waitlist and sign-in limits are the same mechanism and a second table for
-- them would be a second thing to get wrong.
--
-- ## What this migration does not do
--
-- It adds two columns-worth of structure and one table. It drops nothing,
-- renames nothing, rewrites no existing row, touches no RLS policy, touches
-- `provider_credentials`, and changes no public view. `racer.product_url` is
-- not included here — that is a separate, still-unapplied migration.

alter table provider_connections
  add column if not exists key_last4 text;

alter table provider_connections
  add constraint provider_connections_key_last4_shape
  check (key_last4 is null or key_last4 ~ '^[A-Za-z0-9]{4}$');

comment on column provider_connections.key_last4 is
  'The last four characters of the connected key, for display only. Not secret, and never used to authenticate anything.';

create table if not exists rate_limit_counter (
  id            uuid primary key default gen_random_uuid(),
  -- What is being limited: 'stripe_key_verify', 'waitlist_signup', 'signin_start'.
  bucket        text        not null,
  -- Who is being limited: an authenticated user id, or an IP for anonymous paths.
  subject       text        not null,
  window_start  timestamptz not null,
  attempts      integer     not null default 0,
  updated_at    timestamptz not null default now(),

  constraint rate_limit_counter_attempts_non_negative check (attempts >= 0),
  constraint rate_limit_counter_bucket_shape check (bucket ~ '^[a-z_]{3,40}$'),
  -- One row per subject per window. The upsert that increments this relies on it,
  -- so without the constraint two concurrent attempts could each create a row and
  -- each believe it was the first.
  constraint rate_limit_counter_window_key unique (bucket, subject, window_start)
);

comment on table rate_limit_counter is
  'Fixed-window attempt counts. One row per bucket, subject and window; incremented by upsert. Service role only.';

create index if not exists rate_limit_counter_window_start_idx
  on rate_limit_counter (window_start);

-- Server-only. The browser has no reason to read or write a rate limit, and a
-- table it can write is a rate limit it can lift.
revoke all on table rate_limit_counter from anon, authenticated;

alter table rate_limit_counter enable row level security;

-- No policy is created, deliberately. With RLS on and no policy, every
-- non-service role sees and writes nothing; the service role bypasses RLS
-- entirely. Adding a policy here would be adding the first hole.
