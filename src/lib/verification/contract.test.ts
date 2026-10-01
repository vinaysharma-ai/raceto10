import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { runAdapterContract, summarise } from "./contract.ts";
import type {
  BeginConnectionResult,
  ExternalCustomer,
  ProviderConnection,
  ProviderEvent,
  ProviderPayment,
  VerificationProvider,
} from "./types.ts";

/**
 * The contract suite, exercised in both directions.
 *
 * A contract test that has only ever been run against a passing adapter proves
 * nothing — it is indistinguishable from one that asserts nothing at all. So
 * this file runs it twice: once against a fake that satisfies the contract, and
 * once against a stub that does not, asserting that the specific checks which
 * should catch the stub's faults actually fire.
 *
 * No provider adapter exists yet (the Stripe adapter is step 8). These fakes are
 * what the suite is developed against, and they stay useful afterwards as the
 * reference implementation of the contract.
 */

const CONNECTION: ProviderConnection = {
  provider: "stripe",
  accountId: "acct_fake_123",
  accountLabel: "Fake Co",
};

const SECRET = "test-secret-not-a-real-key";

// ---------------------------------------------------------------------------
// A fake that satisfies the contract.
// ---------------------------------------------------------------------------

function customer(id: string, createdAt: string): ExternalCustomer {
  return { externalId: id, createdAt: new Date(createdAt) };
}

function payment(id: string, customerId: string, paidAt: string): ProviderPayment {
  return {
    externalCustomerId: customerId,
    externalPaymentId: id,
    paidAt: new Date(paidAt),
    amountMinor: 4900,
    currency: "usd",
    kind: "one_time",
  };
}

const ALL_CUSTOMERS = [
  customer("cus_pre_1", "2023-05-01T00:00:00Z"),
  customer("cus_pre_2", "2023-09-14T00:00:00Z"),
];

const ALL_PAYMENTS = [
  payment("pi_1", "cus_new_1", "2024-01-10T12:00:00Z"),
  payment("pi_2", "cus_new_2", "2024-01-20T12:00:00Z"),
];

const conforming: VerificationProvider = {
  id: "stripe",
  displayName: "Stripe",
  capabilities: {
    connectionMethod: "oauth",
    consentScreen: true,
    credentialScope: "read_only",
    credentialExpires: false,
    credentialRotatable: false,
    webhookRegistration: "platform",
    serverSideDateFilter: true,
    accountScoping: "documented",
  },

  async beginConnection({ state }): Promise<BeginConnectionResult> {
    return {
      kind: "redirect",
      url: `https://connect.example.com/oauth/authorize?x=1&state=${state}`,
    };
  },

  async completeConnection() {
    return CONNECTION;
  },

  async validateConnection() {
    return { ok: true, accountLabel: "Fake Co" };
  },

  async revokeConnection() {},

  async *listCustomers(_conn, until) {
    // A provider with a server-side date filter honours the bound exactly.
    for (const c of ALL_CUSTOMERS) if (c.createdAt <= until) yield c;
  },

  async *listPayments(_conn, window) {
    for (const p of ALL_PAYMENTS) {
      if (p.paidAt >= window.since && p.paidAt < window.until) yield p;
    }
  },

  async verifyWebhook(rawBody, headers): Promise<ProviderEvent | null> {
    const supplied = headers.get("x-signature");
    const expected = createHash("sha256").update(SECRET + rawBody).digest("hex");
    if (!supplied || supplied !== expected) return null;
    const parsed = JSON.parse(rawBody) as { id: string; type: string };
    return { id: parsed.id, type: parsed.type, accountId: CONNECTION.accountId, raw: parsed };
  },
};

const signWebhook = (body: string) => ({
  rawBody: body,
  headers: new Headers({
    "x-signature": createHash("sha256").update(SECRET + body).digest("hex"),
  }),
});

// ---------------------------------------------------------------------------
// A stub — what you actually write first, before implementing anything.
//
// Its capability declarations are also deliberately contradictory, because that
// is the realistic mistake: a provider that claims read-only access while asking
// the racer to paste a credential would tell users something untrue about what
// they are handing over.
// ---------------------------------------------------------------------------

