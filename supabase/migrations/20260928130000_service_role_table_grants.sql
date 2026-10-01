-- raceto10 — restore service_role access to tables created after the
-- blanket grant, and make it stick for the next ones.
--
-- ## What went wrong
--
-- `20260924150107_rls_and_public_views.sql` contains:
--
--     grant all on all tables in schema public to service_role;
--
-- That statement is evaluated once, against the tables that exist *at that
-- moment*. Every table added afterwards — the six created by
-- `20260928120000_race_config.sql` and
-- `20260928120100_identity_and_provider_schema.sql` — inherited nothing.
--
-- The result, measured against the hosted project rather than reasoned about:
--
--     racer, race_event, sponsor_slot, sponsorship      200
--     profiles, provider_connections, provider_credentials,
--     verification_snapshots, reconciliation_runs,
--     race_config                                       403
--
-- ## Why it matters, and why it went unnoticed
--
-- `service_role` is the role every server-side write uses. `ensureProfile`
-- upserts `profiles` through `createAdminClient()` on every OAuth callback, so
-- **sign-in is broken** at the point of writing the profile row — not
-- intermittently, every time. `resolveCredential` cannot read
-- `provider_credentials` at all, which surfaces as "that key is dead" and sends
-- a racer to check their Stripe dashboard for a fault that is ours.
--
-- Three things hid it, and each is worth remembering:
--
--   * The local schema harness connects as `postgres`, a superuser. Superusers
--     bypass grants entirely, so no local test could have observed this.
--   * The harness asserts what `anon` *cannot* do. Nothing asserted what
--     `service_role` *can* do.
--   * `/join` was verified signed-out, which renders without touching
--     `profiles`.
--
-- A grant that is missing fails closed and quietly: the query returns a
-- permission error that the calling code turns into "something went wrong".
--
-- ## The fix, in two parts
--
-- The first restores access to what exists. The second is the one that matters:
-- `alter default privileges` changes what future tables inherit, so the next
-- migration that adds a table cannot reintroduce this. Fixing only the first
-- would leave the same trap for whoever adds table seven.
--
-- Both are idempotent — `grant` and `alter default privileges` are declarative,
-- so re-running is a no-op rather than an error.

-- ---------------------------------------------------------------------------
-- 1. Restore access to the tables that exist now
-- ---------------------------------------------------------------------------

grant all on all tables in schema public to service_role;

-- Sequences too. The tables are all `gen_random_uuid()` today, but a sequence
-- granted to nobody is the same class of latent fault, and it costs one line
-- here rather than an outage later.
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 2. Make future tables inherit it
-- ---------------------------------------------------------------------------

-- Applies to objects created by the role running migrations — `postgres` in a
-- Supabase migration — which is the role that creates every table here.
--
-- Deliberately NOT doing the same for `anon` or `authenticated`. Those two are
-- meant to start with nothing and be granted explicitly per view, which is the
-- posture `20260924150107` sets out and which the public projections depend on.
-- Extending this to them would undo that boundary in one careless line.
alter default privileges in schema public
  grant all on tables to service_role;

alter default privileges in schema public
  grant all on sequences to service_role;
