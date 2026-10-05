-- The product URL a founder is racing.
--
-- ## Why this is needed
--
-- The join step asks for the product's address, and there was nowhere to put it.
-- `racer` had a `product_name` and no URL, so the field either had to be dropped
-- from the form or given a column. It is given a column, because the URL is not
-- decoration: it is one of the three things that keep this product honest about
-- what it is measuring.
--
--        A count is only evidence if a reader can go and look at the thing
--        being counted.
--
-- The other two are the one-race-per-provider-account constraint and the
-- live-mode-only key rule. All three exist so that a number on the board can be
-- checked rather than taken on trust.
--
-- ## Why `https` and not `http`
--
-- This is published as a link. A plain-`http` address is one an intermediary can
-- rewrite, and the reader has no way to tell. The constraint refuses anything
-- else at the database, so a path that forgets to validate cannot store a
-- `javascript:` URL that the board would then render as an anchor.
--
-- The column is nullable on purpose. Founders who registered before this
-- migration have none, and back-filling a URL we do not know would be inventing
-- one. The join form requires it for everybody who registers after this point;
-- the database permits null so that older rows stay valid rather than being
-- given a placeholder that looks real.
--
-- ## Scope
--
-- This migration adds one column and one constraint on it. It does not publish
-- the column — `public_racers` is deliberately untouched, so nothing about what
-- is public changes here. Exposing it on the board is a separate change, written
-- and held for the phase that builds the racer page.

alter table racer
  add column if not exists product_url text;

alter table racer
  add constraint racer_product_url_shape
  check (
    product_url is null
    or (product_url ~ '^https://' and length(product_url) <= 300)
  );

comment on column racer.product_url is
  'The public address of the product being raced. Null for entries registered before this column existed. Collected so a reader can verify a count against the product itself; not yet published on any view.';