const stub: VerificationProvider = {
  id: "lemonsqueezy",
  displayName: "", // not filled in yet
  capabilities: {
    connectionMethod: "credential_paste",
    consentScreen: true, // wrong: a pasted credential has no consent screen
    credentialScope: "read_only", // wrong: a pasted key cannot be scoped
    credentialExpires: true,
    credentialRotatable: false,
    webhookRegistration: "merchant",
    serverSideDateFilter: true, // claims it, does not do it
    accountScoping: "unclear",
  },

  async beginConnection() {
    return undefined as unknown as BeginConnectionResult; // not implemented
  },

  async completeConnection() {
    return CONNECTION;
  },

  async validateConnection() {
    return { ok: true };
  },

  async revokeConnection() {},

  async *listCustomers() {
    yield ALL_CUSTOMERS[0];
    yield ALL_CUSTOMERS[0]; // duplicate id — would double-count a baseline
    yield ALL_CUSTOMERS[1];
  },

  async *listPayments() {
    yield ALL_PAYMENTS[0];
    yield payment("pi_leaked", "cus_x", "2025-06-01T00:00:00Z"); // outside the window
  },

  // Accepts anything — the failure mode that lets forged webhooks through.
  async verifyWebhook(rawBody): Promise<ProviderEvent | null> {
    const parsed = JSON.parse(rawBody) as { id: string; type: string };
    return { id: parsed.id, type: parsed.type, accountId: null, raw: parsed };
  },
};

// ---------------------------------------------------------------------------

test("a conforming adapter passes every check", async () => {
  const results = await runAdapterContract(conforming, {
    connection: CONNECTION,
    signWebhook,
  });

  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(
    failed.map((f) => `${f.name} — ${f.detail}`),
    [],
    "conforming adapter should have no failures",
  );
  assert.ok(results.length >= 14, `expected a substantial suite, got ${results.length} checks`);
});

test("the suite FAILS for a stub adapter — the checks that should fire, do", async () => {
  const results = await runAdapterContract(stub, {
    connection: CONNECTION,
    signWebhook,
  });
  const { failed, failedNames } = summarise(results);

  assert.ok(failed > 0, "the suite must not pass a stub adapter");

  // Each of these is a specific fault deliberately built into the stub above.
  const expected = [
    "capabilities: read_only implies a consent flow",
    "capabilities: credential paste cannot be scoped to read_only",
    "capabilities: credential paste implies no consent screen",
    "capabilities: id and display name are set",
    "beginConnection returns a well-formed result",
    "listCustomers yields no duplicate ids",
    "listPayments stays inside the requested window",
    "listCustomers respects the `until` bound when the provider can filter",
    "verifyWebhook rejects an unsigned body",
  ];

  for (const name of expected) {
    assert.ok(
      failedNames.includes(name),
      `expected the suite to catch "${name}". Caught: ${failedNames.join(" | ")}`,
    );
  }

  console.log(`\n  stub adapter failed ${failed}/${results.length} checks:`);
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`    - ${r.name}: ${r.detail}`);
  }
});

test("verifyWebhook's tampered-body check has teeth", async () => {
  // A provider that verifies a signature over re-serialised JSON rather than the
  // raw bytes passes a naive happy-path test and fails this one.
  const reserialising: VerificationProvider = {
    ...conforming,
    async verifyWebhook(_rawBody, headers) {
      const supplied = headers.get("x-signature");
      // Hashes a *normalised* body instead of the bytes that arrived.
      const normalised = JSON.stringify({ id: "evt_ok", type: "order_created" });
      const expected = createHash("sha256").update(SECRET + normalised).digest("hex");
      if (!supplied || supplied !== expected) return null;
      return { id: "evt_ok", type: "order_created", accountId: null, raw: null };
    },
  };

  const results = await runAdapterContract(reserialising, {
    connection: CONNECTION,
    signWebhook,
  });
  const tampered = results.find((r) => r.name === "verifyWebhook rejects a tampered body");
  assert.ok(tampered, "tampered-body check should be part of the suite");
  assert.equal(tampered.ok, false, "a re-serialising verifier must fail this check");
});
