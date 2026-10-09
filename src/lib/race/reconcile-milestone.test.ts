import assert from "node:assert/strict";
import { test } from "node:test";

import { LOST_CONNECTION_STATUS, milestoneOf } from "./reconcile.ts";

/**
 * The two values the reconcile path used to write that the database rejects.
 *
 * ## Why these are unit tests and not integration tests
 *
 * Both bugs are the same shape: the code produced a value, and a CHECK
 * constraint on the hosted table refused the row. Nothing in the repository
 * could see the constraint, so nothing caught it — the failure only appeared
 * once, at runtime, as a `23514` wearing the costume of a storage error.
 *
 * The constraints are restated here so that a change to either constant fails
 * loudly in CI rather than quietly at Stripe. The database is still the real
 * enforcement; this is the alarm that goes off first.
 */

/** `race_event_customer_number_range`. */
function violatesMilestoneRange(value: number | null): boolean {
  return !(value === null || (value >= 1 && value <= 10));
}

/** `provider_connections_status_known`, copied from the hosted database. */
const ALLOWED_CONNECTION_STATUS = ["pending", "connected", "invalid", "revoked", "unavailable"];

// ---------------------------------------------------------------------------
// The milestone
// ---------------------------------------------------------------------------

test("no count can produce a milestone the column would reject", () => {
  // The property, over a range wider than any race can reach. Every caller
  // passes its count through `milestoneOf`, so this is the whole produced set.
  for (let count = -10; count <= 60; count += 1) {
    const milestone = milestoneOf(count);
    assert.equal(
      violatesMilestoneRange(milestone),
      false,
      `milestoneOf(${count}) = ${milestone}, which the CHECK refuses`,
    );
  }
});

test("zero is the absence of a milestone, which is the expired and lost paths", () => {
  // A race that expired having sold nothing, or whose key died before its first
  // customer. Both used to write 0 and both were refused.
  assert.equal(milestoneOf(0), null);
  assert.equal(milestoneOf(-1), null);
});

test("the tenth customer is the last rung", () => {
  assert.equal(milestoneOf(1), 1);
  assert.equal(milestoneOf(9), 9);
  assert.equal(milestoneOf(10), 10);

  // A window that gained four customers reached ten, not fourteen. The feed
  // reads this back as "reached N of 10", so an unclamped 14 prints "14 of 10".
  assert.equal(milestoneOf(11), 10);
  assert.equal(milestoneOf(999), 10);
});

test("a non-finite count is no milestone rather than a broken write", () => {
  // Nothing should produce these, and a NaN reaching a Postgres integer column
  // is a different error in a different place. Null is the quiet answer.
  assert.equal(milestoneOf(Number.NaN), null);
  assert.equal(milestoneOf(Number.POSITIVE_INFINITY), null);
});

// ---------------------------------------------------------------------------
// The connection status
// ---------------------------------------------------------------------------

test("the status written when a key dies is one the column allows", () => {
  assert.ok(
    ALLOWED_CONNECTION_STATUS.includes(LOST_CONNECTION_STATUS),
    `LOST_CONNECTION_STATUS is ${LOST_CONNECTION_STATUS}, which connection_status does not allow`,
  );

  // The exact value that failed every time. Two runs a day, forever, with the
  // caller swallowing the error — the connection stayed `connected` for a key
  // Stripe had already refused.
  assert.notEqual(LOST_CONNECTION_STATUS, "broken");
});

test("it is not the status disconnect writes, because that is a different fact", () => {
  // Disconnect is the racer removing their own working key. This is the key
  // stopping. Collapsing them would make "you disconnected" and "your key died"
  // indistinguishable in the row.
  assert.notEqual(LOST_CONNECTION_STATUS, "revoked");
});
