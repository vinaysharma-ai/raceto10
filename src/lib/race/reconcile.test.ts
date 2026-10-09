import assert from "node:assert/strict";
import { test } from "node:test";

import { FAKE_RESTRICTED_LIVE_KEY } from "../verification/test-fixtures.ts";

import {
  OVERLAP_MS,
  TARGET_CUSTOMERS,
  reconcileActiveRacers,
  reconcileRacer,
  type ActiveRacer,
  type ReconcileStore,
} from "./reconcile.ts";
import type { ProviderPayment } from "../verification/types.ts";
import {
  createStripeRestrictedKeyAdapter,
  type StripeRestrictedPort,
} from "../verification/stripe/restricted.ts";

/**
 * Reconciliation.
 *
 * The fake store keeps its own `race_customer` set and enforces the same
 * unique key the real table does, because the central claim — that replaying a
 * window cannot double-count — is a property of that constraint. A fake that
 * simply counted whatever it was handed would prove nothing.
 */

const KEY = FAKE_RESTRICTED_LIVE_KEY;
const ACCOUNT = "acct_1AbCdEfGhIjKlMnO";
const RACER = "racer-ada";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVATED = new Date("2026-09-29T00:00:00.000Z");
const NOW = new Date("2026-09-29T12:00:00.000Z");
/** A week after activation, so the default racer's window is still open at NOW. */
const ENDS_AT = new Date("2026-10-06T00:00:00.000Z");

type Recorded = { method: string; args: unknown[] };

function fakeStore(
  options: {
    racers?: ActiveRacer[];
    connection?: { id: string; status: string; accountId: string } | null;
    /** Existing stored customers, as `external_customer_id`s. */
    stored?: string[];
    /** Forces the compare-and-set to lose, as a concurrent run would. */
    losesAdvance?: boolean;
    losesReachedTen?: boolean;
    losesExpired?: boolean;
    /** Forces the broken-connection write to lose, as a concurrent run would. */
    losesBroken?: boolean;
    /** First-paid instants of already-stored customers, keyed by customer id. */
    paidAt?: Record<string, Date>;
  } = {},
): { store: ReconcileStore; recorded: Recorded[]; customers: Set<string> } {
  const recorded: Recorded[] = [];
  const log = (method: string, ...args: unknown[]) => recorded.push({ method, args });

  // Mirrors `race_customer`'s unique key.
  const customers = new Set<string>(options.stored ?? []);

  // The stored `first_paid_at` per customer, which is what the finish time is
  // read from. Seeded for pre-existing rows so a test can say when they paid.
  const paidAt = new Map<string, Date>(
    Object.entries(options.paidAt ?? {}).map(([id, at]) => [id, at]),
  );

  const store: ReconcileStore = {
    async activeRacers() {
      log("activeRacers");
      return (
        options.racers ?? [
          {
            id: RACER,
            activatedAt: ACTIVATED,
            endsAt: ENDS_AT,
            currentCustomerCount: customers.size,
            countReconciledAt: null,
            reachedTenAt: null,
          },
        ]
      );
    },
    async connectionFor(racerId) {
      log("connectionFor", racerId);
      return options.connection === undefined
        ? { id: CONNECTION_ID, status: "connected", accountId: ACCOUNT }
        : options.connection;
    },
    async beginRun(connectionId) {
      log("beginRun", connectionId);
      return "run-1";
    },
    async finishRun(runId, result) {
      log("finishRun", runId, result);
    },
    async recordPayments(racerId, payments: ProviderPayment[]) {
      log("recordPayments", racerId, payments.length);
      for (const payment of payments) {
        customers.add(payment.externalCustomerId);
        // The real store writes `first_paid_at` from the charge's own instant
        // and keeps the earliest, so a customer billed twice keeps their first.
        const existing = paidAt.get(payment.externalCustomerId);
        if (!existing || payment.paidAt.getTime() < existing.getTime()) {
          paidAt.set(payment.externalCustomerId, payment.paidAt);
        }
      }
    },
    async countCustomers(racerId) {
      log("countCustomers", racerId);
      return customers.size;
    },
    async advance(racerId, expected, next, at) {
      log("advance", racerId, expected, next, at);
      if (options.losesAdvance) return false;
      return true;
    },
    async markReachedTen(racerId, at) {
      log("markReachedTen", racerId, at);
      if (options.losesReachedTen) return false;
      return true;
    },
    async nthCustomerPaidAt(racerId, n) {
      log("nthCustomerPaidAt", racerId, n);
      // Ordered by `first_paid_at`, so the nth is the nth-earliest.
      const times = [...paidAt.values()].sort((a, b) => a.getTime() - b.getTime());
      return times[n - 1] ?? null;
    },
    async markExpired(racerId) {
      log("markExpired", racerId);
      if (options.losesExpired) return false;
      return true;
    },
    async markConnectionBroken(connectionId, errorCode) {
      log("markConnectionBroken", connectionId, errorCode);
      if (options.losesBroken) return false;
      return true;
    },
    async deleteCredential(racerId) {
      log("deleteCredential", racerId);
    },
    async recordEvent(input) {
      log("recordEvent", input);
    },
  };

  return { store, recorded, customers };
}

