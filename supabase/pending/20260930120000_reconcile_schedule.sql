-- FALLBACK, NOT A MIGRATION. Do not move this back into `supabase/migrations`.
--
-- `supabase db push` reads `supabase/migrations` and nothing else, so this file
-- sits outside it on purpose. It is kept rather than deleted because it is the
-- documented alternative if GitHub Actions ever stops being an option.
--
-- ## Why it is not applied
--
-- The GitHub Actions workflow in `.github/workflows/reconcile.yml` is the
-- scheduler. It runs the same `*/30 * * * *`, needs no extension, needs no Vault
-- secret, and is already live. Applying this as well would not make the counts
-- wrong — reconciliation is idempotent by design, which is the property the
-- whole design rests on — but it would double the reads against every racer's
-- Stripe account every half hour, for no benefit.
--
-- It also fails the additive-only rule this repository holds migrations to: it
-- installs two extensions, creates a `security definer` function, revokes
-- privileges, and schedules a recurring job.
--
-- ## To use it instead of GitHub Actions
--
-- Move this file back into `supabase/migrations`, store the two Vault secrets
-- (`reconcile_app_url`, `reconcile_cron_secret`), disable the GitHub workflow,
-- then push. Doing one without the other is the double-polling case above.
--
-- ---------------------------------------------------------------------------
--
-- raceto10 — the reconciliation poll, on Supabase's own scheduler.
--
-- `02` §237: "Preferred: Supabase `pg_cron` + `pg_net` if available."
-- `00` §63 agrees and adds that Vercel Hobby cron is daily at best, which is
-- why this exists at all.
--
-- ## PREPARED, NOT PUSHED
--
-- Both extensions are *available* on the project — `pg_available_extensions`
-- lists them — but neither is installed (`installed_version` is null), so
-- enabling them is a schema change and needs approval.
--
-- The GitHub Actions workflow in `.github/workflows/reconcile.yml` covers the
-- same ground with no migration, and is already live. This file is the
-- preferred path once it is approved; running both would double the polling.
--
-- ## Before this is pushed: two Vault secrets
--
-- ## The secret is deliberately not in this file
--
-- A migration is a committed artefact. Putting the cron secret or the
-- deployment URL in one would put both in the repository forever, and the
-- secret would then be in every clone, every fork, and every CI log that prints
-- a migration — which is the opposite of what `02` §257 asks for.
--
-- So the values live in Supabase Vault and are read at call time. Two secrets
-- must exist before this migration is applied, added through the dashboard
-- (**Project → Vault → New secret**), never through this file:
--
--     reconcile_app_url        the deployment origin, no trailing slash,
--                              e.g. https://raceto10.lol
--     reconcile_cron_secret    the same value as CRON_SECRET in Vercel,
--                              generated with `openssl rand -hex 32`
--
-- The function raises a named error if either is missing, so a
-- half-configured project fails loudly on the first tick rather than posting to
-- a null URL every thirty minutes and looking healthy.

-- ---------------------------------------------------------------------------
-- 1. The extensions
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

-- `with schema extensions` matches Supabase's own convention and keeps
-- `net.http_post` out of the public schema, where PostgREST would otherwise
-- consider exposing it as an RPC endpoint.
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. The trigger
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, because the job runs as `postgres` but reads from Vault,
-- and the privileges for that should not depend on who owns the schedule.
--
-- `set search_path = ''` is the hardening that makes SECURITY DEFINER safe: it
-- removes the ability for anyone who can create objects to shadow a function
-- this one calls. The cost is that every name below must be fully qualified,
-- which is why `vault.`, `net.` and `pg_catalog.` appear throughout.
create or replace function public.trigger_reconcile()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_url text;
  cron_secret text;
  request_id bigint;
begin
  select s.decrypted_secret into app_url
    from vault.decrypted_secrets s
   where s.name = 'reconcile_app_url';

  select s.decrypted_secret into cron_secret
    from vault.decrypted_secrets s
   where s.name = 'reconcile_cron_secret';

  if app_url is null or cron_secret is null then
    raise exception
      'Reconcile scheduler is not configured. Add both Vault secrets '
      '(reconcile_app_url, reconcile_cron_secret) before enabling the schedule.';
  end if;

  select net.http_post(
    url := app_url || '/api/cron/reconcile',
    -- The route compares this in constant time against CRON_SECRET, so a wrong
    -- value here produces a 401 on every tick rather than an open endpoint.
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::pg_catalog.jsonb,
    timeout_milliseconds := 300000
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.trigger_reconcile() is
  'Posts to /api/cron/reconcile with the Vault-held cron secret. Called by pg_cron; not exposed to PostgREST.';

-- Not callable by a browser. The route is the boundary that does the work, and
-- this function is only a way to reach it — but an anon-callable function that
-- fires an HTTP request to our own API is an amplification vector regardless of
-- what is behind it.
revoke all on function public.trigger_reconcile() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The schedule
-- ---------------------------------------------------------------------------

-- Unschedule first so re-running this migration replaces the job rather than
-- adding a second one. Two jobs firing the same endpoint would double the
-- provider calls for no benefit — the work is idempotent, so the second run
-- would find nothing and cost Stripe rate limit for the privilege.
do $$
begin
  perform cron.unschedule('raceto10-reconcile');
exception
  when others then null;  -- no such job; nothing to remove
end $$;

select cron.schedule(
  'raceto10-reconcile',
  '*/30 * * * *',
  $$select public.trigger_reconcile()$$
);
