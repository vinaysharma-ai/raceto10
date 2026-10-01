import assert from "node:assert/strict";
import { test } from "node:test";

import { FAKE_RESTRICTED_LIVE_KEY } from "../test-fixtures.ts";

import {
  CredentialError,
  createStripeRestrictedKeyAdapter,
  describeFailure,
  monthlyMinor,
  type StripeRestrictedPort,
} from "./restricted.ts";

/**
 * The restricted-key Stripe adapter.
 *
 * Run against a fake port, so every line of real logic is exercised and no
 * network or key material is involved. The contract suite already covers the
 * shared shape; this file covers what is specific to a pasted key — that a
 * writable one is refused, that identity comes from the key, and that the key
 * itself never surfaces in anything the layer above can see.
 */

const KEY = FAKE_RESTRICTED_LIVE_KEY;
const ACCOUNT = "acct_1AbCdEfGhIjKlMnO";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

/** Records every key it was handed, so a test can assert what crossed the seam. */
function fakePort(overrides: Partial<StripeRestrictedPort> = {}): {
  port: StripeRestrictedPort;
  seen: string[];
} {
  const seen: string[] = [];

  const port: StripeRestrictedPort = {
    async account(secretKey) {
      seen.push(secretKey);
      return { id: ACCOUNT, label: "Ledgerly", canWrite: false };
    },
    customers() {
      return (async function* () {})();
    },
    charges() {
      return (async function* () {})();
    },
    ...overrides,
  };

  return { port, seen };
}

function adapterWith(port: StripeRestrictedPort) {
  return createStripeRestrictedKeyAdapter(port, {
    resolveCredential: async (ref) => {
      if (ref !== CONNECTION_ID) throw new Error("no such credential");
      return KEY;
    },
  });
}

const connected = {
  provider: "stripe" as const,
  accountId: ACCOUNT,
  credentialRef: CONNECTION_ID,
};

// ---------------------------------------------------------------------------
// Capability honesty
// ---------------------------------------------------------------------------

test("the declared capabilities describe a pasted key, not a consent screen", () => {
  const { port } = fakePort();
  const adapter = adapterWith(port);

  assert.equal(adapter.capabilities.connectionMethod, "credential_paste");
  // The distinction the UI depends on: there is no redirect for this flow.
  assert.equal(adapter.capabilities.consentScreen, false);
  assert.equal(adapter.capabilities.credentialScope, "read_only");
  // We cannot rotate a racer's key, and saying otherwise would be a lie the
  // reconciliation job would act on.
  assert.equal(adapter.capabilities.credentialRotatable, false);
  // Restricted keys cannot deliver webhooks — the reason verification polls.
  assert.equal(adapter.capabilities.webhookRegistration, "merchant");
});

test("beginConnection returns instructions rather than a redirect", async () => {
  const { port } = fakePort();
  const result = await adapterWith(port).beginConnection({
    racerId: "r1",
    state: "s1",
  });

  assert.equal(result.kind, "credential");
  if (result.kind === "credential") {
    assert.match(result.instructions, /restricted key/i);
    assert.match(result.instructions, /read/i);
  }
});

// ---------------------------------------------------------------------------
// A valid restricted key
// ---------------------------------------------------------------------------

test("a valid restricted key identifies the account", async () => {
  const { port, seen } = fakePort();
  const connection = await adapterWith(port).completeConnection({ apiKey: KEY });

  assert.equal(connection.provider, "stripe");
  assert.equal(connection.accountId, ACCOUNT);
  assert.equal(connection.accountLabel, "Ledgerly");
  assert.deepEqual(seen, [KEY]);
});

test("the returned connection carries no credential value", async () => {
  // The contract's central invariant: a raw credential must not be able to
  // travel through this layer. Serialising the result is the closest thing to
  // "what a caller could accidentally log" that a test can assert.
  const { port } = fakePort();
  const connection = await adapterWith(port).completeConnection({ apiKey: KEY });

  const serialised = JSON.stringify(connection);
  assert.equal(serialised.includes(KEY), false);
  assert.equal(serialised.includes("rk_live"), false);
  assert.equal(Object.values(connection).includes(KEY), false);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a rejected key is refused without echoing the key", async () => {
  const { port } = fakePort({
    account: async () => {
      throw { statusCode: 401, type: "invalid_request_error" };
    },
  });

  await assert.rejects(
    () => adapterWith(port).completeConnection({ apiKey: KEY }),
    (error: unknown) => {
      assert.ok(error instanceof CredentialError);
      assert.equal(error.reason, "rejected");
      // The message is the category, never Stripe's text — which can quote the
      // key back, and which is the string that would reach a log line.
      assert.equal(error.message.includes(KEY), false);
      return true;
    },
  );
});