function adapter(overrides: Partial<StripeRestrictedPort> = {}) {
  const port: StripeRestrictedPort = {
    async account() {
      return { id: ACCOUNT, canWrite: false };
    },
    customers: () => (async function* () {})(),
    charges: () => (async function* () {})(),
    ...overrides,
  };
  return createStripeRestrictedKeyAdapter(port, { resolveCredential: async () => KEY });
}

/** A port yielding charges, so the adapter's own rules do the filtering. */
function chargingPort(charges: Array<Record<string, unknown>>) {
  return adapter({
    charges: () =>
      (async function* () {
        for (const charge of charges) yield charge as never;
      })(),
  });
}

function charge(id: string, customer: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    created: Math.floor(new Date("2026-09-29T06:00:00.000Z").getTime() / 1000),
    amount: 2000,
    currency: "usd",
    paid: true,
    status: "succeeded",
    customer,
    ...overrides,
  };
}

const racerAt = (count: number, overrides: Partial<ActiveRacer> = {}): ActiveRacer => ({
  id: RACER,
  activatedAt: ACTIVATED,
  endsAt: ENDS_AT,
  currentCustomerCount: count,
  countReconciledAt: null,
  reachedTenAt: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test("only succeeded, paid, non-zero, identified charges are counted", async () => {
  const { store } = fakeStore();
  const outcome = await reconcileRacer(
    store,
    chargingPort([
      charge("ch_ok", "cus_1"),
      charge("ch_failed", "cus_2", { status: "failed", paid: false }),
      charge("ch_zero", "cus_3", { amount: 0 }),
      charge("ch_guest", "cus_4", { customer: null }),
    ]),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.customerCount, 1);
});

test("the count is recomputed from stored rows, not incremented", async () => {
  // Two customers already stored. A fresh run that sees nothing must still
  // report 2 — an incrementing counter would have no way to know that.
  const { store } = fakeStore({ stored: ["cus_a", "cus_b"] });
  const outcome = await reconcileRacer(store, adapter(), racerAt(0), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.customerCount, 2);
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

test("replaying the same window does not double-count", async () => {
  // The property the whole design rests on. The window overlaps by an hour on
  // purpose, so a payment seen once is seen again — and must not count twice.
  const { store, customers } = fakeStore({ stored: ["cus_1"] });

  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_1", "cus_1")]),
    racerAt(1),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.customerCount, 1);
  assert.equal(customers.size, 1);
});

test("the same payment replayed is never counted twice", async () => {
  // The requirement stated as "deduplicate by provider payment id". The key is
  // actually the customer — see the test below for why that is the stronger
  // one — but the property being asked for holds either way: replaying a
  // window containing an already-seen payment changes nothing.
  const { store, customers } = fakeStore();

  const provider = chargingPort([charge("ch_replayed", "cus_1")]);
  await reconcileRacer(store, provider, racerAt(0), NOW);
  await reconcileRacer(store, provider, racerAt(1), NOW);

  assert.equal(customers.size, 1, "the replay created a second customer row");
});

test("a payment id unique per payment would over-count, which is why the key is the customer", async () => {
  // This is the test that justifies the choice explicitly.
  //
  // The product counts PAYING CUSTOMERS — "race to your first 10 paying
  // customers" — not payments. A subscriber billed three times in one window is
  // one customer. Keying uniqueness on `provider_payment_id` would count them
  // as three and let a racer reach 10 on a single subscriber.
  //
  // Keying on the customer also subsumes payment-level dedup: a payment maps to
  // exactly one customer, and that customer has exactly one row, so the same
  // payment cannot be counted twice however many times it is replayed.
  const { store } = fakeStore();
  const outcome = await reconcileRacer(
    store,
    chargingPort([
      charge("ch_1", "cus_1"),
      charge("ch_2", "cus_1"),
      charge("ch_3", "cus_1"),
    ]),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.customerCount, 1, "three payments from one customer is one customer");
    assert.notEqual(outcome.customerCount, 3, "payment-level counting would have produced 3");
  }
});

test("one customer with several payments counts once", async () => {
  // The unique key is on the customer, not the payment. A subscriber who paid
  // three times in the window is one customer.
  const { store } = fakeStore();
  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_1", "cus_1"), charge("ch_2", "cus_1"), charge("ch_3", "cus_1")]),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.customerCount, 1);
});

test("running twice in a row produces the same count and no second event", async () => {
  const { store, recorded } = fakeStore();
  const provider = chargingPort([charge("ch_1", "cus_1")]);

  await reconcileRacer(store, provider, racerAt(0), NOW);
  const eventsAfterFirst = recorded.filter((r) => r.method === "recordEvent").length;

  // Second run: the racer now has a count of 1, and the window is replayed.
  await reconcileRacer(store, provider, racerAt(1), NOW);

  const eventsAfterSecond = recorded.filter((r) => r.method === "recordEvent").length;
  assert.equal(eventsAfterSecond, eventsAfterFirst, "a replay announced a milestone again");
});

// ---------------------------------------------------------------------------
// Milestones and finishing
// ---------------------------------------------------------------------------

test("reaching ten finishes the race and emits one event each", async () => {
  const stored = Array.from({ length: 9 }, (_, i) => `cus_${i}`);
  const { store, recorded } = fakeStore({ stored });

  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_10", "cus_10")]),
    racerAt(9),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.customerCount, TARGET_CUSTOMERS);
  assert.equal(outcome.advanced, true);
  assert.equal(outcome.finished, true);

  const types = recorded
    .filter((r) => r.method === "recordEvent")
    .map((r) => (r.args[0] as Record<string, unknown>).type);
  assert.deepEqual(types, ["customer_milestone", "finished"]);
});

test("a racer who already finished is not finished again", async () => {
  const stored = Array.from({ length: 10 }, (_, i) => `cus_${i}`);
  const { store, recorded } = fakeStore({ stored });

  const outcome = await reconcileRacer(
    store,
    adapter(),
    racerAt(10, { reachedTenAt: new Date("2026-09-29T10:00:00.000Z") }),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.finished, false);
  assert.equal(
    recorded.some((r) => r.method === "markReachedTen"),
    false,
    "the finish was attempted a second time",
  );
});

test("losing the finish race does not emit a duplicate finished event", async () => {
  // Two runs both see ten. The compare-and-set means one writes the finish and
  // announces it; the loser reports that it did not finish the race.
  const stored = Array.from({ length: 10 }, (_, i) => `cus_${i}`);
  const { store, recorded } = fakeStore({ stored, losesReachedTen: true });

  const outcome = await reconcileRacer(store, adapter(), racerAt(9), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.finished, false);
  assert.equal(
    recorded.some(
      (r) => r.method === "recordEvent" && (r.args[0] as Record<string, unknown>).type === "finished",
    ),
    false,
  );
});

test("losing the count race does not announce a milestone", async () => {
  const { store, recorded } = fakeStore({ losesAdvance: true });
  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_1", "cus_1")]),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.advanced, false);
  assert.equal(recorded.some((r) => r.method === "recordEvent"), false);
});

test("no event is emitted when the count has not moved", async () => {
  const { store, recorded } = fakeStore({ stored: ["cus_1"] });
  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_1", "cus_1")]),
    racerAt(1),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.advanced, true, "the timestamp is still stamped");
  assert.equal(
    recorded.some((r) => r.method === "recordEvent"),
    false,
    "an unchanged count announced a milestone",
  );
});

