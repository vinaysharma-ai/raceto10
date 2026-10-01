-- raceto10 — a founder may read and edit their own profile, and only their own
--
-- `20260928120200` enabled RLS on `profiles` and revoked every grant, which is
-- the right default: a table is private until somebody decides otherwise. This
-- adds the one exception the product needs.
--
-- ## What is granted, and what deliberately is not
--
--   SELECT  own row only
--   UPDATE  own row only, and the new row must still be their own
--   INSERT  nobody — rows are created server-side by the OAuth callback
--   DELETE  nobody
--
-- The missing INSERT is the load-bearing one. If a client could insert, it
-- could create a profile for an id that is not its own, and
-- `racer.profile_id` would then point at a row it controls — which is the
-- beginning of racing under somebody else's identity. Profiles are created by
-- the callback with the service role, keyed on the id Supabase authenticated.
--
-- The `with check` on UPDATE matters for the same reason as the `using` clause
-- and is not redundant: `using` decides which rows may be updated, `with check`
-- decides what they may be updated *to*. Without it, a user could rewrite their
-- own row's id to somebody else's and hand it away.

-- Column-level grants, not a table-level UPDATE.
--
-- The first version of this migration allowed `update` on the whole table and
-- used a trigger calling `auth.uid()` to put `deleted_at` back. That was worse
-- in three ways: it needed the invoking role to hold rights on the `auth`
-- schema, it raised a question about `SECURITY DEFINER` that has no good
-- answer in a trigger, and it made a founder's ability to clear their own
-- deletion flag depend on a function someone could later drop.
--
-- Naming the writable columns puts the restriction in the privilege system,
-- where it cannot be forgotten. `id`, `created_at`, `updated_at` and
-- `deleted_at` are not in the list, so no statement from this role can touch
-- them — no trigger required, and nothing to keep in step.
revoke all on table profiles from authenticated;

grant select on table profiles to authenticated;
grant update (name, email, x_handle, avatar_url) on table profiles to authenticated;

drop policy if exists profiles_read_own on profiles;
create policy profiles_read_own on profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- `anon`, and anyone unauthenticated, still has no grant at all. That is
-- asserted by the verification script rather than assumed.
