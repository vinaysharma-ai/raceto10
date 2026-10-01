import assert from "node:assert/strict";
import { test } from "node:test";

import { FAKE_RESTRICTED_LIVE_KEY } from "./test-fixtures.ts";

import {
  connectProviderAccount,
  markConnectionInvalid,
  type ConnectionStore,
  type ExistingConnection,
} from "./connect.ts";
import { CredentialError, createStripeRestrictedKeyAdapter, type StripeRestrictedPort } from "./stripe/restricted.ts";

/**
 * Connecting an account, against a fake store.
 *
 * ## What this file is really checking
 *
 * Two things the requirements call out that are easy to believe without
 * checking:
 *
 *   * **Ownership.** The racer comes from the session, so `currentRacerId` is
 *     the only source. Several tests swap it and assert nothing crosses.
 *   * **Secrecy.** The fake store records every call it receives. A test then
 *     asserts the plaintext key appears in *none* of them except the one seal
 *     that is supposed to carry it — which is a stronger claim than checking a
 *     return value, because it covers the writes too.
 */

const KEY = FAKE_RESTRICTED_LIVE_KEY;
const ACCOUNT = "acct_1AbCdEfGhIjKlMnO";
const RACER = "racer-ada";
const OTHER_RACER = "racer-grace";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

type Recorded = { method: string; args: unknown[] };

function fakeStore(
  overrides: Partial<ConnectionStore> = {},
  options: { racerId?: string | null; existing?: ExistingConnection | null; heldBy?: { id: string; racerId: string } | null } = {},
): { store: ConnectionStore; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const log = (method: string, ...args: unknown[]) => recorded.push({ method, args });

  const store: ConnectionStore = {
    async currentRacerId() {
      log("currentRacerId");
      return options.racerId === undefined ? RACER : options.racerId;
    },
    async findOwnConnection(racerId, provider) {
      log("findOwnConnection", racerId, provider);
      return options.existing ?? null;
    },
    async findConnectionByAccount(provider, accountId) {
      log("findConnectionByAccount", provider, accountId);
      return options.heldBy ?? null;
    },
    async insertConnection(row) {
      log("insertConnection", row);
      return { id: CONNECTION_ID };
    },
    async updateConnection(id, patch) {
      log("updateConnection", id, patch);
    },
    async putCredential(connectionId, sealed) {
      log("putCredential", connectionId, sealed);
    },
    async clearCredential(connectionId) {
      log("clearCredential", connectionId);
    },
    async insertSnapshot(row) {
      log("insertSnapshot", row);
    },
    seal(plaintext, connectionId) {
      log("seal", plaintext, connectionId);
      return { ciphertext: `sealed:${connectionId}`, keyVersion: 1 };
    },
    ...overrides,
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
    ...overrides,
  };

  return createStripeRestrictedKeyAdapter(port, {
    resolveCredential: async () => KEY,
  });
}

// ---------------------------------------------------------------------------
// A valid key
// ---------------------------------------------------------------------------

test("a valid restricted key connects and stores both rows", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // Account identity, from the key itself rather than from anything submitted.
  assert.equal(outcome.accountId, ACCOUNT);
  assert.equal(outcome.accountLabel, "Ledgerly");
  assert.equal(outcome.replaced, false);
  assert.equal(outcome.rotated, false);

  const inserted = recorded.find((r) => r.method === "insertConnection");
  assert.ok(inserted, "a connection row was written");
  const row = inserted.args[0] as Record<string, unknown>;
  assert.equal(row.racerId, RACER);
  assert.equal(row.provider, "stripe");
  assert.equal(row.status, "connected");

  // The metadata row must not carry the key. This is the separation the two
  // tables exist for.
  assert.equal(JSON.stringify(row).includes(KEY), false);

  const put = recorded.find((r) => r.method === "putCredential");
  assert.deepEqual(put?.args, [CONNECTION_ID, { ciphertext: `sealed:${CONNECTION_ID}`, keyVersion: 1 }]);
});

test("the plaintext key reaches the seal and nothing else", async () => {
  // The strongest secrecy claim this suite can make: the fake store records
  // every argument of every call, so this covers the writes as well as the
  // return value.
  const { store, recorded } = fakeStore();
  await connectProviderAccount(store, adapter(), KEY);

  const carrying = recorded.filter((r) => JSON.stringify(r.args).includes(KEY));

  assert.equal(carrying.length, 1, `key appeared in ${carrying.map((c) => c.method).join(", ")}`);
  assert.equal(carrying[0]?.method, "seal");
});

