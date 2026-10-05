-- Two event types Phase 6 needs and the enum cannot express.
--
-- ## `expired`
--
-- A race whose window closed with fewer than ten customers. It is written so the
-- public timeline can say the race ended rather than leaving the last thing on
-- the page being a start with nothing after it. A board that quietly drops the
-- founders who did not make it is not a record of anything, and the event is how
-- the record stays complete.
--
-- ## `connection_lost`
--
-- A key that Stripe refused with a 401 or a permission error. The count is
-- frozen at its last reconcile and the connection is marked broken; this is the
-- event that says so in public. Without it the racer's row would simply stop
-- moving, and a stopped number with no explanation is indistinguishable from a
-- racer who has stopped selling.
--
-- ## Not `ineligible`
--
-- That would be the event for a racer who fails the gate at activation, and it
-- is deliberately not here. It is a different change with a different reason,
-- and folding it in would make this migration do two things.
--
-- ## Additive, and still irreversible
--
-- Two `add value if not exists` statements. Nothing is dropped, renamed or
-- reordered, and no existing row changes. As with `racer_status`, PostgreSQL has
-- no `ALTER TYPE ... DROP VALUE` — if either value turns out to be wrong, the
-- only way back is to recreate the type.

alter type race_event_type add value if not exists 'expired';

alter type race_event_type add value if not exists 'connection_lost';
