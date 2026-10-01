import assert from "node:assert/strict";
import { test } from "node:test";

import { runAdapterContract, summarise } from "../contract.ts";
import type { ProviderConnection } from "../types.ts";
import { createStripeAdapter, type StripePort } from "./adapter.ts";

/**
 * The Stripe adapter, run against the shared contract suite with a fake port,
 * plus the Stripe-specific behaviours the generic suite cannot know about.
 *
 * No network and no API keys: the port is the seam. Everything here is the real
 * adapter code from `adapter.ts`, including its paging, filtering and signature
 * handling — only the HTTP call is substituted.
 */

const CONNECTION: ProviderConnection = {
  provider: "stripe",
  accountId: "acct_connected_1",
};

const CLIENT_ID = "ca_test_client_id";
const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";

const UNTIL = new Date("2024-01-01T00:00:00Z");
const WINDOW = {
  since: new Date("2024-01-01T00:00:00Z"),
  until: new Date("2024-02-01T00:00:00Z"),
};

const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// ---------------------------------------------------------------------------
// A fake Stripe, recording what the adapter asked for.
// ---------------------------------------------------------------------------

type Recorded = {
  customerListParams?: unknown;
  chargeListParams?: unknown;
  accountHeader?: string;
  deauthorized?: unknown;
  tokenParams?: unknown;
};

function makePort(
  data: {
    customers?: Array<{ id: string; created: number; email?: string | null; deleted?: boolean }>;
    charges?: Array<{
      id: string;
      created: number;
      amount: number;
      currency: string;
      paid: boolean;
      status: string;
      customer?: string | { id: string } | null;
      invoice?: string | null;
    }>;
    tokenFails?: boolean;
    signatureValid?: boolean;
  } = {},
  recorded: Recorded = {},
): StripePort {
  return {
    oauth: {
      async token(params) {
        recorded.tokenParams = params;
        if (data.tokenFails) throw new Error("invalid_grant");
        return { stripe_user_id: "acct_new", scope: "read_only", livemode: false };
      },
      async deauthorize(params) {
        recorded.deauthorized = params;
        return { stripe_user_id: params.stripe_user_id };
      },
    },
    accounts: {
      async retrieve(id) {
        return {
          id,
          email: "owner@example.com",
          settings: { dashboard: { display_name: "Ada's Bakery" } },
        };
      },
    },
    customers: {
      async *list(params, options) {
        recorded.customerListParams = params;
        recorded.accountHeader = options.stripeAccount;
        for (const c of data.customers ?? []) yield c;
      },
    },
    charges: {
      async *list(params, options) {
        recorded.chargeListParams = params;
        recorded.accountHeader = options.stripeAccount;
        for (const c of data.charges ?? []) yield c;
      },
    },
    webhooks: {
      constructEvent() {
        if (data.signatureValid === false) throw new Error("No signatures found");
        return { id: "evt_1", type: "charge.succeeded", account: "acct_connected_1" };
      },
    },
  };
}

function adapter(recorded: Recorded = {}, data = {}) {
  return createStripeAdapter(makePort(data, recorded), {
    clientId: CLIENT_ID,
    webhookSecret: WEBHOOK_SECRET,
    redirectUri: "https://raceto10.test/api/connect/stripe/callback",
  });
}

// ---------------------------------------------------------------------------