test("the outcome carries no credential", async () => {
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(store, adapter(), KEY);
  assert.equal(JSON.stringify(outcome).includes(KEY), false);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("an invalid key is refused and writes nothing", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    adapter({
      account: async () => {
        throw { statusCode: 401 };
      },
    }),
    KEY,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "rejected");
    assert.equal(outcome.message.includes(KEY), false);
  }

  // Validation happens before any row exists, so a bad key leaves no trace.
  assert.equal(recorded.some((r) => r.method === "insertConnection"), false);
  assert.equal(recorded.some((r) => r.method === "putCredential"), false);
});

test("a writable key is refused", async () => {
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    adapter({ account: async () => ({ id: ACCOUNT, canWrite: true }) }),
    KEY,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "not_read_only");
});

test("an unauthenticated caller never reaches Stripe", async () => {
  // Step 1 is the racer, before the provider is called. An anonymous request
  // should not be able to make us contact Stripe at all.
  let called = false;
  const { store } = fakeStore({}, { racerId: null });

  const outcome = await connectProviderAccount(
    store,
    adapter({
      account: async () => {
        called = true;
        return { id: ACCOUNT, canWrite: false };
      },
    }),
    KEY,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "no_racer");
  assert.equal(called, false, "the provider was contacted for an anonymous caller");
});

// ---------------------------------------------------------------------------
// Ownership isolation
// ---------------------------------------------------------------------------

test("an account another racer already holds is refused", async () => {
  const { store, recorded } = fakeStore({}, { heldBy: { id: "other-conn", racerId: OTHER_RACER } });
  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "account_in_use");

  // Nothing was written against the other racer's connection.
  assert.equal(recorded.some((r) => r.method === "updateConnection"), false);
  assert.equal(recorded.some((r) => r.method === "putCredential"), false);
});

test("reconnecting your own account is not treated as somebody else's", async () => {
  // The holder check compares racer ids, so a racer re-submitting their own key
  // must not be refused by their own connection.
  const { store } = fakeStore(
    {},
    {
      existing: { id: CONNECTION_ID, accountId: ACCOUNT, status: "connected" },
      heldBy: { id: CONNECTION_ID, racerId: RACER },
    },
  );

  const outcome = await connectProviderAccount(store, adapter(), KEY);
  assert.equal(outcome.ok, true);
});

test("every lookup is scoped to the session racer", async () => {
  const { store, recorded } = fakeStore();
  await connectProviderAccount(store, adapter(), KEY);

  const own = recorded.find((r) => r.method === "findOwnConnection");
  assert.equal(own?.args[0], RACER);

  const insert = recorded.find((r) => r.method === "insertConnection");
  assert.equal((insert?.args[0] as Record<string, unknown>).racerId, RACER);
});

// ---------------------------------------------------------------------------
// Repeated connect / update
// ---------------------------------------------------------------------------

test("reconnecting updates in place rather than creating a second row", async () => {
  const { store, recorded } = fakeStore(
    {},
    { existing: { id: CONNECTION_ID, accountId: ACCOUNT, status: "connected" } },
  );

  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.replaced, true);
  assert.equal(outcome.rotated, true);
  assert.equal(outcome.connectionId, CONNECTION_ID);

  assert.equal(recorded.some((r) => r.method === "insertConnection"), false, "a second row was created");

  const update = recorded.find((r) => r.method === "updateConnection");
  assert.equal(update?.args[0], CONNECTION_ID);
  assert.equal((update?.args[1] as Record<string, unknown>).status, "connected");
});

test("re-submitting the same key replaces the stored credential", async () => {
  // The racer pasted a key; the reasonable reading is that they want this one
  // used. Re-sealing is idempotent from their point of view.
  const { store, recorded } = fakeStore(
    {},
    { existing: { id: CONNECTION_ID, accountId: ACCOUNT, status: "connected" } },
  );

  await connectProviderAccount(store, adapter(), KEY);

  const put = recorded.find((r) => r.method === "putCredential");
  assert.deepEqual(put?.args, [CONNECTION_ID, { ciphertext: `sealed:${CONNECTION_ID}`, keyVersion: 1 }]);
});

