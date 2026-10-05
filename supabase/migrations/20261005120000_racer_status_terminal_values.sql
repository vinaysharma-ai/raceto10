-- Two terminal states the race rules describe and the enum cannot express.
--
-- ## Why these are needed
--
-- Phase 5: a racer who passed the gate at registration and fails it again at
-- activation is moved to `ineligible` and their key is deleted. Left as `ready`,
-- they would sit in the activation batch forever, re-checked every time the
-- owner runs it, and the board would count them as waiting for a clock that is
-- never going to start.
--
-- Phase 6: a race whose window closes with fewer than ten customers is
-- `expired`. Left as `racing`, its clock would keep being compared against
-- `ends_at` on every poll, and every public surface would show a race that
-- ended as one still running. `finished` is not the right value for it: that
-- word means ten customers, and using it for a race nobody won would make the
-- board's one unambiguous claim ambiguous.
--
-- ## Irreversible, which is why this is not pushed
--
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`. Adding a value cannot be
-- undone; the only way back is to recreate the type, which means rewriting every
-- column that uses it and every index and constraint over those columns. That
-- is a different class of change from adding a nullable column, and it is why
-- this one stops for a decision rather than being applied alongside the others.
--
-- ## Additive
--
-- Two `add value if not exists` statements. Nothing is dropped, renamed,
-- reordered or repointed. Existing rows keep their current status, and a
-- database with no racers in either state looks exactly the same afterwards.
--
-- `if not exists` rather than a bare `add value`, because a migration that has
-- been run once must not fail if it is ever replayed against a database that
-- already has the value.

alter type racer_status add value if not exists 'ineligible';

alter type racer_status add value if not exists 'expired';