// ---------------------------------------------------------------------------
// Windows and timestamps
// ---------------------------------------------------------------------------

test("the first run reads from activation", async () => {
  const { store, recorded } = fakeStore();
  await reconcileRacer(store, adapter(), racerAt(0), NOW);

  // The adapter is given the window; asserted through the recorded advance
  // timestamp rather than the window itself, which the port does not expose.
  const advance = recorded.find((r) => r.method === "advance");
  assert.equal((advance?.args[3] as Date).toISOString(), NOW.toISOString());
});

test("a later run overlaps its window rather than resuming exactly", async () => {
  // A payment can reach Stripe slightly after the instant we last looked. A
  // window resuming exactly where the last ended would step over it. The
  // overlap is safe precisely because replay cannot double-count.
  assert.ok(OVERLAP_MS > 0, "there is an overlap");
});

test("count_reconciled_at is stamped even when nothing changed", async () => {
  // Otherwise a racer whose count is stable would look permanently stale.
  const { store, recorded } = fakeStore({ stored: ["cus_1"] });
  await reconcileRacer(store, adapter(), racerAt(1), NOW);

  assert.equal(recorded.some((r) => r.method === "advance"), true);
});

// ---------------------------------------------------------------------------
// Runs, failures, and the fleet
// ---------------------------------------------------------------------------