test("switching to a different account clears the old credential first", async () => {
  // Otherwise we would keep holding a live key for an account this racer no
  // longer races with — a credential with no purpose is a liability.
  const { store, recorded } = fakeStore(
    {},
    { existing: { id: CONNECTION_ID, accountId: "acct_OLD", status: "connected" } },
  );

  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.accountId, ACCOUNT);

  const order = recorded.map((r) => r.method);
  assert.ok(order.includes("clearCredential"), "the old credential was cleared");
  assert.ok(
    order.indexOf("clearCredential") < order.indexOf("putCredential"),
    "the clear must precede the re-seal, or a failure between them leaves two live keys",
  );
});

test("a connection that had gone invalid is repaired in place", async () => {
  const { store, recorded } = fakeStore(
    {},
    { existing: { id: CONNECTION_ID, accountId: ACCOUNT, status: "invalid" } },
  );

  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  assert.equal(recorded.some((r) => r.method === "insertConnection"), false);

  const update = recorded.find((r) => r.method === "updateConnection");
  assert.equal((update?.args[1] as Record<string, unknown>).status, "connected");
  assert.equal((update?.args[1] as Record<string, unknown>).errorCode, null);
});

// ---------------------------------------------------------------------------
// Revoked connections
// ---------------------------------------------------------------------------

test("a revoked key is marked on the connection, not thrown away", async () => {
  // The row and its history stay; only the status moves. Deleting would lose
  // the fact that a racer once connected, which the race needs to know.
  const { store, recorded } = fakeStore();
  await markConnectionInvalid(store, CONNECTION_ID, "rejected");

  const update = recorded.find((r) => r.method === "updateConnection");
  assert.equal(update?.args[0], CONNECTION_ID);
  assert.equal((update?.args[1] as Record<string, unknown>).status, "revoked");
  assert.equal((update?.args[1] as Record<string, unknown>).errorCode, "rejected");
});

test("a permission failure and a rejection are recorded differently", async () => {
  // They need different fixes: one is "edit your key in Stripe", the other is
  // "make a new one". Collapsing them loses the only actionable part.
  const a = fakeStore();
  await markConnectionInvalid(a.store, CONNECTION_ID, "rejected");
  assert.equal((a.recorded[0]?.args[1] as Record<string, unknown>).status, "revoked");

  const b = fakeStore();
  await markConnectionInvalid(b.store, CONNECTION_ID, "insufficient_permission");
  assert.equal((b.recorded[0]?.args[1] as Record<string, unknown>).status, "invalid");
});

test("failing to record a failure does not propagate", async () => {
  // The read has already been reported unhealthy. Throwing here would turn a
  // bookkeeping problem into a failed reconcile.
  const { store } = fakeStore({
    updateConnection: async () => {
      throw new Error("database is down");
    },
  });

  await assert.doesNotReject(() => markConnectionInvalid(store, CONNECTION_ID, "rejected"));
});

// ---------------------------------------------------------------------------
// Storage failures
// ---------------------------------------------------------------------------

test("a storage failure is reported as retryable, not as a bad key", async () => {
  // Telling a racer their key is bad when the database hiccuped sends them to
  // Stripe's dashboard to fix something that is not wrong.
  const { store } = fakeStore({
    insertConnection: async () => {
      throw new Error("connection refused");
    },
  });

  const outcome = await connectProviderAccount(store, adapter(), KEY);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "storage_error");
});

test("an unrecognised adapter failure is not reported as a credential verdict", async () => {
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    adapter({
      account: async () => {
        throw new Error("socket hang up");
      },
    }),
    KEY,
  );

  assert.equal(outcome.ok, false);
  // The adapter maps an unknown throw to `unavailable`; either way it must not
  // be `rejected`, which would send the racer to re-create a working key.
  if (!outcome.ok) assert.notEqual(outcome.reason, "rejected");
});

// ---------------------------------------------------------------------------
// The entry gate
// ---------------------------------------------------------------------------

/** A port that can read subscriptions, so MRR is answerable. */
function withSubscriptions(
  subscriptions: NonNullable<StripeRestrictedPort["subscriptions"]>,
  overrides: Partial<StripeRestrictedPort> = {},
) {
  return adapter({ subscriptions, ...overrides });
}

function subscription(amountMinor: number, interval = "month") {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: {
      data: [{ quantity: 1, price: { unit_amount: amountMinor, currency: "usd", recurring: { interval, interval_count: 1 } } }],
    },
  };
}

test("an account starting from zero is eligible", async () => {
  const { store, recorded } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    withSubscriptions(() => (async function* () {})()),
    KEY,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.eligibility, { status: "eligible" });

  const snap = recorded.find((r) => r.method === "insertSnapshot");
  const row = snap?.args[0] as Record<string, unknown>;
  assert.equal(row.status, "eligible");
  assert.equal(row.source, "registration");
  assert.equal(row.customerCount, 0);
  assert.equal(row.mrrMinor, 0);
});

