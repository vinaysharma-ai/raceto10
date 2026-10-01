-- raceto10 — proof that a form submission resumes YOUR pending entry
--
-- ## The hole this closes
--
-- `/join` creates a racer row, then sends the browser to Stripe. If the racer
-- hesitates and closes the tab, the row is left in `registered` with their real
-- name, handle, product and location attached. When they come back and submit
-- the form again, the insert fails on the unique email — and the action used to
-- adopt the existing row on the strength of that email alone.
--
-- That meant anyone who knew a founder's email address could take over their
-- half-finished entry: connect their own Stripe account, and the race would
-- start and publish under the victim's identity. The victim could then never
-- register at all, because their email was permanently taken.
--
-- ## The fix
--
-- On the first submission the action mints a random proof, stores only its
-- SHA-256 hash here, and sets the raw value as an HttpOnly cookie. Resuming a
-- pending row requires presenting a value that hashes to what is stored — which
-- only the browser that started the registration has.
--
-- The hash, not the value, for the same reason credentials are hashed: read
-- access to this table must not hand over the ability to resume someone's
-- registration. It is a bearer token, so it is stored as one.
--
-- Two columns rather than reusing `connect_state`: that column guards the OAuth
-- *callback* and expires in 30 minutes, which is the right lifetime for a code
-- exchange and far too short for someone who steps away from the form. These
-- are different tokens with different lifetimes and different jobs.

alter table racer
  add column if not exists registration_proof_hash       text,
  add column if not exists registration_proof_expires_at timestamptz;

-- Both are deliberately absent from `racer_public`. That view lists its columns
-- explicitly, so adding these to the table does not widen it — which is the
-- reason it lists them explicitly.

comment on column racer.registration_proof_hash is
  'SHA-256 of the cookie proving the submitter started this registration. Never the raw value.';
