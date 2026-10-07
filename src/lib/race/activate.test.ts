import assert from "node:assert/strict";
import { test } from "node:test";

import { FAKE_RESTRICTED_LIVE_KEY } from "../verification/test-fixtures.ts";

import { activateRacer, type ActivationStore, type RacerState } from "./activate.ts";
import {
  CredentialError,
  createStripeRestrictedKeyAdapter,
  type StripeRestrictedPort,
} from "../verification/stripe/restricted.ts";

/**
 * Activation.
 *
 * The tests worth reading first are the ones about what activation *cannot* be
 * told: there is no baseline parameter, no duration parameter and no racer
 * parameter, so a client cannot influence any of them. The fake store records
 * every call, which is how the "nothing was written" assertions are made —
 * stronger than checking the return value, because it covers the writes.
 */

const KEY = FAKE_RESTRICTED_LIVE_KEY;
const ACCOUNT = "acct_1AbCdEfGhIjKlMnO";
const RACER = "racer-ada";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-29T12:00:00.000Z");

type Recorded = { method: string; args: unknown[] };

function fakeStore(
  options: {
    racerId?: string | null;
    racer?: RacerState | null;
    connection?: { id: string; status: string; accountId: string } | null;
    durationDays?: number | null;
    /** The stored registration verdict. Defaults to a pass. */
    registration?: "eligible" | "ineligible" | "failed" | null;
    /** Forces `beginActivation` to lose the race, as a concurrent call would. */
    losesRace?: boolean;
    existing?: { activatedAt: Date; raceEndAt: Date; baselineCustomerCount: number };
  } = {},
): { store: ActivationStore; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const log = (method: string, ...args: unknown[]) => recorded.push({ method, args });

  const racer: RacerState = options.racer ?? {
    id: RACER,
    status: "ready",
    activatedAt: null,
    raceEndAt: null,
    baselineCustomerCount: null,
  };

  const store: ActivationStore = {
    async currentRacerId() {
      log("currentRacerId");
      return options.racerId === undefined ? RACER : options.racerId;
    },
    async loadRacer(id) {
      log("loadRacer", id);
      return options.racer === null ? null : racer;
    },
    async loadConnection(racerId, provider) {
      log("loadConnection", racerId, provider);
      return options.connection === undefined
        ? { id: CONNECTION_ID, status: "connected", accountId: ACCOUNT }
        : options.connection;
    },
    async latestRegistrationEligibility(racerId) {
      log("latestRegistrationEligibility", racerId);
      return options.registration === undefined ? "eligible" : options.registration;
    },
    async raceDurationDays() {
      log("raceDurationDays");
      return options.durationDays === undefined ? 7 : options.durationDays;
    },
    async beginActivation(input) {
      log("beginActivation", input);
      if (options.losesRace) {
        return {
          won: false,
          existing: options.existing ?? {
            activatedAt: new Date("2026-09-28T00:00:00.000Z"),
            raceEndAt: new Date("2026-10-05T00:00:00.000Z"),
            baselineCustomerCount: 0,
          },
        };
      }
      return { won: true };
    },
    async writeBaselineCustomers(racerId, externalIds) {
      log("writeBaselineCustomers", racerId, externalIds);
    },
    async recordActivationSnapshot(input) {
      log("recordActivationSnapshot", input);
    },
    async markIneligible(racerId) {
      log("markIneligible", racerId);
    },
    async deleteCredential(racerId) {
      log("deleteCredential", racerId);
    },
    async loadEmailContext(racerId) {
      log("loadEmailContext", racerId);
      return null;
    },
    async markEmailSent(racerId, at) {
      log("markEmailSent", racerId, at);
    },
    async recordActivationEvent(input) {
      log("recordActivationEvent", input);
    },
  };

  return { store, recorded };
}

function adapter(overrides: Partial<StripeRestrictedPort> = {}) {
  const port: StripeRestrictedPort = {
    async account() {
      return { id: ACCOUNT, label: "Ledgerly", canWrite: false };
    },
    customers: () => (async function* () {})(),
    charges: () => (async function* () {})(),
    subscriptions: () => (async function* () {})(),
    ...overrides,
  };

  return createStripeRestrictedKeyAdapter(port, {
    resolveCredential: async () => KEY,
  });
}

