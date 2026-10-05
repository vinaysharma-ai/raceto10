-- NOT A MIGRATION. Do not move this into `supabase/migrations`.
--
-- `supabase db push` reads `supabase/migrations` and nothing else, so this file
-- is deliberately parked outside it: it changes what the public can read, and
-- that change belongs to the phase that builds the surface needing it.
--
-- ## What this does, when it is applied
--
-- Republishes `public_racers` with `product_url`, so the racer page can link to
-- the product being raced. That link is the reader's ability to check the count
-- against the thing being counted, which is the whole reason the URL is
-- collected.
--
-- ## Why it is not applied yet
--
-- `racer.product_url` exists and is being filled in by the join step. Nothing
-- reads it publicly, because nothing has a page to show it on — `/r/[handle]` is
-- the racer page, and it is not built. Adding the column to the view now would
-- widen what an anonymous visitor can read for no benefit at all, and every
-- widening is one more thing to reason about.
--
-- ## Recreate, not alter
--
-- Postgres cannot add a column to the middle of an existing view, and
-- `create or replace` requires the same column list in the same order. Every
-- other column is reproduced exactly as it was and the `where` clause is
-- unchanged: this must not widen consent, only carry one more column that the
-- founder has already agreed to publish.
--
-- `public_search` is deliberately left alone. It is narrower than the board by
-- design, and an address is not something a substring query should probe for.

create or replace view public_racers
with (security_invoker = false) as
select
  r.public_slug,
  p.name                              as founder_name,
  p.x_handle,
  r.product_name,
  r.product_url,
  r.status,
  r.current_customer_count,
  r.activated_at,
  r.race_end_at,
  r.reached_ten_at,
  r.created_at,
  r.city,
  r.country,
  r.latitude,
  r.longitude
from racer r
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;