test("an account with a paying customer is ineligible", async () => {
  const { store, recorded } = fakeStore();

  const outcome = await connectProviderAccount(
    store,
    withSubscriptions(
      () => (async function* () {})(),
      {
        charges: () =>
          (async function* () {
            yield {
              id: "ch_1",
              created: 1_700_000_000,
              amount: 2000,
              currency: "usd",
              paid: true,
              status: "succeeded",
              customer: "cus_1",
            };
          })(),
      },
    ),
    KEY,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.eligibility, { status: "ineligible", reason: "has_customers" });

  const row = recorded.find((r) => r.method === "insertSnapshot")?.args[0] as Record<string, unknown>;
  assert.equal(row.status, "ineligible");
  assert.equal(row.customerCount, 1);
  // The scan stopped at the first hit, so the row must say so rather than
  // letting a later reader mistake a floor for a total.
  assert.equal(row.errorCode, "count_truncated");
});

test("an account with recurring revenue is ineligible", async () => {
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    withSubscriptions(() => (async function* () { yield subscription(4900); })()),
    KEY,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.eligibility, { status: "ineligible", reason: "has_mrr" });
});

test("a key that cannot read subscriptions leaves the gate undecided, not open", async () => {
  // The important negative. The default fake port has no `subscriptions`, so
  // MRR is unanswerable — and treating that as zero would admit someone with
  // subscribers. It must not report eligible.
  const { store, recorded } = fakeStore();

  // `adapter()` with no subscriptions override.
  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.eligibility.status, "unknown");
  const row = recorded.find((r) => r.method === "insertSnapshot")?.args[0] as Record<string, unknown>;
  assert.equal(row.status, "ineligible");
  assert.equal(row.errorCode, "unsupported");
});

test("the connection stands even when the gate cannot be decided", async () => {
  // A key that works is a key that works. Reporting a connect failure here
  // would send the racer to re-paste a valid credential.
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(store, adapter(), KEY);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.connectionId, CONNECTION_ID);
});

test("an MRR read that fails inside the adapter is recorded as unavailable", async () => {
  // The adapter catches its own provider failure and reports `unavailable`, so
  // this does NOT reach the probe's failure path — the gate is undecided, and
  // the snapshot says why rather than claiming the account has no revenue.
  const { store, recorded } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    withSubscriptions(() => {
      throw new Error("stripe unreachable");
    }),
    KEY,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.eligibility.status, "unknown");

  const row = recorded.find((r) => r.method === "insertSnapshot")?.args[0] as Record<string, unknown>;
  assert.equal(row.status, "ineligible");
  assert.equal(row.errorCode, "unavailable");
  assert.equal(row.mrrMinor, null, "unknown MRR is null, never 0");
});

test("a customer scan that throws is recorded as a failed check", async () => {
  // This is the path that actually reaches `probe_failed`: the failure escapes
  // `readEligibilityFacts` rather than being caught by the adapter.
  const { store, recorded } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    withSubscriptions(
      () => (async function* () {})(),
      {
        charges: () => {
          throw new Error("stripe unreachable");
        },
      },
    ),
    KEY,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.eligibility.status, "unknown");

  const row = recorded.find((r) => r.method === "insertSnapshot")?.args[0] as Record<string, unknown>;
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "probe_failed");
});

test("a failing snapshot write does not fail a successful connect", async () => {
  // Bookkeeping must not become the reason a working connection is reported
  // as broken.
  const { store } = fakeStore({
    insertSnapshot: async () => {
      throw new Error("database is down");
    },
  });

  const outcome = await connectProviderAccount(store, adapter(), KEY);
  assert.equal(outcome.ok, true);
});

test("the gate never sees a credential", async () => {
  // The probe runs against the provider, which resolves the key internally.
  // The snapshot row it produces must not carry anything derived from it.
  const { store, recorded } = fakeStore();
  await connectProviderAccount(store, adapter(), KEY);

  for (const call of recorded) {
    if (call.method === "insertSnapshot") {
      assert.equal(JSON.stringify(call.args).includes(KEY), false);
    }
  }
});

test("a CredentialError from the adapter keeps its category", async () => {
  const { store } = fakeStore();
  const outcome = await connectProviderAccount(
    store,
    adapter({
      account: async () => {
        throw new CredentialError("insufficient_permission");
      },
    }),
    KEY,
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "insufficient_permission");
});