function customers(rows: Array<{ id: string; created: number }>) {
  return () =>
    (async function* () {
      for (const row of rows) yield row;
    })();
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

test("an unauthenticated caller cannot activate", async () => {
  const { store, recorded } = fakeStore({ racerId: null });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "no_racer");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("a racer with no provider connection cannot activate", async () => {
  const { store, recorded } = fakeStore({ connection: null });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "no_connection");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("an unhealthy connection blocks activation", async () => {
  const { store } = fakeStore({
    connection: { id: CONNECTION_ID, status: "invalid", accountId: ACCOUNT },
  });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "connection_not_ready");
});

test("an unreadable duration blocks activation rather than defaulting", async () => {
  // Defaulting to 7 here would invent a business rule at the moment we could
  // not read the real one, and start a clock on it.
  const { store, recorded } = fakeStore({ durationDays: null });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "duration_unavailable");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("an eligible racer activates and starts racing", async () => {
  const { store } = fakeStore();
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.alreadyActive, false);
  assert.equal(outcome.activatedAt.toISOString(), NOW.toISOString());
  assert.equal(outcome.durationDays, 7);
  // 7 days from activation, not from some shared batch boundary.
  assert.equal(outcome.raceEndAt.toISOString(), "2026-10-06T12:00:00.000Z");
  assert.equal(outcome.baselineCustomerCount, 0);
});

test("the duration comes from configuration, not a constant", async () => {
  for (const days of [3, 14, 30]) {
    const { store } = fakeStore({ durationDays: days });
    const outcome = await activateRacer(store, adapter(), true, NOW);

    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    assert.equal(outcome.durationDays, days);

    const expected = new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
    assert.equal(outcome.raceEndAt.toISOString(), expected.toISOString(), `${days} days`);
  }
});

test("activation records the snapshot and the race event", async () => {
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  assert.equal(recorded.some((r) => r.method === "recordActivationSnapshot"), true);
  assert.equal(recorded.some((r) => r.method === "recordActivationEvent"), true);

  const snap = recorded.find((r) => r.method === "recordActivationSnapshot")?.args[0] as Record<string, unknown>;
  assert.equal(snap.connectionId, CONNECTION_ID);
  assert.equal(snap.customerCount, 0);

  const event = recorded.find((r) => r.method === "recordActivationEvent")?.args[0] as Record<string, unknown>;
  assert.equal(event.customerCount, 0);
});

test("the racer is moved into racing, in the same write as the clock", async () => {
  // Passed into `beginActivation` rather than hardcoded in the store's SQL, so
  // the transition is visible from the orchestration and assertable here. A
  // status change that only exists inside a query string is one nobody reviews.
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  const begun = recorded.find((r) => r.method === "beginActivation")?.args[0] as Record<string, unknown>;
  assert.equal(begun.status, "racing");

  // The clock and the status move together: there is no window in which a racer
  // is `racing` with no start, or started but still `ready`.
  assert.equal(begun.activatedAt, NOW);
  assert.ok(begun.raceEndAt instanceof Date);
});

test("a founder who has not agreed to race in public cannot start", async () => {
  // `public_consent_at` is what every public view filters on, so starting
  // without it would produce a racer nobody can see — competing in a race that
  // is not public, which is not this product.
  const { store, recorded } = fakeStore();
  const outcome = await activateRacer(store, adapter(), false, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "no_consent");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("consent is refused before the provider is ever contacted", async () => {
  // No point reading a Stripe account to start a race that cannot be started.
  let contacted = false;
  const { store } = fakeStore();

  await activateRacer(
    store,
    adapter({
      customers: () => {
        contacted = true;
        return (async function* () {})();
      },
    }),
    false,
    NOW,
  );

  assert.equal(contacted, false);
});

test("consent is written in the same statement as the clock", async () => {
  // Not a second write. A separate one could fail between the two and leave a
  // racer `racing` but invisible to every public view.
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  const begun = recorded.find((r) => r.method === "beginActivation")?.args[0] as Record<string, unknown>;
  assert.equal((begun.publicConsentAt as Date).toISOString(), NOW.toISOString());
  assert.equal((begun.activatedAt as Date).toISOString(), NOW.toISOString());
});

test("a racer refused at the gate is never moved into racing", async () => {
  const { store, recorded } = fakeStore({ registration: "ineligible" });
  await activateRacer(store, adapter(), true, NOW);

  assert.equal(
    recorded.some((r) => r.method === "beginActivation"),
    false,
    "no status transition was attempted",
  );
});

test("the baseline write happens, so 'already had' is a set and not a number", async () => {
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  const write = recorded.find((r) => r.method === "writeBaselineCustomers");
  assert.deepEqual(write?.args, [RACER, []]);
});

test("a racer can activate while others are already racing", async () => {
  // Nothing in this flow consults a batch or a cohort, and nothing waits for a
  // window to open. The window is derived from this racer's own `now`.
  const { store } = fakeStore();
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.activatedAt.toISOString(), NOW.toISOString());
});

test("two racers activating at different times get different windows", async () => {
  const first = new Date("2026-09-29T12:00:00.000Z");
  const second = new Date("2026-10-02T09:30:00.000Z");

  const a = await activateRacer(fakeStore().store, adapter(), true, first);
  const b = await activateRacer(fakeStore().store, adapter(), true, second);

  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.raceEndAt.toISOString(), b.raceEndAt.toISOString());
});

// ---------------------------------------------------------------------------
// The registration gate must have passed
// ---------------------------------------------------------------------------

test("a racer with no registration verdict cannot activate", async () => {
  // A connection whose probe failed, or one that predates the gate, has never
  // been told the founder qualifies. Letting them activate on a fresh check
  // alone would skip the step where they saw the verdict.
  const { store, recorded } = fakeStore({ registration: null });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_verified");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("a failed registration check cannot activate", async () => {
  const { store } = fakeStore({ registration: "failed" });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_verified");
});

test("a stored ineligible verdict cannot activate", async () => {
  const { store, recorded } = fakeStore({ registration: "ineligible" });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("the stored verdict is read before the duration and before any write", async () => {
  // Ordering that matters: a racer who was never admitted should not cause the
  // duration to be read, a provider to be contacted, or a row to be written.
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  const order = recorded.map((r) => r.method);
  const gate = order.indexOf("latestRegistrationEligibility");

  assert.ok(gate !== -1, "the stored verdict was read");
  assert.ok(gate < order.indexOf("raceDurationDays"), "gate before the duration read");
  assert.ok(gate < order.indexOf("beginActivation"), "gate before the write");
  assert.ok(gate < order.indexOf("recordActivationSnapshot"), "gate before the snapshot");
});

test("a racer who was never admitted causes no write at all", async () => {
  const { store, recorded } = fakeStore({ registration: null });
  await activateRacer(store, adapter(), true, NOW);

  const writes = recorded.filter((r) =>
    ["beginActivation", "writeBaselineCustomers", "recordActivationSnapshot", "recordActivationEvent"].includes(
      r.method,
    ),
  );
  assert.deepEqual(writes, [], "nothing was written for an unadmitted racer");
});

// ---------------------------------------------------------------------------
// Eligibility at activation
// ---------------------------------------------------------------------------

test("a racer with an existing paying customer is refused", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await activateRacer(
    store,
    adapter({ customers: customers([{ id: "cus_1", created: 1_700_000_000 }]) }),
    true,
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");

  // The clock must not start on a count that failed the gate.
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
  assert.equal(recorded.some((r) => r.method === "writeBaselineCustomers"), false);
});

test("a racer with recurring revenue is refused", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await activateRacer(
    store,
    adapter({
      subscriptions: () =>
        (async function* () {
          yield {
            id: "sub_1",
            status: "active",
            customer: "cus_1",
            items: {
              data: [{ quantity: 1, price: { unit_amount: 4900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }],
            },
          };
        })(),
    }),
    true,
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("a key that cannot report MRR cannot activate anyone", async () => {
  // The gate cannot be passed without an answer, so an unanswerable MRR is a
  // refusal — not an assumed zero.
  const adapterWithoutSubs = createStripeRestrictedKeyAdapter(
    {
      async account() {
        return { id: ACCOUNT, canWrite: false };
      },
      customers: () => (async function* () {})(),
      charges: () => (async function* () {})(),
    },
    { resolveCredential: async () => KEY },
  );

  const { store, recorded } = fakeStore();
  const outcome = await activateRacer(store, adapterWithoutSubs, true, NOW);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

test("a provider that cannot be read does not start a clock", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await activateRacer(
    store,
    adapter({
      customers: () => {
        throw new CredentialError("rejected");
      },
    }),
    true,
    NOW,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "verification_failed");
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("activating twice returns the existing race unchanged", async () => {
  const { store, recorded } = fakeStore({
    racer: {
      id: RACER,
      status: "racing",
      activatedAt: new Date("2026-09-28T00:00:00.000Z"),
      raceEndAt: new Date("2026-10-05T00:00:00.000Z"),
      baselineCustomerCount: 0,
    },
  });

  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.alreadyActive, true);
  // The original window, not a fresh one from `NOW`.
  assert.equal(outcome.activatedAt.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(outcome.raceEndAt.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(outcome.durationDays, 7);

  // Nothing was rewritten: no second baseline, no second event.
  assert.equal(recorded.some((r) => r.method === "beginActivation"), false);
  assert.equal(recorded.some((r) => r.method === "writeBaselineCustomers"), false);
  assert.equal(recorded.some((r) => r.method === "recordActivationEvent"), false);
});

test("losing a concurrent activation returns the winner's race, not ours", async () => {
  // The compare-and-set lives in the store's write. Two taps of the button must
  // not produce two baselines, and the loser must not overwrite the winner.
  const { store, recorded } = fakeStore({ losesRace: true });
  const outcome = await activateRacer(store, adapter(), true, NOW);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.alreadyActive, true);
  assert.equal(outcome.activatedAt.toISOString(), "2026-09-28T00:00:00.000Z");

  // The winner's window stands; ours is discarded rather than written.
  assert.equal(recorded.some((r) => r.method === "writeBaselineCustomers"), false);
  assert.equal(recorded.some((r) => r.method === "recordActivationEvent"), false);
});

test("a finished racer does not restart by activating again", async () => {
  for (const status of ["finished", "withdrawn", "disqualified"]) {
    const { store, recorded } = fakeStore({
      racer: {
        id: RACER,
        status,
        activatedAt: null,
        raceEndAt: null,
        baselineCustomerCount: null,
      },
    });

    const outcome = await activateRacer(store, adapter(), true, NOW);
    assert.equal(outcome.ok, false, status);
    if (!outcome.ok) assert.equal(outcome.reason, "not_eligible", status);
    assert.equal(recorded.some((r) => r.method === "beginActivation"), false, status);
  }
});

// ---------------------------------------------------------------------------
// The client cannot influence the baseline
// ---------------------------------------------------------------------------

test("consent is the only thing a caller supplies", async () => {
  // Structural, not behavioural: the signature is the guarantee.
  //
  // `(store, provider, consent, now?)`. A client that wanted a favourable
  // starting count, a longer window, or a start time of its choosing would have
  // to change this file — there is no parameter for any of them. Consent is the
  // one exception because it is a decision the founder makes, not a fact we
  // verify; the baseline and the window are read from Stripe and `race_config`.
  assert.equal(activateRacer.length, 3, "(store, provider, consent)");
});

test("the baseline written is the one read from the provider", async () => {
  const { store, recorded } = fakeStore();
  await activateRacer(store, adapter(), true, NOW);

  const write = recorded.find((r) => r.method === "writeBaselineCustomers");
  const ids = write?.args[1] as string[];
  assert.deepEqual(ids, [], "an eligible account has an empty baseline by definition");

  const begun = recorded.find((r) => r.method === "beginActivation")?.args[0] as Record<string, unknown>;
  assert.equal(begun.baselineCustomerCount, 0);
  // The count is derived from the provider page, never from an argument.
  assert.equal(begun.racerId, RACER);
});


// ---------------------------------------------------------------------------
// The key is deleted when the re-check fails
// ---------------------------------------------------------------------------

/**
 * A racer who passed the gate at registration and fails it at activation.
 *
 * Both halves matter and they are not the same claim. The status change takes
 * them out of every future activation batch — left as `ready`, the owner's batch
 * would re-check them forever and the board would count them as waiting for a
 * clock that is never coming. The deletion is the promise /privacy makes: the
 * key is deleted when the race ends, and this is a race that ended before it
 * began.
 */
test("a failed re-check marks the racer ineligible and deletes the key", async () => {
  const { store, recorded } = fakeStore();

  const outcome = await activateRacer(
    store,
    // Registration passed with an empty account; by activation there is one.
    adapter({ customers: customers([{ id: "cus_1", created: 1_700_000_000 }]) }),
    true,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_eligible");

  assert.equal(
    recorded.some((r) => r.method === "markIneligible"),
    true,
    "the racer was left in the activation batch",
  );
  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    true,
    "the key survived a race that ended before it began",
  );
});

test("the status is written before the key is deleted", async () => {
  // The order is the safety property. Deleted first, a throw leaves the racer
  // `ready` with no credential — activatable, and uncountable once started.
  const { store, recorded } = fakeStore();

  await activateRacer(
    store,
    adapter({ customers: customers([{ id: "cus_1", created: 1_700_000_000 }]) }),
    true,
  );

  const statusAt = recorded.findIndex((r) => r.method === "markIneligible");
  const deleteAt = recorded.findIndex((r) => r.method === "deleteCredential");

  assert.ok(statusAt >= 0 && deleteAt >= 0);
  assert.ok(statusAt < deleteAt, "the key was deleted before the status was written");
});

test("a successful activation deletes nothing", async () => {
  // The other direction, and the one that would be catastrophic to get wrong:
  // deleting the key as the clock starts leaves a race with no way to count.
  const { store, recorded } = fakeStore();

  const outcome = await activateRacer(store, adapter(), true);

  assert.equal(outcome.ok, true);
  assert.equal(
    recorded.some((r) => r.method === "deleteCredential"),
    false,
    "the key was deleted on a successful activation",
  );
});