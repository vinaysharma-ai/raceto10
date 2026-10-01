-- raceto10 — the ten sponsor positions, and the launch price list
--
-- A position carries no price and no status. It is one of ten, permanently; the
-- booking that currently occupies it lives in `sponsorship`.
--
-- Seeded by migration rather than by application code, so the positions exist
-- before anything can try to render them and a fresh environment is identical
-- to production.
--
-- ## OPEN QUESTION — mobile placement
--
-- `placement` is a single value, but the design system puts each slot in two
-- places at once: a desktop rail (one of two sides) AND a mobile bar (top or
-- bottom). One column cannot express both.
--
-- The reading used here: `placement` records the DESKTOP side, and the mobile
-- bar is derived from slot_number (1-5 -> bar-top, 6-10 -> bar-bottom). That
-- leaves the `bar-top` and `bar-bottom` enum values unseeded.
--
-- The alternative — giving each position a mobile placement too — needs either
-- a second column or an array, which changes the schema. Flagged rather than
-- guessed.

insert into sponsor_slot (slot_number, placement)
values
  (1,  'sidebar-left'),
  (2,  'sidebar-left'),
  (3,  'sidebar-left'),
  (4,  'sidebar-left'),
  (5,  'sidebar-left'),
  (6,  'sidebar-right'),
  (7,  'sidebar-right'),
  (8,  'sidebar-right'),
  (9,  'sidebar-right'),
  (10, 'sidebar-right')
on conflict (slot_number) do nothing;

-- ---------------------------------------------------------------------------
-- Launch pricing
-- ---------------------------------------------------------------------------

-- Founding prices, expected to change once there is real traffic and real
-- sponsor demand to price against. They live here — not in a constant, not in
-- UI copy — so changing them is an UPDATE rather than a deploy.
--
-- `do nothing` on conflict, deliberately: a replayed migration must never
-- clobber a price that has since been changed in production.
insert into sponsor_pricing (term_days, price_cents)
values
  (1, 500),    -- $5
  (3, 1200),   -- $12
  (7, 2500)    -- $25
on conflict (term_days) do nothing;
