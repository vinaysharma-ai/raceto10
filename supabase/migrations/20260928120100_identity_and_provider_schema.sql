-- raceto10 — identity, provider connections, and the verification trail
--
-- Implements `02-BACKEND-SPEC.md` §3 as deltas over the existing history.
--
-- ## The shape change, and why it happens now
--
-- The existing `racer` table carries both identity (name, email, X handle) and
-- race participation (baseline, counts, window) in one row. The spec separates
-- them: `profiles` owns identity and hangs off `auth.users`, and `racer` owns
-- the participation.
--
-- That is done here rather than later because no environment has any rows yet —
-- the hosted project has never had these tables at all. Reshaping an empty
-- table is free; reshaping one with a launched cohort in it is a data migration
-- with a maintenance window.
--
-- ## What is NOT here
--
-- No `race_batches` and no `race_entries`. `02` §3 specifies both, and both are
-- built on the batch model — one shared `starts_at` for everyone. `00` states
-- that model is superseded: a qualifying founder joins whenever they qualify,
-- each racer gets an individual window beginning at their own activation, and
-- nobody waits for a later global batch. `01` §8 and `02` §9 still describe
-- batches; on the timing model, `00` wins and these two are stale.
--
-- So the authoritative timing fields live on the racer's own row
-- (`activated_at`, `race_end_at`), which is what `00` asks for and what the
-- existing schema already did.

-- ---------------------------------------------------------------------------
-- Superseded projections, dropped first
-- ---------------------------------------------------------------------------
--
-- `racer_public` and `race_activity` are built over the columns this migration
-- removes, so PostgreSQL refuses the `drop column` while they exist. They are
-- replaced by the views in the next migration under the names `02` §4 uses;
-- dropping them here rather than there is an ordering requirement, not a
-- stylistic choice.
--
-- Dropped rather than left alongside so there is exactly one way to read a
-- racer publicly — two views over the same rows is how one of them quietly
-- stops carrying the consent gate.
drop view if exists racer_public;
drop view if exists race_activity;
-- `race_event_public` is from the original RLS migration and selects
-- `race_event.type`, which this migration retypes. PostgreSQL will not alter a
-- column a view reads, so it goes too — the replacement is
-- `public_race_events`, which carries the consent gate its predecessor never
-- had.
drop view if exists race_event_public;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

-- One function rather than relying on every writer to remember. A column that
-- is only sometimes maintained is worse than no column, because it reads as
-- trustworthy.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — identity, one per authenticated person
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  email       text,
  x_handle    text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  -- Handles are typed by people and come back from X; both spellings of the
  -- same handle must not create two different-looking rows.
  constraint profiles_x_handle_shape
    check (x_handle is null or x_handle ~ '^[A-Za-z0-9_]{1,15}$')
);

create index if not exists profiles_email_idx on profiles (lower(email))
  where deleted_at is null;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- `email` and `id` are the private identity and are never published. The public
-- projection in the next migration lists its columns explicitly for that
-- reason.

-- ---------------------------------------------------------------------------
-- racer — reshape into participation
-- ---------------------------------------------------------------------------

-- Identity moves to `profiles`. Both columns are dropped rather than left
-- behind: two copies of a person's email is a drift waiting to happen, and the
-- whole point of the split is that there is one place identity lives.
--
-- `racer.email` currently carries the unique constraint and the registration
-- proof. Both go with it — the proof existed to authenticate a form
-- resubmission by email, which is exactly what auth replaces.
alter table racer
  drop constraint if exists racer_email_key;

alter table racer
  drop column if exists name,
  drop column if exists email,
  drop column if exists x_handle,
  drop column if exists handle,
  drop column if exists registration_proof_hash,
  drop column if exists registration_proof_expires_at,
  -- MRR is deferred by `00`: it needs currency normalisation to be honest.
  drop column if exists mrr_cents,
  -- Connect OAuth is superseded by a pasted restricted key. The account
  -- reference and credential pointer now live on `provider_connections`.
  drop column if exists verification_provider,
  drop column if exists provider_account_id,
  drop column if exists provider_credential_ref,
  drop column if exists provider_credential_expires_at,
  drop column if exists connection_revoked_at,
  -- The OAuth CSRF token has no meaning without OAuth.
  drop column if exists connect_state,
  drop column if exists connect_state_expires_at;

alter table racer
  add column if not exists profile_id uuid references profiles (id) on delete cascade,
  add column if not exists public_slug text,
  add column if not exists public_consent_at timestamptz,
  -- Renamed to the vocabulary `00` uses. `race_start_at` was the moment the
  -- clock began; `activated_at` is that same instant, named for the boundary
  -- the product now describes it by.
  add column if not exists activated_at timestamptz,
  add column if not exists reached_ten_at timestamptz;

