import assert from "node:assert/strict";
import { test } from "node:test";

import { RECONCILE_BUDGET_MS, reconcileActiveRacers, type ReconcileStore } from "./reconcile.ts";
import type {
  ExternalCustomer,
  MrrReading,
  ProviderPayment,
  VerificationProvider,
} from "../verification/types.ts";

/**
 * The fleet loop's time budget.
 *
 * ## Why this exists
 *
 * `reconcileActiveRacers` iterates every active racer and awaits each one, so
 * its cost is the sum of every racer's provider round trips. The route allows
 * 300 seconds. Past that the platform kills the function mid-loop: the summary
 * is lost, and the `reconciliation_runs` row opened for the racer in flight
 * stays `running` with nothing to close it.
 *
 * The budget stops the loop *before starting* a racer, never during one. That
 * distinction is the whole design — a racer abandoned halfway is a frozen count
 * nobody can explain.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeProvider = (): VerificationProvider => ({
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
  beginConnection: () => {
    throw new Error("not used");
  },
  completeConnection: () => {
    throw new Error("not used");
  },
  validateConnection: () => {
    throw new Error("not used");
  },
  revokeConnection: () => {
    throw new Error("not used");
  },
  verifyWebhook: () => {
    throw new Error("not used");
  },
  // Nothing in the window, so each racer costs exactly one provider call and
  // the count never moves.
  async *listPayments(): AsyncIterable<ProviderPayment> {},
  async *listCustomers(): AsyncIterable<ExternalCustomer> {},
  async readMonthlyRecurringRevenue(): Promise<MrrReading> {
    return { known: true, mrrMinor: 0, currency: "usd" };
  },
});

/** A store whose racers all reconcile cleanly and cheaply. */
function fakeStore(racerIds: string[]): ReconcileStore {
  return {
    activeRacers: async () =>
      racerIds.map((id) => ({
        id,
        activatedAt: new Date(Date.UTC(2026, 0, 1)),
        endsAt: new Date(Date.UTC(2026, 0, 8)),
        currentCustomerCount: 0,
        countReconciledAt: null,
        reachedTenAt: null,
      })),
    connectionFor: async () => ({ id: "connection-1", status: "connected", accountId: "acct_x" }),
    beginRun: async () => "run-1",
    finishRun: async () => {},
    recordPayments: async () => {},
    countCustomers: async () => 0,
    advance: async () => true,
    markReachedTen: async () => false,
    nthCustomerPaidAt: async () => null,
    markExpired: async () => false,
    markConnectionBroken: async () => false,
    deleteCredential: async () => {},
    recordEvent: async () => {},
  };
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

test("a run under budget reconciles every racer and skips none", async () => {
  const ids = ["a", "b", "c"];
  const summary = await reconcileActiveRacers(
    fakeStore(ids),
    () => fakeProvider(),
    new Date(),
    // A clock that never advances: nothing can exceed the budget.
    { budgetMs: 45_000, clock: () => 0 },
  );

  assert.equal(summary.considered, 3);
  assert.equal(summary.reconciled, 3);
  assert.equal(summary.skipped, 0);
});

test("the loop stops starting racers once the budget is spent", async () => {
  const ids = ["a", "b", "c", "d", "e"];

  // Advances 30s per reading, so the second check (60s) is already past a 45s
  // budget: exactly one racer is started.
  let ticks = 0;
  const clock = () => {
    const value = ticks;
    ticks += 1;
    return value * 30_000;
  };

  const summary = await reconcileActiveRacers(
    fakeStore(ids),
    () => fakeProvider(),
    new Date(),
    { budgetMs: 45_000, clock },
  );

  assert.equal(summary.considered, 5);
  assert.equal(summary.reconciled, 1, "the budget did not stop the loop");
  assert.equal(summary.skipped, 4, "the racers left for the next run were not reported");
});

test("skipped counts the racers actually left, not the whole list", async () => {
  const ids = ["a", "b", "c", "d"];

  let ticks = 0;
  const clock = () => {
    const value = ticks;
    ticks += 1;
    return value * 30_000;
  };

  const summary = await reconcileActiveRacers(
    fakeStore(ids),
    () => fakeProvider(),
    new Date(),
    { budgetMs: 45_000, clock },
  );

  // One reconciled, three left. `considered - (reconciled + failures)`.
  assert.equal(summary.reconciled + summary.failures.length + summary.skipped, ids.length);
});

test("the default budget is the one the route's allowance was sized around", () => {
  // 300s of `maxDuration`, and the loop may spend a seventh of it starting
  // racers. Asserted so a change to either number is a decision rather than a
  // drift.
  assert.equal(RECONCILE_BUDGET_MS, 45_000);
});
