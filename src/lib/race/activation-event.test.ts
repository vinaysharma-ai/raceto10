import assert from "node:assert/strict";
import { test } from "node:test";

import { activateRacer, type ActivationStore, type RacerState } from "./activate.ts";
import type {
  ExternalCustomer,
  MrrReading,
  VerificationProvider,
} from "../verification/types.ts";

/**
 * What activation records, and what it must not.
 *
 * ## The bug this exists for
 *
 * `race_event.milestone_customer_count` is constrained to `NULL or between 1
 * and 10` — it holds a *milestone* number. Activation wrote
 * `milestone_customer_count: 0`, because the baseline is zero customers. Zero
 * is not a milestone; it is the absence of one. Postgres refused the row with a
 * `23514`, the activation catch turned that into `storage_error`, and the racer
 * was left `racing` with a clock that had started and no event to show for it.
 *
 * The database constraint is the real enforcement and this file cannot reach
 * it. What it can do is hold the two halves that are ours: that the caller
 * cannot supply a count at all, and that the rule the column enforces really
 * does reject the value that was being sent.
 */

// ---------------------------------------------------------------------------
// The rule, restated
// ---------------------------------------------------------------------------

/** What `race_event_customer_number_range` accepts. */
function milestoneViolatesRange(value: number | null): boolean {
  return !(value === null || (value >= 1 && value <= 10));
}

test("zero is not a milestone, which is why activation sends none", () => {
  // The exact value that failed. If this ever reads as acceptable, the fix has
  // been undone somewhere the constraint will find it.
  assert.equal(milestoneViolatesRange(0), true);
  assert.equal(milestoneViolatesRange(null), false);

  // And the range itself, so the restatement is checked rather than asserted.
  assert.equal(milestoneViolatesRange(1), false);
  assert.equal(milestoneViolatesRange(10), false);
  assert.equal(milestoneViolatesRange(11), true);
  assert.equal(milestoneViolatesRange(-1), true);
});

// ---------------------------------------------------------------------------
// The fake provider
// ---------------------------------------------------------------------------

function refusing(): never {
  throw new Error("activation does not call this");
}

function fakeProvider(
  customers: ExternalCustomer[] = [],
  mrr: MrrReading = { known: true, mrrMinor: 0, currency: "usd" },
): VerificationProvider {
  return {
    id: "stripe",
    displayName: "Fake",
    capabilities: {
      connectionMethod: "credential_paste",
      consentScreen: false,
      credentialScope: "read_only",
      credentialExpires: false,
      credentialRotatable: true,
      webhookRegistration: "merchant",
      serverSideDateFilter: true,
      accountScoping: "documented",
    },
    beginConnection: refusing,
    completeConnection: refusing,
    validateConnection: refusing,
    revokeConnection: refusing,
    listPayments: refusing,
    verifyWebhook: refusing,
    async *listCustomers(): AsyncIterable<ExternalCustomer> {
      for (const customer of customers) yield customer;
    },
    async readMonthlyRecurringRevenue(): Promise<MrrReading> {
      return mrr;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake store
// ---------------------------------------------------------------------------

const RACER: RacerState = {
  id: "racer-1",
  status: "ready",
  activatedAt: null,
  raceEndAt: null,
  baselineCustomerCount: null,
};

function fakeStore(
  events: Array<Record<string, unknown>>,
  overrides: Partial<ActivationStore> = {},
): ActivationStore {
  return {
    currentRacerId: async () => RACER.id,
    loadRacer: async () => RACER,
    markIneligible: async () => {},
    deleteCredential: async () => {},
    loadEmailContext: async () => null,
    markEmailSent: async () => {},
    loadConnection: async () => ({
      id: "connection-1",
      status: "connected",
      accountId: "acct_fixture0000000000",
    }),
    latestRegistrationEligibility: async () => "eligible",
    raceDurationDays: async () => 7,
    beginActivation: async () => ({ won: true as const }),
    writeBaselineCustomers: async () => {},
    recordActivationSnapshot: async () => {},
    recordActivationEvent: async (input) => {
      events.push(input as unknown as Record<string, unknown>);
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

test("activation records an event that carries no customer number", async () => {
  const events: Array<Record<string, unknown>> = [];

  const outcome = await activateRacer(fakeStore(events), fakeProvider(), true);

  assert.equal(outcome.ok, true);
  assert.equal(events.length, 1, "activation should record exactly one event");

  const recorded = events[0];
  assert.equal(recorded.racerId, RACER.id);

  // The whole point. Any number here is a milestone number the column would
  // range-check, and the only number activation has is zero — which the column
  // rejects. Nothing numeric may travel on this call.
  const numbers = Object.entries(recorded).filter(([, value]) => typeof value === "number");
  assert.deepEqual(numbers, [], `a number reached the event: ${JSON.stringify(numbers)}`);

  assert.equal("customerCount" in recorded, false);
  assert.equal("milestoneCustomerCount" in recorded, false);
});

test("a racer whose baseline is not empty never reaches the event write", async () => {
  // Eligibility refuses a non-empty baseline, so this is the other half of
  // "the only number activation could send is zero".
  const events: Array<Record<string, unknown>> = [];
  const customer: ExternalCustomer = {
    externalId: "cus_existing",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const outcome = await activateRacer(fakeStore(events), fakeProvider([customer]), true);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");
  assert.equal(events.length, 0);
});