-- Backfill before constraining: the table is empty in every environment, but a
-- migration that only works on an empty table is a migration that will fail the
-- first time it is not.
update racer
   set activated_at  = coalesce(activated_at, race_start_at),
       reached_ten_at = coalesce(reached_ten_at, won_at)
 where activated_at is null
    or reached_ten_at is null;

alter table racer
  drop column if exists race_start_at,
  drop column if exists won_at;

-- `public_slug` is the racer's public address, so it must be present and
-- unique. Generated server-side from the X handle at registration.
alter table racer
  drop constraint if exists racer_public_slug_key;
alter table racer
  add constraint racer_public_slug_key unique (public_slug);

alter table racer
  drop constraint if exists racer_public_slug_shape;
alter table racer
  add constraint racer_public_slug_shape
  check (public_slug is null or public_slug ~ '^[a-z0-9][a-z0-9_-]{1,39}$');

-- One racer per profile for V1. `00` treats a provider account as the thing
-- that gets one race, and a person may connect more than one provider — but the
-- public board ranks people, so a second concurrent entry for one person would
-- put the same founder on the board twice.
alter table racer
  drop constraint if exists racer_profile_key;
alter table racer
  add constraint racer_profile_key unique (profile_id);

-- The timing invariant, restated against the new column names.
alter table racer
  drop constraint if exists racer_window_ordered;
alter table racer
  add constraint racer_window_ordered
  check (activated_at is null or race_end_at is null or race_end_at > activated_at);

-- A race cannot be over before it began.
alter table racer
  drop constraint if exists racer_reached_ten_after_activation;
alter table racer
  add constraint racer_reached_ten_after_activation
  check (reached_ten_at is null or activated_at is null or reached_ten_at >= activated_at);

create index if not exists racer_profile_idx on racer (profile_id);
create index if not exists racer_activated_idx on racer (activated_at)
  where activated_at is not null;
create index if not exists racer_status_idx on racer (status);

-- ---------------------------------------------------------------------------
-- racer_status — align the vocabulary with `02` §2
-- ---------------------------------------------------------------------------

-- `registered -> ready -> racing -> finished`, plus the operational states the
-- spec names.
--
-- `won` and `expired` both become `finished`, because `02` defines finished as
-- "10 verified race customers **or** the window ended" — one terminal state
-- reached two ways. Nothing is lost: `reached_ten_at` says which way, and
-- `race_end_at` says when the window closed. Encoding the same fact in both the
-- status and a timestamp is how the two come to disagree.
alter table racer alter column status drop default;

-- This index has to go before the retype, and the reason is not obvious.
--
-- `racer_race_end_at_idx` is a *partial* index whose predicate is
-- `where status = 'racing'::racer_status`. Changing the column's type forces
-- PostgreSQL to re-parse that predicate, and comparing the new enum against the
-- old one has no operator — so the ALTER fails with
-- "operator does not exist: racer_status_v2 = racer_status", naming neither the
-- index nor the column. Dropping it first and recreating it afterwards against
-- the new type is the fix.
drop index if exists racer_race_end_at_idx;

create type racer_status_v2 as enum
  ('registered', 'ready', 'racing', 'finished',
   'verification_failed', 'withdrawn', 'disqualified');

-- A searched CASE, not `case status::text when 'won' ...`.
--
-- With the simple form PostgreSQL resolves the WHEN literals against the
-- *target* type of the expression rather than the operand, tries to build
-- `racer_status_v2 = racer_status`, and fails with "operator does not exist".
-- The searched form has no operand to compare against, so the mapping stays in
-- text where it belongs.
alter table racer
  alter column status type racer_status_v2
  using (
    case
      when status::text in ('won', 'expired') then 'finished'
      else status::text
    end
  )::racer_status_v2;

drop type racer_status;
alter type racer_status_v2 rename to racer_status;

alter table racer alter column status set default 'registered';

-- Recreated against the new enum. Same intent as before: the sweep that finds
-- races whose window has closed only ever looks at the ones still running.
create index if not exists racer_race_end_at_idx
  on racer (race_end_at)
  where status = 'racing';

-- Connection state now belongs to a provider connection, not to the racer:
-- a racer may connect Stripe and later Lemon Squeezy, and "the racer is
-- connected" would be ambiguous the moment there are two.
alter table racer drop column if exists connection_state;
drop type if exists connection_state;

-- ---------------------------------------------------------------------------
-- provider_connections — one row per connected payment account
-- ---------------------------------------------------------------------------

create table if not exists provider_connections (
  id                  uuid primary key default gen_random_uuid(),
  racer_id            uuid not null references racer (id) on delete cascade,
  provider            text not null,
  external_account_ref text,
  connection_status   text not null default 'pending',
  connected_at        timestamptz,
  last_verified_at    timestamptz,
  last_reconcile_at   timestamptz,
  error_code          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint provider_connections_provider_known
    check (provider in ('stripe', 'lemon_squeezy')),
  constraint provider_connections_status_known
    check (connection_status in ('pending', 'connected', 'invalid', 'revoked', 'unavailable')),

  -- One account, one race. `00` names this as the mitigation for the
  -- fresh-account gaming route: someone with customers elsewhere could connect
  -- a brand-new empty account, and this at least stops the same account being
  -- used for two entries.
  constraint provider_connections_account_key unique (provider, external_account_ref)
);

