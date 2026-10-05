-- `public_racers` publishes the product URL.
--
-- ## What this adds, and what it does not
--
-- One column: `r.product_url`, appended to the end of the existing list. Every
-- other column is reproduced exactly as it was and the `where` clause is
-- unchanged, so this does not widen consent — it carries one more column the
-- founder already agreed to publish.
--
-- The URL is not private and was never intended to be. It is the reader's
-- ability to check a count against the thing being counted, which is the whole
-- reason the column is collected: a number nobody can go and look at is a number
-- taken on trust.
--
-- ## Why `create or replace` and not `alter view`
--
-- Postgres cannot add a column to a view in place. `create or replace` requires
-- the same column list in the same order, so a new column may only be appended —
-- and this file learned that the hard way. The first version put `product_url`
-- after `product_name`, and the push failed with:
--
--     cannot change name of view column "status" to "product_url"
--
-- which is the server saying precisely what the comment above it had already
-- said. Appending is the only shape that works.
--
-- ## `public_search` is deliberately untouched
--
-- It is narrower than the board by design. An address is not something a
-- substring query should be able to probe for, and adding it there would turn
-- every search into a way to enumerate sites.

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
  r.latitude,
  r.longitude,
  -- Appended. See the note above; anything else fails.
  r.product_url
from racer r
join profiles p on p.id = r.profile_id
where r.public_consent_at is not null
  and p.deleted_at is null;
