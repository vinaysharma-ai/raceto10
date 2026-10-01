import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEligibility, describeIneligibility, type EligibilityFacts } from "./eligibility.ts";

/**
 * The entry gate.
 *
 * The case worth reading first is `mrr_unknown`. Treating an unreadable MRR as
 * zero would admit exactly the person the gate exists to stop, so it is a
 * refusal — and these tests pin that rather than leaving it to the reader to
 * infer from the implementation.
 */

const eligibleFacts: EligibilityFacts = { existingCustomers: 0, mrrMinor: 0 };

test("zero customers and zero MRR enters", () => {
  assert.deepEqual(checkEligibility(eligibleFacts), { eligible: true });
});

test("one existing customer is refused", () => {
  assert.deepEqual(checkEligibility({ ...eligibleFacts, existingCustomers: 1 }), {
    eligible: false,
    reason: "has_customers",
  });
});

test("any positive MRR is refused, at the smallest unit", () => {
  // One cent. The boundary is 0, not "a meaningful amount" — a product that
  // charges anything at all is not starting from zero.
  assert.deepEqual(checkEligibility({ existingCustomers: 0, mrrMinor: 1 }), {
    eligible: false,
    reason: "has_mrr",
  });
});

test("a large existing customer count is refused", () => {
  assert.deepEqual(checkEligibility({ existingCustomers: 5000, mrrMinor: 0 }), {
    eligible: false,
    reason: "has_customers",
  });
});

test("unknown MRR is refused, not treated as zero", () => {
  // The important one. A restricted key that cannot read subscriptions cannot
  // report MRR, and a racer with a hundred subscribers could otherwise pass.
  assert.deepEqual(checkEligibility({ existingCustomers: 0, mrrMinor: null }), {
    eligible: false,
    reason: "mrr_unknown",
  });
});

test("customers are reported before MRR when both fail", () => {
  // Ordering is for the message, not the outcome. Someone with customers is
  // told about the customers, because that is the fact they can act on.
  assert.deepEqual(checkEligibility({ existingCustomers: 3, mrrMinor: 5000 }), {
    eligible: false,
    reason: "has_customers",
  });
});

test("negative values do not accidentally qualify anyone incorrectly", () => {
  // Not reachable through the counts, but a refund-heavy month could produce a
  // negative sum, and `> 0` must not treat it as revenue.
  assert.deepEqual(checkEligibility({ existingCustomers: 0, mrrMinor: -500 }), {
    eligible: true,
  });
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

test("every refusal has a sentence, and none of them is empty", () => {
  for (const reason of ["has_customers", "has_mrr", "mrr_unknown"] as const) {
    const message = describeIneligibility(reason);
    assert.ok(message.length > 20, reason);
    // A gate whose explanation is a stack trace or a status code is a gate
    // people reasonably distrust.
    assert.equal(/undefined|null|NaN/.test(message), false, reason);
  }
});

test("the unknown-MRR message says what to do about it", () => {
  // It is the one refusal the racer can fix themselves, so it has to name the
  // fix rather than only the problem.
  assert.match(describeIneligibility("mrr_unknown"), /Subscriptions/);
});
