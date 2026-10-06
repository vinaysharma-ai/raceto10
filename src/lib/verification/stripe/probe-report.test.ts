import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeShape,
  firstLine,
  maskAccountId,
  probeLines,
  probeRefusal,
} from "./probe-report.ts";

/**
 * The probe's deciding, and its printing.
 *
 * Both are pure, so both are testable without a network or a key. The two
 * properties worth being thorough about are the refusals — a probe that accepted
 * a live key would print a real founder's business to a terminal — and the rule
 * that a malformed response names the field and never echoes the payload.
 */

// ---------------------------------------------------------------------------
// What may be probed
// ---------------------------------------------------------------------------

test("a restricted test key is accepted", () => {
  assert.equal(probeRefusal("rk_test_" + "a".repeat(24)), null);
});

test("nothing else is", () => {
  for (const key of [
    "",
    "   ",
    "rk_live_" + "a".repeat(24),
    "sk_test_" + "a".repeat(24),
    "sk_live_" + "a".repeat(24),
    "pk_test_" + "a".repeat(24),
    "pk_live_" + "a".repeat(24),
    "whsec_" + "a".repeat(24),
    "not-a-key",
  ]) {
    assert.notEqual(probeRefusal(key), null, `${JSON.stringify(key.slice(0, 12))} was accepted`);
  }
});

test("a live restricted key is refused for being live, not for being restricted", () => {
  // It *is* `rk_`, so the general restricted test would pass it. The live check
  // has to come first or the message would be the wrong one — and the wrong
  // message here means somebody runs the probe against a real account.
  const refusal = probeRefusal("rk_live_" + "a".repeat(24));

  assert.match(refusal ?? "", /live/i);
  assert.match(refusal ?? "", /test mode only/i);
});

test("a full-access key is refused by name, so the person knows what they pasted", () => {
  // "That is not a valid key" would leave somebody pasting the same key again.
  assert.match(probeRefusal("sk_test_" + "a".repeat(24)) ?? "", /full-access/i);
});

test("a publishable key is refused by name too", () => {
  assert.match(probeRefusal("pk_test_" + "a".repeat(24)) ?? "", /publishable/i);
});

test("the refusal never contains the key it refused", () => {
  // The messages are shown in a terminal and may be pasted into a chat when
  // something goes wrong. Echoing the value back is the obvious mistake.
  for (const key of [
    "rk_live_" + "5".repeat(24),
    "sk_test_" + "5".repeat(24),
    "pk_test_" + "5".repeat(24),
    "whsec_" + "5".repeat(24),
  ]) {
    const refusal = probeRefusal(key) ?? "";
    assert.equal(refusal.includes(key), false);
    assert.equal(refusal.includes("5".repeat(16)), false);
  }
});

// ---------------------------------------------------------------------------
// Reading stdin
// ---------------------------------------------------------------------------

/** An async iterable over fixed lines, standing in for a readline interface. */
async function* lines(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

test("the first line is taken and trimmed", async () => {
  assert.equal(await firstLine(lines("  rk_test_abc  ")), "rk_test_abc");
});

test("lines after the first are ignored", async () => {
  // A pasted key followed by a trailing newline must not become two lines of
  // input, and the probe must not wait for the second.
  assert.equal(await firstLine(lines("rk_test_abc", "more", "more")), "rk_test_abc");
});

test("closing stdin without a newline is empty input, not a crash", async () => {
  // Ctrl+Z then Enter on Windows, Ctrl+D elsewhere. A naive implementation
  // returns undefined here and the refusal reads "undefined is not a key".
  assert.equal(await firstLine(lines()), "");
});

test("a blank line is empty input", async () => {
  assert.equal(await firstLine(lines("   ")), "");
});

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

test("an account reference is masked in the middle", () => {
  const masked = maskAccountId("acct_1AbCdEfGhIjKlMnO");

  // Seven from the front, four from the back, and the middle — the part that
  // identifies a real business — never printed.
  assert.equal(masked, "acct_1A…lMnO");
  assert.equal(masked.startsWith("acct_"), true);
  assert.equal(masked.includes("DfGhIj"), false, "the middle was printed");
});

test("a short account reference is not mangled", () => {
  assert.equal(maskAccountId("acct_short"), "acct_short…");
});

test("a malformed response names the field, never the payload", () => {
  // The rule. A charge carries a customer id, an amount, and often a
  // description containing somebody's name.
  const payload = { id: "ch_1", customer: "cus_secret", description: "Ada Lovelace" };
  const message = describeShape("charge.customer", payload.customer, "a string when present");

  assert.equal(message.includes("cus_secret"), false);
});

test("a missing field and a wrong-typed field read differently", () => {
  // "Missing" means we asked for something the API does not send; "wrong type"
  // means it sent something unexpected. Different diagnoses, different fixes.
  assert.match(describeShape("id", undefined, "a string"), /missing/);
  assert.match(describeShape("id", 42, "a string"), /number/);
  assert.match(describeShape("id", [], "a string"), /array/);
});

test("the report carries counts and no identifiers", () => {
  const printed = probeLines({
    keyMode: "test",
    account: "acct_1A…KlMnO",
    eligible: false,
    reason: "has_customers",
    payingCustomers: 3,
    chargesConsidered: 5,
    refundedExcluded: 1,
    withoutCustomer: 1,
  }).join("\n");

  for (const forbidden of ["cus_", "ch_", "pi_", "email", "@"]) {
    assert.equal(printed.includes(forbidden), false, `the report printed ${forbidden}`);
  }
  assert.match(printed, /paying customers\s+3/);
  assert.match(printed, /eligible\s+no/);
});
