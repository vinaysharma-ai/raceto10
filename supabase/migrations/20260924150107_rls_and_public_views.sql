-- raceto10 — row-level security, public read surface, realtime publication
--
-- Implements SYSTEM-ARCHITECTURE.md §8 and §11.
--
-- ## The posture
--
-- Two trust zones. The browser holds only the publishable key; the server holds
-- the service key. This file draws the line between them:
--
--   * No base table grants `anon` anything except where Realtime requires it.
--   * Anything that must be publicly readable but has private columns is
--     exposed through a view listing only the safe columns.
--   * Nothing grants `anon` a write, anywhere, on anything.
--
-- ## Why some views use owner's rights
--
-- A view created with `security_invoker = false` (the PostgreSQL default, kept
-- here deliberately) executes with the privileges of its owner — `postgres` in
-- a Supabase migration — and therefore bypasses RLS on the underlying table.
-- Supabase's own guidance warns about this, and it is normally a footgun.
--
-- It is used here on purpose, and the view's column list IS the security
-- boundary: `racer_public` can read `racer` precisely because RLS would block
-- `anon` completely, and it hands back only the columns listed. The alternative,
-- a policy letting `anon` select from `racer`, would grant every column on the
-- table, including email and the baseline.
--
-- `waitlist_stats` depends on the same behaviour for a different reason: an
-- invoker-rights view would be RLS-filtered to `0`, and the landing page would
-- quietly display a false number.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

-- Enabling RLS with no policy denies everything. That is the intended starting
-- point: every access below is granted explicitly, so a table added later is
-- private until someone decides otherwise.
alter table racer                 enable row level security;
alter table race_event            enable row level security;
alter table race_baseline_customer enable row level security;
alter table race_customer         enable row level security;
alter table waitlist_signup       enable row level security;
alter table sponsor_slot          enable row level security;
alter table sponsorship           enable row level security;
alter table sponsor_pricing       enable row level security;

-- ---------------------------------------------------------------------------
-- Strip the default grants
-- ---------------------------------------------------------------------------

-- Supabase's default privileges hand new tables in `public` to anon and
-- authenticated. RLS already blocks the rows, but leaving the grants in place
-- means the only thing standing between the browser and a table is one policy
-- someone might add later. Remove them so the privilege itself is absent.
revoke all on table
  racer,
  race_event,
  race_baseline_customer,
  race_customer,
  waitlist_signup,
  sponsor_slot,
  sponsorship,
  sponsor_pricing
from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- The server keeps full access. service_role bypasses RLS by design; the guard
-- against misuse is `import "server-only"` in src/lib/env.server.ts, which turns
-- an accidental client import into a build error rather than a leak.
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Public read surface
-- ---------------------------------------------------------------------------

-- Race progress is public: it is the product. The baseline is not — it exists
-- only so that "10 customers" means "10 NEW customers", and publishing it would
-- hand every competitor a racer's starting position.
--
-- connection_state is included so a future public race surface can disclose a
-- frozen count rather than presenting it as live. SYSTEM-ARCHITECTURE.md §4
-- requires that disclosure; without this column there would be no way to make it.
--
-- `create or replace` rather than `create`: migration tracking already prevents
-- a double-apply, but these are also likely to be pasted into the Supabase SQL
-- editor during first-time setup, and a later `db push` would then collide.
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
  created_at
from racer;
-- Deliberately absent: email, verification_provider, provider_account_id,
-- provider_credential_ref, provider_credential_expires_at, baseline_customer_count,
-- baseline_captured_at, connect_state, connect_state_expires_at, count_reconciled_at,
-- connection_revoked_at.

create or replace view race_event_public
with (security_invoker = false) as
select id, racer_id, type, customer_number, created_at
from race_event;

-- `visit_public` was removed with the `visit` table. Visitor locations are not
-- part of this product; the globe plots racers, from `racer.latitude` and
-- `racer.longitude`, not page views.

-- What the sponsor bars and the `/sponsor` grid render.
--
-- A position with no row here is FREE — the absence is the state, not a hidden
-- row. Free-ness is computed from time rather than stored on the position, so
-- nothing has to run for a sponsorship to end.
create or replace view sponsorship_live
with (security_invoker = false) as
select
  s.id,
  s.slot_id,
  sl.slot_number,
  sl.placement,
  s.starts_at,
  s.ends_at,
  s.term_days,
  s.sponsor_name,
  s.sponsor_description,
  s.sponsor_logo_url,
  s.sponsor_link
from sponsorship s
join sponsor_slot sl on sl.id = s.slot_id
where s.status = 'confirmed'
  and now() >= s.starts_at
  and now() < s.ends_at;

-- The landing page's live founder count. Owner's rights, so the count is real
-- rather than RLS-filtered to zero — and only the count crosses the boundary.
-- The emails never leave the table.
create or replace view waitlist_stats
with (security_invoker = false) as
select count(*)::integer as total from waitlist_signup;

grant select on
  racer_public,
  race_event_public,
  sponsorship_live,
  waitlist_stats
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

-- Correction to the published design, recorded here because it changes the
-- shape of the grants above.
--
-- SYSTEM-ARCHITECTURE.md §11 says the client reads the public views. Realtime's
-- postgres_changes, however, is a replication feature: it can only publish
-- TABLES, and it enforces RLS per subscriber. A view cannot be published, and a
-- subscriber with no SELECT on the underlying table receives nothing.
--
-- So for the published tables the base table itself must be readable, which
-- means granting `anon` a real SELECT and a matching policy. This is only
-- acceptable because neither carries a secret — `race_event` has none, and
-- `sponsorship` is held to that standard by a warning at the top of its
-- definition, which is why no sponsor contact address is a column there.
grant select on sponsorship, race_event to anon, authenticated;

-- The price list is public by design: a sponsor needs to see what a term costs
-- before deciding to buy one. Nothing here is per-customer.
grant select on sponsor_pricing to anon, authenticated;

-- Only CONFIRMED bookings are readable, not every row.
--
-- A `pending` booking is someone mid-checkout who has not paid. Their name,
-- description and link are things they intend to publish, but publishing them
-- minutes *before* payment — and leaving them visible if they abandon — would
-- mean a sponsor's copy appearing on the site without them having bought
-- anything. RLS is the right place to stop that, because Realtime enforces it
-- per subscriber too.
--
-- The consequence, stated plainly: a position under an active hold still reads
-- as free to everyone else, and a competing buyer is refused by the exclusion
-- constraint at the moment of booking rather than being warned in advance. That
-- is a rare "sorry, just taken" in exchange for never publishing unpaid content.
drop policy if exists sponsorship_public_read on sponsorship;
create policy sponsorship_public_read on sponsorship
  for select to anon, authenticated
  using (status = 'confirmed');

drop policy if exists sponsor_pricing_public_read on sponsor_pricing;
create policy sponsor_pricing_public_read on sponsor_pricing
  for select to anon, authenticated
  using (true);

drop policy if exists race_event_public_read on race_event;
create policy race_event_public_read on race_event
  for select to anon, authenticated
  using (true);

-- Publish only what is safe to broadcast in full. racer and waitlist_signup are
-- never added here.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sponsorship'
    ) then
      alter publication supabase_realtime add table public.sponsorship;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'race_event'
    ) then
      alter publication supabase_realtime add table public.race_event;
    end if;
  end if;
end $$;