test("a key without the needed permission is distinguished from a bad one", async () => {
  // 403 and 401 need different actions from the racer: edit the key, versus
  // start again. Collapsing them into "something went wrong" is the difference
  // between an actionable message and a useless one.
  const { port } = fakePort({
    account: async () => {
      throw { statusCode: 403 };
    },
  });

  await assert.rejects(
    () => adapterWith(port).completeConnection({ apiKey: KEY }),
    (error: unknown) => error instanceof CredentialError && error.reason === "insufficient_permission",
  );
});

test("a writable key is refused outright", async () => {
  // A racer who pastes a full-access key has handed over far more than they
  // intended. Accepting it and hoping would be the wrong trade.
  const { port } = fakePort({
    account: async () => ({ id: ACCOUNT, label: "Ledgerly", canWrite: true }),
  });

  await assert.rejects(
    () => adapterWith(port).completeConnection({ apiKey: KEY }),
    (error: unknown) => error instanceof CredentialError && error.reason === "not_read_only",
  );
});

test("an unrecognised failure is unavailable, not a crash", async () => {
  const { port } = fakePort({
    account: async () => {
      throw new Error("socket hang up");
    },
  });

  await assert.rejects(
    () => adapterWith(port).completeConnection({ apiKey: KEY }),
    (error: unknown) => error instanceof CredentialError && error.reason === "unavailable",
  );
});

test("describeFailure maps only what it recognises", () => {
  assert.equal(describeFailure({ statusCode: 401 }), "rejected");
  assert.equal(describeFailure({ statusCode: 403 }), "insufficient_permission");
  assert.equal(describeFailure({ statusCode: 429 }), "unavailable");
  assert.equal(describeFailure({ statusCode: 500 }), "unavailable");
  assert.equal(describeFailure(null), "unavailable");
  assert.equal(describeFailure(undefined), "unavailable");
  assert.equal(describeFailure("a string"), "unavailable");
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("a connection with no credential reference cannot read", async () => {
  const { port } = fakePort();
  const adapter = adapterWith(port);

  await assert.rejects(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of adapter.listCustomers(
        { provider: "stripe", accountId: ACCOUNT },
        new Date(),
      )) {
        // no rows expected
      }
    },
    (error: unknown) => error instanceof CredentialError,
  );
});

test("an unresolvable reference is refused rather than sent as a key", async () => {
  // The failure that would matter most in production: an empty string passed to
  // Stripe as a credential. The resolver throws, and that becomes a refusal.
  const { port } = fakePort();
  const adapter = adapterWith(port);

  await assert.rejects(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of adapter.listCustomers(
        { provider: "stripe", accountId: ACCOUNT, credentialRef: "does-not-exist" },
        new Date(),
      )) {
        // no rows expected
      }
    },
    (error: unknown) => error instanceof CredentialError && error.reason === "rejected",
  );
});

test("the baseline boundary is exclusive, so a customer at the instant is not counted", async () => {
  const until = new Date("2026-09-01T00:00:00.000Z");
  const at = Math.floor(until.getTime() / 1000);

  const { port } = fakePort({
    customers: () =>
      (async function* () {
        // One second before — an existing customer.
        yield { id: "cus_before", created: at - 1 };
        // Exactly at the boundary — a NEW customer, not a baseline one.
        yield { id: "cus_at", created: at };
        // Deleted customers are not customers.
        yield { id: "cus_deleted", created: at - 5, deleted: true };
      })(),
  });

  const ids: string[] = [];
  for await (const customer of adapterWith(port).listCustomers(connected, until)) {
    ids.push(customer.externalId);
  }

  assert.deepEqual(ids, ["cus_before"]);
});