test("the real Stripe adapter passes the shared contract suite", async () => {
  const provider = adapter({}, {
    customers: [
      { id: "cus_pre_1", created: seconds("2023-03-01T00:00:00Z"), email: "a@example.com" },
      { id: "cus_pre_2", created: seconds("2023-08-01T00:00:00Z") },
    ],
    charges: [
      {
        id: "ch_1",
        created: seconds("2024-01-10T12:00:00Z"),
        amount: 4900,
        currency: "usd",
        paid: true,
        status: "succeeded",
        customer: "cus_new_1",
      },
    ],
  });

  const results = await runAdapterContract(provider, {
    connection: CONNECTION,
    // The adapter delegates signature verification to the SDK, which is not in
    // play here, so the positive webhook cases are exercised in the dedicated
    // tests below instead.
    signWebhook: null,
  });

  const { failed, failedNames } = summarise(results);
  assert.deepEqual(failedNames, [], `adapter should satisfy the contract; failed: ${failed}`);
  assert.ok(failed === 0);
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

test("the authorize URL requests read_only explicitly, and carries state", async () => {
  const begun = await adapter().beginConnection({ racerId: "r1", state: "st_abc123" });
  assert.equal(begun.kind, "redirect");
  if (begun.kind !== "redirect") return;

  const url = new URL(begun.url);
  assert.equal(url.origin, "https://connect.stripe.com");
  assert.equal(url.searchParams.get("scope"), "read_only");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("state"), "st_abc123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://raceto10.test/api/connect/stripe/callback");
});

test("completeConnection returns the connected account and keeps no credential", async () => {
  const recorded: Recorded = {};
  const connection = await adapter(recorded).completeConnection({ code: "ac_test_code" });

  assert.deepEqual(recorded.tokenParams, {
    grant_type: "authorization_code",
    code: "ac_test_code",
  });
  assert.equal(connection.provider, "stripe");
  assert.equal(connection.accountId, "acct_new");

  // The whole point: we hold a reference to an account, not a credential. For a
  // Standard account the token response also carries the account's own API key,
  // and persisting it would be a liability we get nothing for.
  assert.equal(connection.credentialRef, undefined);
  assert.equal(connection.expiresAt, undefined);
  assert.ok(
    !Object.values(connection).some((v) => typeof v === "string" && v.startsWith("sk_")),
    "no API key should appear anywhere on the connection",
  );
});

test("a missing or expired authorization code is a clear, actionable error", async () => {
  await assert.rejects(
    () => adapter().completeConnection({}),
    /single-use.*expires in 5 minutes|no authorization code/i,
  );
});

test("listCustomers and listPayments both scope to the connected account", async () => {
  const recorded: Recorded = {};
  const provider = adapter(recorded);

  // Pull one item: enough to enter the generator body and issue the request.
  await provider.listCustomers(CONNECTION, UNTIL)[Symbol.asyncIterator]().next();
  assert.equal(recorded.accountHeader, "acct_connected_1");

  await provider.listPayments(CONNECTION, WINDOW)[Symbol.asyncIterator]().next();
  assert.equal(recorded.accountHeader, "acct_connected_1");
});

// ---------------------------------------------------------------------------
// The baseline bound — the integrity anchor
// ---------------------------------------------------------------------------

test("the baseline bound is exclusive, and the client-side re-check holds even if Stripe ignores it", async () => {
  const recorded: Recorded = {};
  const until = new Date("2024-01-01T00:00:00Z");

  const provider = adapter(recorded, {
    customers: [
      { id: "cus_before", created: seconds("2023-12-31T23:59:59Z") },
      // Exactly at the boundary — this customer is NEW, not baseline, so the
      // adapter must drop it even though the fake port returns it.
      { id: "cus_at_boundary", created: seconds("2024-01-01T00:00:00Z") },
      { id: "cus_after", created: seconds("2024-01-01T00:00:01Z") },
    ],
  });

  const kept: string[] = [];
  for await (const c of provider.listCustomers(CONNECTION, until)) kept.push(c.externalId);

  assert.deepEqual(kept, ["cus_before"]);

  const params = recorded.customerListParams as { created?: { lt?: number } };
  assert.equal(params.created?.lt, seconds("2024-01-01T00:00:00Z"), "strictly-before bound sent to Stripe");
});

// ---------------------------------------------------------------------------
// What counts as a paying customer
// ---------------------------------------------------------------------------

test("only successful non-zero charges with a customer identity are counted", async () => {
  const provider = adapter({}, {
    charges: [
      // counts
      { id: "ch_ok", created: seconds("2024-01-05T00:00:00Z"), amount: 4900, currency: "usd", paid: true, status: "succeeded", customer: "cus_1" },
      // failed charge
      { id: "ch_failed", created: seconds("2024-01-05T00:00:00Z"), amount: 4900, currency: "usd", paid: false, status: "failed", customer: "cus_2" },
      // unsettled
      { id: "ch_pending", created: seconds("2024-01-05T00:00:00Z"), amount: 4900, currency: "usd", paid: false, status: "pending", customer: "cus_3" },
      // zero-amount
      { id: "ch_zero", created: seconds("2024-01-05T00:00:00Z"), amount: 0, currency: "usd", paid: true, status: "succeeded", customer: "cus_4" },
      // guest checkout — no stable identity to deduplicate on
      { id: "ch_guest", created: seconds("2024-01-05T00:00:00Z"), amount: 4900, currency: "usd", paid: true, status: "succeeded", customer: null },
      // subscription payment, customer given as an expanded object
      { id: "ch_sub", created: seconds("2024-01-06T00:00:00Z"), amount: 2900, currency: "usd", paid: true, status: "succeeded", customer: { id: "cus_5" }, invoice: "in_1" },
    ],
  });

  const seen: Array<{ id: string; customer: string; kind: string }> = [];
  for await (const p of provider.listPayments(CONNECTION, WINDOW)) {
    seen.push({
      id: p.externalPaymentId,
      customer: p.externalCustomerId,
      kind: p.kind,
    });
  }

  assert.deepEqual(seen, [
    { id: "ch_ok", customer: "cus_1", kind: "one_time" },
    { id: "ch_sub", customer: "cus_5", kind: "subscription" },
  ]);
});

test("payments are confined to the window, boundary included on the left only", async () => {
  const provider = adapter({}, {
    charges: [
      { id: "ch_before", created: seconds("2023-12-31T23:59:59Z"), amount: 100, currency: "usd", paid: true, status: "succeeded", customer: "cus_a" },
      { id: "ch_at_start", created: seconds("2024-01-01T00:00:00Z"), amount: 100, currency: "usd", paid: true, status: "succeeded", customer: "cus_b" },
      { id: "ch_at_end", created: seconds("2024-02-01T00:00:00Z"), amount: 100, currency: "usd", paid: true, status: "succeeded", customer: "cus_c" },
    ],
  });

  const kept: string[] = [];
  for await (const p of provider.listPayments(CONNECTION, WINDOW)) kept.push(p.externalPaymentId);

  // Starts inclusively, ends exclusively: a payment exactly at race_end_at is
  // after the race. A payment exactly at race_start_at is the first one that
  // counts.
  assert.deepEqual(kept, ["ch_at_start"]);
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test("verifyWebhook returns null rather than throwing on a bad signature", async () => {
  const provider = adapter({}, { signatureValid: false });
  const result = await provider.verifyWebhook("{}", new Headers({ "stripe-signature": "t=1,v1=bad" }));
  assert.equal(result, null);
});

test("verifyWebhook returns null when the signature header is absent", async () => {
  assert.equal(await adapter().verifyWebhook("{}", new Headers()), null);
});

test("a verified connect event carries the connected account for mapping", async () => {
  const provider = adapter({}, { signatureValid: true });
  const event = await provider.verifyWebhook(
    '{"id":"evt_1"}',
    new Headers({ "stripe-signature": "t=1,v1=ok" }),
  );
  assert.ok(event);
  assert.equal(event.id, "evt_1");
  assert.equal(event.type, "charge.succeeded");
  // For Connect events the account is how a handler maps an event to a racer.
  assert.equal(event.accountId, "acct_connected_1");
});

// ---------------------------------------------------------------------------
// Capability honesty
// ---------------------------------------------------------------------------

test("declared capabilities match what the adapter actually does", async () => {
  const caps = adapter().capabilities;

  assert.equal(caps.connectionMethod, "oauth");
  assert.equal(caps.consentScreen, true);
  // The claim that matters most: Stripe Connect genuinely supports read-only,
  // which is why this flow can be offered alongside — but not as equivalent to —
  // a provider that cannot.
  assert.equal(caps.credentialScope, "read_only");
  assert.equal(caps.webhookRegistration, "platform");
  assert.equal(caps.serverSideDateFilter, true);

  // And it must be consistent with behaviour: an adapter claiming a consent
  // screen must actually redirect somewhere rather than asking for a key.
  const begun = await adapter().beginConnection({ racerId: "r1", state: "s" });
  assert.equal(begun.kind, "redirect");
});

test("revokeConnection deauthorizes the connected account with our client id", async () => {
  const recorded: Recorded = {};
  await adapter(recorded).revokeConnection(CONNECTION);
  assert.deepEqual(recorded.deauthorized, {
    client_id: CLIENT_ID,
    stripe_user_id: "acct_connected_1",
  });
});
