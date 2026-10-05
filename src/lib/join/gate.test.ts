import assert from "node:assert/strict";
import { test } from "node:test";

import { joinOpen } from "./gate.ts";

/**
 * The launch switch is closed unless it is opened exactly.
 *
 * Both directions are tested because both are load-bearing. Left open by
 * accident, a founder pastes a live Stripe key into a flow that is being held
 * back. Left closed by accident, the site tells everybody to come back later.
 * The first is the one worth being paranoid about, which is why almost every
 * case below is asserted to be closed.
 *
 * The function takes its environment as an argument rather than reading
 * `process.env` itself, so none of this mutates the real process.
 */

test("absent means closed", () => {
  assert.equal(joinOpen({}), false);
});

test("only the exact string true opens it", () => {
  assert.equal(joinOpen({ JOIN_OPEN: "true" }), true);
});

test("every near miss stays closed", () => {
  for (const value of [
    "TRUE",
    "True",
    "1",
    "yes",
    "on",
    " true",
    "true ",
    "true\n",
    "",
  ]) {
    assert.equal(joinOpen({ JOIN_OPEN: value }), false, JSON.stringify(value));
  }
});

test("a value of closed is closed", () => {
  // Somebody will inevitably set it to "false" to shut the door. That has to
  // mean shut, not "a string, therefore on".
  assert.equal(joinOpen({ JOIN_OPEN: "false" }), false);
});

test("it is not a required variable", () => {
  // Its absence is a valid configuration rather than an error, which is what
  // makes it safe to leave unset in every environment.
  assert.doesNotThrow(() => joinOpen({}));
});