test("payments count only successful, non-zero, identified charges", async () => {
  const since = new Date("2026-09-01T00:00:00.000Z");
  const until = new Date("2026-09-08T00:00:00.000Z");
  const at = Math.floor(since.getTime() / 1000);

  const base = { created: at + 10, currency: "usd" };

  const { port } = fakePort({
    charges: () =>
      (async function* () {
        yield { id: "ok", ...base, amount: 2000, paid: true, status: "succeeded", customer: "cus_1" };
        yield { id: "failed", ...base, amount: 2000, paid: false, status: "failed", customer: "cus_2" };
        yield { id: "zero", ...base, amount: 0, paid: true, status: "succeeded", customer: "cus_3" };
        yield { id: "guest", ...base, amount: 2000, paid: true, status: "succeeded", customer: null };
      })(),
  });

  const ids: string[] = [];
  for await (const payment of adapterWith(port).listPayments(connected, { since, until })) {
    ids.push(payment.externalPaymentId);
  }

  assert.deepEqual(ids, ["ok"]);
});

test("a provider failure mid-pagination is reduced to a category", async () => {
  // Regression test for a real leak. `withCredential` wraps `await run(key)`,
  // but an async generator function returns its generator immediately and runs
  // the body lazily — so that try covered only generator *creation*, and every
  // error thrown while paging escaped unwrapped.
  //
  // Stripe answers a bad key with `"Invalid API Key provided: rk_live_51abc***"`,
  // quoting the credential's own prefix. This asserts that text cannot reach a
  // caller, and therefore cannot reach a log line.
  const { port } = fakePort({
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
        // Fails part-way through the page, as a real 401 would.
        throw Object.assign(
          new Error(`Invalid API Key provided: `),
          { statusCode: 401 },
        );
      })(),
  });

  await assert.rejects(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of adapterWith(port).listPayments(connected, {
        since: new Date(0),
        until: new Date(),
      })) {
        // no rows expected
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof CredentialError, `escaped as ${String(error)}`);
      assert.equal(error.reason, "rejected");
      assert.equal(error.message.includes("rk_live"), false);
      assert.equal(error.message.includes("51abc"), false);
      return true;
    },
  );
});

test("a customer-list failure mid-pagination is reduced too", async () => {
  const { port } = fakePort({
    customers: () =>
      (async function* () {
        yield { id: "cus_1", created: 1 };
        throw Object.assign(
          new Error(`Invalid API Key provided: `), {
          statusCode: 401,
        });
      })(),
  });

  await assert.rejects(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of adapterWith(port).listCustomers(connected, new Date())) {
        // no rows expected
      }
    },
    (error: unknown) => error instanceof CredentialError && error.message.includes("rk_live") === false,
  );
});

test("verifyWebhook returns null, because restricted keys cannot deliver one", async () => {
  const { port } = fakePort();
  assert.equal(await adapterWith(port).verifyWebhook("{}", new Headers()), null);
});

// ---------------------------------------------------------------------------
// MRR maths
// ---------------------------------------------------------------------------

test("monthlyMinor normalises each interval to a month", () => {
  assert.equal(monthlyMinor({ unit_amount: 2000, recurring: { interval: "month" } }), 2000);
  assert.equal(monthlyMinor({ unit_amount: 24000, recurring: { interval: "year" } }), 2000);
  assert.equal(monthlyMinor({ unit_amount: 1000, recurring: { interval: "week" } }), 4333);
  assert.equal(monthlyMinor({ unit_amount: 500, recurring: { interval: "month", interval_count: 3 } }), 167);
});

test("monthlyMinor multiplies by quantity", () => {
  assert.equal(
    monthlyMinor({ unit_amount: 1000, recurring: { interval: "month" } }, 5),
    5000,
  );
});

test("an interval we do not model is unknown, not zero", () => {
  // Returning 0 would report "no recurring revenue" for a subscription that
  // plainly has some, which is the one direction this must never fail in.
  assert.equal(monthlyMinor({ unit_amount: 1000, recurring: { interval: "fortnight" } }), null);
  assert.equal(monthlyMinor({ unit_amount: 1000, recurring: null }), null);
  assert.equal(monthlyMinor({ unit_amount: null, recurring: { interval: "month" } }), null);
});