create index if not exists provider_connections_racer_idx
  on provider_connections (racer_id);
-- The reconciliation sweep's query: everything connected, oldest check first.
create index if not exists provider_connections_reconcile_idx
  on provider_connections (last_reconcile_at nulls first)
  where connection_status = 'connected';

drop trigger if exists provider_connections_set_updated_at on provider_connections;
create trigger provider_connections_set_updated_at
  before update on provider_connections
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_credentials — the vault
-- ---------------------------------------------------------------------------

-- The credential never travels through any other table, never appears in a
-- public view, and has no grant to anon or authenticated.
--
-- `encrypted_secret` holds base64 ciphertext, not `bytea`. The application
-- encrypts before it gets here; the column type is a storage detail, and base64
-- survives the PostgREST round trip without the byte-escape ambiguity that
-- makes a wrong value look like a right one.
create table if not exists provider_credentials (
  id                   uuid primary key default gen_random_uuid(),
  provider_connection_id uuid not null unique
    references provider_connections (id) on delete cascade,
  encrypted_secret     text not null,
  -- Which key encrypted this, so a rotation can re-encrypt without guessing.
  key_version          integer not null default 1,
  created_at           timestamptz not null default now(),
  rotated_at           timestamptz,

  constraint provider_credentials_key_version_positive check (key_version > 0)
);

-- ---------------------------------------------------------------------------
-- verification_snapshots — what RaceTo10 actually observed, and when
-- ---------------------------------------------------------------------------

create table if not exists verification_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  racer_id              uuid not null references racer (id) on delete cascade,
  provider_connection_id uuid not null references provider_connections (id) on delete cascade,
  captured_at           timestamptz not null default now(),
  customer_count        integer not null,
  mrr_minor             bigint,
  currency              text,
  verification_status   text not null,
  source                text not null,
  error_code            text,

  constraint verification_snapshots_count_non_negative check (customer_count >= 0),
  constraint verification_snapshots_status_known
    check (verification_status in ('eligible', 'ineligible', 'failed')),
  constraint verification_snapshots_source_known
    check (source in ('registration', 'activation', 'reconcile'))
);

create index if not exists verification_snapshots_racer_idx
  on verification_snapshots (racer_id, captured_at desc);

-- Append-only by convention and by grant: there is no update or delete policy
-- for anyone but the service role. This is the audit trail that makes a
-- downward correction explicable after the fact, so it must not be editable.

-- ---------------------------------------------------------------------------
-- reconciliation_runs — private operational log
-- ---------------------------------------------------------------------------

create table if not exists reconciliation_runs (
  id                     uuid primary key default gen_random_uuid(),
  provider_connection_id uuid not null references provider_connections (id) on delete cascade,
  started_at             timestamptz not null default now(),
  completed_at           timestamptz,
  status                 text not null default 'running',
  customer_count         integer,
  mrr_minor              bigint,
  error_code             text,

  constraint reconciliation_runs_status_known
    check (status in ('running', 'ok', 'failed'))
);

create index if not exists reconciliation_runs_connection_idx
  on reconciliation_runs (provider_connection_id, started_at desc);

-- ---------------------------------------------------------------------------
-- race_event — align the vocabulary
-- ---------------------------------------------------------------------------

-- The existing enum is ('started', 'milestone', 'won'); `02` §3 names the
-- events ('joined', 'activated', 'customer_milestone', 'finished'). Both
-- describe the same three moments plus a fourth, so the values are mapped
-- rather than a second event table being introduced.
--
-- A new type plus an ALTER, rather than `alter type ... add value`: adding
-- leaves the old spellings legal forever and the table would slowly hold two
-- vocabularies for one idea.
create type race_event_type_v2 as enum
  ('joined', 'activated', 'customer_milestone', 'finished');

alter table race_event
  alter column type type race_event_type_v2
  using (
    case type::text
      when 'started'   then 'activated'
      when 'milestone' then 'customer_milestone'
      when 'won'       then 'finished'
      else 'joined'
    end
  )::race_event_type_v2;

drop type race_event_type;
alter type race_event_type_v2 rename to race_event_type;

alter table race_event
  rename column type to event_type;

alter table race_event
  rename column customer_number to milestone_customer_count;

alter table race_event
  add column if not exists occurred_at timestamptz not null default now();

-- `02` §3 also lists `race_entry_id`. There are no race entries in the
-- per-racer model — the racer row is the participation — so the column would
-- always be null and is deliberately absent.

create index if not exists race_event_occurred_idx
  on race_event (occurred_at desc);