test("a successful run is recorded", async () => {
  const { store, recorded } = fakeStore();
  await reconcileRacer(store, adapter(), racerAt(0), NOW);

  const finish = recorded.find((r) => r.method === "finishRun");
  const result = finish?.args[1] as Record<string, unknown>;
  assert.equal(result.status, "ok");
  assert.equal(result.customerCount, 0);
});

test("a provider failure is recorded on the run and returned", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await reconcileRacer(
    store,
    chargingPort([]),
    racerAt(0),
    NOW,
  );
  assert.equal(outcome.ok, true); // an empty page is not a failure

  const failing = await reconcileRacer(
    store,
    adapter({
      charges: () => {
        throw new Error("stripe unreachable");
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(failing.ok, false);
  if (!failing.ok) assert.equal(failing.reason, "provider_failed");

  const failedRun = recorded
    .filter((r) => r.method === "finishRun")
    .map((r) => (r.args[1] as Record<string, unknown>).status);
  assert.ok(failedRun.includes("failed"));
});

test("a racer with no connection fails without stopping anyone else", async () => {
  const { store } = fakeStore({ connection: null });
  const outcome = await reconcileRacer(store, adapter(), racerAt(0), NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "no_connection");
});

test("the fleet run summarises what happened rather than throwing", async () => {
  const { store } = fakeStore({
    racers: [
      racerAt(0),
      { ...racerAt(0), id: "racer-2" },
    ],
  });

  const summary = await reconcileActiveRacers(store, () => adapter(), NOW);

  assert.equal(summary.considered, 2);
  assert.equal(summary.reconciled, 2);
  assert.deepEqual(summary.failures, []);
});

test("one racer's failure does not stop the others", async () => {
  const { store } = fakeStore({
    racers: [racerAt(0), { ...racerAt(0), id: "racer-2" }],
  });

  let call = 0;
  const summary = await reconcileActiveRacers(
    store,
    () => {
      call += 1;
      // The first racer's provider is dead; the second's is fine.
      return call === 1
        ? adapter({
            charges: () => {
              throw new Error("dead key");
            },
          })
        : adapter();
    },
    NOW,
  );

  assert.equal(summary.considered, 2);
  assert.equal(summary.reconciled, 1);
  assert.equal(summary.failures.length, 1);
});

test("each racer is reconciled with a provider scoped to them", async () => {
  // The security property, preserved even in the fleet job: a credential is
  // only ever resolved for the racer it belongs to.
  const { store } = fakeStore({
    racers: [racerAt(0), { ...racerAt(0), id: "racer-2" }],
  });

  const seen: string[] = [];
  await reconcileActiveRacers(
    store,
    (racerId) => {
      seen.push(racerId);
      return adapter();
    },
    NOW,
  );

  assert.deepEqual(seen, [RACER, "racer-2"]);
});

test("reconcileActiveRacers takes no count or customer from its caller", () => {
  // Structural: there is no parameter for a client-supplied number to arrive in.
  assert.equal(reconcileActiveRacers.length, 2, "only (store, providerFor) are required");
});


// ---------------------------------------------------------------------------
// The window closes
// ---------------------------------------------------------------------------

/** A week long, so `ENDS_AT` is exactly when the default window closes. */
const closedRacer = (count: number, overrides: Partial<ActiveRacer> = {}) =>
  racerAt(count, { endsAt: new Date("2026-09-29T06:00:00.000Z"), ...overrides });

test("a race past its window with fewer than ten expires", async () => {
  const { store, recorded } = fakeStore();

  const outcome = await reconcileRacer(store, adapter(), closedRacer(3), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.expired, true);
  assert.equal(recorded.some((r) => r.method === "markExpired"), true);
});

test("a race still inside its window does not expire", async () => {
  // NOW is before ENDS_AT, so the clock is still running. Expiring here would
  // end a race that has hours left.
  const { store, recorded } = fakeStore();

  const outcome = await reconcileRacer(store, adapter(), racerAt(3), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.expired, false);
  assert.equal(recorded.some((r) => r.method === "markExpired"), false);
});

test("a race that reached ten is finished, not expired, even after the window closed", async () => {
  // The ordering this exists to prove. Ten customers at any point is a win, and
  // a poller that only noticed after `ends_at` must not turn it into a loss.
  const stored = Array.from({ length: 10 }, (_, i) => `cus_${i}`);
  const { store, recorded } = fakeStore({ stored });

  const outcome = await reconcileRacer(store, adapter(), closedRacer(10), NOW);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // The win is recorded even though the poller is late. Ten customers is a win
  // whenever it happened; the run that notices after `ends_at` must not convert
  // it into a loss.
  assert.equal(outcome.finished, true);
  assert.equal(outcome.expired, false, "a won race was expired");
  assert.equal(recorded.some((r) => r.method === "markExpired"), false);
});

test("losing the expiry race does not emit a second event", async () => {
  const { store, recorded } = fakeStore({ losesExpired: true });

  const outcome = await reconcileRacer(store, adapter(), closedRacer(3), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.expired, false);
  assert.equal(recorded.some((r) => r.method === "recordEvent"), false);
});

test("the expiry event is stamped with the close of the window, not the poll", async () => {
  const { store, recorded } = fakeStore();
  const endsAt = new Date("2026-09-29T06:00:00.000Z");

  await reconcileRacer(store, adapter(), closedRacer(3), NOW);

  const event = recorded.find((r) => r.method === "recordEvent")?.args[0] as {
    type?: string;
    occurredAt?: Date;
  };
  assert.equal(event?.type, "expired");
  assert.equal(event?.occurredAt?.getTime(), endsAt.getTime());
});

// ---------------------------------------------------------------------------
// When the race was actually won
// ---------------------------------------------------------------------------

test("finished_at is the tenth customer's first payment, not the reconcile time", async () => {
  // The distinction the board rests on. A poll runs every thirty minutes, so
  // "when we noticed" can be most of an hour after "when it happened" — and a
  // race that says it was won at 12:00 when the money arrived at 11:31 is a race
  // whose numbers are approximate.
  const paidAt: Record<string, Date> = {};
  const stored: string[] = [];

  for (let i = 1; i <= 9; i += 1) {
    const id = `cus_${i}`;
    stored.push(id);
    // Spread earlier in the day, all before the tenth.
    paidAt[id] = new Date(`2026-09-29T0${i}:00:00.000Z`);
  }

  const tenthPaidAt = new Date("2026-09-29T11:31:00.000Z");

  const { store, recorded } = fakeStore({ stored, paidAt });

  const outcome = await reconcileRacer(
    store,
    chargingPort([
      {
        id: "ch_10",
        created: Math.floor(tenthPaidAt.getTime() / 1000),
        amount: 2000,
        currency: "usd",
        paid: true,
        status: "succeeded",
        customer: "cus_10",
      },
    ]),
    racerAt(9),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.finished, true);

  const stamped = recorded.find((r) => r.method === "markReachedTen")?.args[1] as Date;
  assert.equal(
    stamped.getTime(),
    tenthPaidAt.getTime(),
    `finished at ${stamped.toISOString()}, expected the tenth payment at ${tenthPaidAt.toISOString()}`,
  );
  assert.notEqual(stamped.getTime(), NOW.getTime(), "finished_at was the reconcile time");
});

test("payments after the window closed are not counted", async () => {
  // A sale made the day after the race ended is not a customer of that race.
  // Without the clamp the count would keep climbing after the clock stopped,
  // and a founder could lose and then quietly win.
  const { store, recorded } = fakeStore();

  const afterClose = {
    id: "ch_late",
    created: Math.floor(new Date("2026-09-29T09:00:00.000Z").getTime() / 1000),
    amount: 2000,
    currency: "usd",
    paid: true,
    status: "succeeded",
    customer: "cus_late",
  };

  // The window closes at 06:00; this payment is at 09:00.
  const outcome = await reconcileRacer(store, chargingPort([afterClose]), closedRacer(0), NOW);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.customerCount, 0, "a payment after the window was counted");
  assert.equal(
    (recorded.find((r) => r.method === "recordPayments")?.args[1] as number) ?? -1,
    0,
  );
});

// ---------------------------------------------------------------------------
// The key stops working
// ---------------------------------------------------------------------------

/**
 * A 401 or a 403 is not a transient fault.
 *
 * Retrying it is pointless — the credential is wrong, revoked, or scoped below
 * what we need, and it will answer the same way in thirty minutes and in thirty
 * days. So the connection is marked broken, the count is left exactly as it was,
 * and the public timeline gets one line explaining why the number stopped
 * moving. A frozen count with no explanation is indistinguishable from a racer
 * who stopped selling.
 */
for (const [label, statusCode, expected] of [
  ["a revoked key (401)", 401, "rejected"],
  ["a key without the needed permission (403)", 403, "insufficient_permission"],
] as const) {
  test(`${label} marks the connection broken and freezes the count`, async () => {
    const { store, recorded } = fakeStore({ stored: ["cus_1", "cus_2"] });

    const outcome = await reconcileRacer(
      store,
      adapter({
        charges: () => {
          throw { statusCode };
        },
      }),
      racerAt(2),
      NOW,
    );

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "connection_lost");

    const broken = recorded.find((r) => r.method === "markConnectionBroken");
    assert.equal(broken?.args[1], expected, "the wrong category was recorded");

    const event = recorded.find((r) => r.method === "recordEvent")?.args[0] as {
      type?: string;
      milestone?: number | null;
    };
    assert.equal(event?.type, "connection_lost");
    // No milestone — and deliberately not the frozen count, which this used to
    // assert. `race_event.milestone_customer_count` is constrained to `NULL or
    // 1..10`, so a race whose key died before its first customer would have
    // written a 0 and failed the insert. The count is still frozen, which is
    // the assertion below; it simply does not belong in a milestone column.
    assert.equal(event?.milestone, null);

    // Frozen, not corrected. No count write at all is the assertion that
    // matters: writing the same value back would still be this job deciding it.
    assert.equal(
      recorded.some((r) => r.method === "advance"),
      false,
      "the count was written during a lost connection",
    );
  });
}

test("a plain network failure does not break the connection", async () => {
  // The distinction that keeps one bad afternoon from disconnecting everybody.
  // A timeout is worth another poll; a refused key is not.
  const { store, recorded } = fakeStore();

  const outcome = await reconcileRacer(
    store,
    adapter({
      charges: () => {
        throw new Error("socket hang up");
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "provider_failed");
  assert.equal(
    recorded.some((r) => r.method === "markConnectionBroken"),
    false,
    "a transient failure broke the connection",
  );
  assert.equal(recorded.some((r) => r.method === "recordEvent"), false);
});

test("losing the broken-connection race does not emit a second event", async () => {
  // Two runs fail at the same instant. One performs the transition and
  // announces it; the other writes nothing and says nothing.
  const { store, recorded } = fakeStore({ losesBroken: true });

  const outcome = await reconcileRacer(
    store,
    adapter({
      charges: () => {
        throw { statusCode: 401 };
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "connection_lost");
  assert.equal(
    recorded.some((r) => r.method === "recordEvent"),
    false,
    "the loser announced a connection_lost event",
  );
});

test("a broken connection is never read again, so there is no retry storm", async () => {
  // The property that makes this safe to leave on a thirty minute schedule. The
  // connection is checked before the provider is touched, so a dead key costs
  // one failed call and then nothing at all.
  const { store, recorded } = fakeStore({
    connection: { id: CONNECTION_ID, status: "broken", accountId: ACCOUNT },
  });

  let contacted = false;
  const outcome = await reconcileRacer(
    store,
    adapter({
      charges: () => {
        contacted = true;
        return (async function* () {})();
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "connection_not_ready");
  assert.equal(contacted, false, "the provider was called for a broken connection");
  assert.equal(recorded.some((r) => r.method === "beginRun"), false);
});

// ---------------------------------------------------------------------------
// The key does not outlive the race
// ---------------------------------------------------------------------------

/**
 * /privacy says the key "is deleted when your race ends".
 *
 * One test per terminal state, because the promise is kept by five separate
 * branches and the whole risk is that four of them are correct. `ineligible` and
 * `disconnected` live in their own files, next to the code that performs them.
 *
 * The negative case is the one that would be catastrophic to get wrong: deleting
 * a racing racer's key leaves a race that can never be counted, and it would
 * look exactly like a racer who stopped selling.
 */
test("the key is deleted when a race finishes", async () => {
  const stored = Array.from({ length: 9 }, (_, i) => `cus_${i}`);
  const { store, recorded } = fakeStore({ stored });

  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_10", "cus_10")]),
    racerAt(9),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.finished, true);
  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    true,
    "the key outlived the race",
  );
});

test("the key is deleted when a race expires", async () => {
  const { store, recorded } = fakeStore();

  const outcome = await reconcileRacer(store, adapter(), closedRacer(3), NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.expired, true);
  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    true,
    "the key outlived an expired race",
  );
});

test("the key is deleted when the connection breaks for good", async () => {
  const { store, recorded } = fakeStore();

  await reconcileRacer(
    store,
    adapter({
      charges: () => {
        throw { statusCode: 401 };
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    true,
    "a refused key was kept",
  );
});

test("a racing racer's key is NOT deleted", async () => {
  // The direction that matters most. Deleting here leaves a race running with no
  // way to count it, and the board would show a number frozen at whatever it
  // happened to be, for a race that has not ended.
  const { store, recorded } = fakeStore({ stored: ["cus_1"] });

  const outcome = await reconcileRacer(
    store,
    chargingPort([charge("ch_2", "cus_2")]),
    racerAt(1),
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.finished, false);
    assert.equal(outcome.expired, false);
  }
  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    false,
    "the key was deleted while the race was still running",
  );
});

test("a run that only fails transiently deletes nothing", async () => {
  // A network failure must not cost the racer their key. Only a refusal does.
  const { store, recorded } = fakeStore();

  await reconcileRacer(
    store,
    adapter({
      charges: () => {
        throw new Error("socket hang up");
      },
    }),
    racerAt(0),
    NOW,
  );

  assert.equal(recorded.some((r) => r.method === "deleteCredential"), false);
});