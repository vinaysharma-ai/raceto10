import type {
  ExternalCustomer,
  ProviderConnection,
  ProviderPayment,
  VerificationProvider,
} from "./types.ts";

/**
 * The adapter contract suite — SYSTEM-ARCHITECTURE.md §7.
 *
 * Every provider adapter must pass this. It is what makes "the race engine is
 * provider-agnostic" a checkable claim rather than an aspiration, and it is why
 * adding a third provider should require no changes under `engine/`.
 *
 * Deliberately a pure function returning results rather than registering tests
 * itself, for one reason: so this suite can be run against a deliberately broken
 * adapter and *observed to fail*. A contract test that has never been seen to
 * fail is indistinguishable from one that asserts nothing.
 *
 * ## What it can and cannot check
 *
 * It checks shape, and it checks that an adapter's declared capabilities are
 * internally consistent — a capability descriptor that lies is worse than no
 * descriptor, because the UI and the reconciliation job trust it.
 *
 * It cannot check that the capabilities are *accurate* about the outside world.
 * That a provider really has no read-only scope is a fact about that provider's
 * API, verified once by reading their documentation, not something a test can
 * discover. Those facts live in SYSTEM-ARCHITECTURE.md §14.
 */

export type ContractCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type AdapterFixtures = {
  /** A connection the adapter considers valid. */
  connection: ProviderConnection;

  /**
   * Produces a correctly signed webhook for `body`. Return `null` if this
   * provider cannot receive webhooks at all — the suite then skips the positive
   * case but still requires a clean rejection of unsigned input.
   */
  signWebhook: ((body: string) => { rawBody: string; headers: Headers }) | null;

  /** Guards against an adapter that pages forever. */
  maxItems?: number;
};

const DEFAULT_MAX_ITEMS = 500;

async function take<T>(source: AsyncIterable<T>, limit: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Runs every check against one adapter and returns the results. Never throws:
 * an adapter that throws is recorded as a failed check, so one broken method
 * does not hide the state of the others.
 */
export async function runAdapterContract(
  provider: VerificationProvider,
  fixtures: AdapterFixtures,
): Promise<ContractCheck[]> {
  const results: ContractCheck[] = [];
  const cap = provider.capabilities;
  const maxItems = fixtures.maxItems ?? DEFAULT_MAX_ITEMS;

  const check = async (name: string, run: () => Promise<string | null>) => {
    try {
      const problem = await run();
      results.push({ name, ok: problem === null, detail: problem ?? undefined });
    } catch (error) {
      results.push({ name, ok: false, detail: (error as Error).message });
    }
  };

  // -------------------------------------------------------------------------
  // Capability declarations must not contradict each other.
  //
  // These are the invariants that make the descriptor trustworthy. The most
  // important one: a pasted credential cannot be scoped down, so a provider
  // claiming `read_only` access without a consent flow is claiming something
  // that does not exist — and would mislead the disclosure shown to racers.
  // -------------------------------------------------------------------------

  await check("capabilities: id and display name are set", async () =>
    provider.id && provider.displayName ? null : "id or displayName is empty",
  );

  await check(
    "capabilities: read_only implies a consent flow",
    async () =>
      cap.credentialScope === "read_only" && cap.connectionMethod !== "oauth"
        ? "claims read_only without an OAuth consent flow, which cannot be granted"
        : null,
  );

  await check(
    "capabilities: credential paste cannot be scoped to read_only",
    async () =>
      cap.connectionMethod === "credential_paste" && cap.credentialScope !== "full_access"
        ? "a pasted credential cannot be scoped; it must declare full_access"
        : null,
  );

  await check("capabilities: oauth implies a consent screen", async () =>
    cap.connectionMethod === "oauth" && !cap.consentScreen
      ? "oauth without a consent screen is not a consent flow"
      : null,
  );

  await check("capabilities: credential paste implies no consent screen", async () =>
    cap.connectionMethod === "credential_paste" && cap.consentScreen
      ? "a pasted credential has no consent screen to show"
      : null,
  );

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  let begun: Awaited<ReturnType<VerificationProvider["beginConnection"]>> | null = null;

  // Alphanumeric so URL encoding is a no-op and a substring search is fair.
  const STATE = "contractTestState0";

  await check("beginConnection returns a well-formed result", async () => {
    begun = await provider.beginConnection({
      racerId: "00000000-0000-0000-0000-000000000000",
      state: STATE,
    });
    if (!begun) return "returned nothing";
    if (begun.kind === "redirect") {
      if (!begun.url) return "redirect result has no url";
      try {
        new URL(begun.url);
      } catch {
        return `redirect url is not absolute: ${begun.url}`;
      }
      return null;
    }
    if (begun.kind === "credential") {
      return begun.instructions?.trim() ? null : "credential result has no instructions";
    }
    return `unknown kind: ${(begun as { kind: string }).kind}`;
  });

  await check(
    "connection method matches the capabilities it declares",
    async () => {
      if (!begun) return "beginConnection produced nothing to compare";
      const expected = cap.connectionMethod === "oauth" ? "redirect" : "credential";
      return begun.kind === expected
        ? null
        : `declares ${cap.connectionMethod} but returned kind "${begun.kind}"`;
    },
  );

  await check(
    "a redirect carries the state token through",
    async () => {
      // An adapter that forgets to forward `state` breaks the CSRF guard on the
      // callback silently — the redirect still works, and the hole only shows up
      // when someone exploits it. The parameter name is the provider's business;
      // the value must survive the round trip.
      if (!begun || begun.kind !== "redirect") return null;
      return begun.url.includes(STATE)
        ? null
        : "the redirect URL does not carry the state token";
    },
  );

  await check("validateConnection returns an ok flag", async () => {
    const result = await provider.validateConnection(fixtures.connection);
    return typeof result?.ok === "boolean" ? null : "no boolean ok field";
  });

  await check("revokeConnection resolves without throwing", async () => {
    await provider.revokeConnection(fixtures.connection);
    return null;
  });

  // -------------------------------------------------------------------------
  // listCustomers — the baseline snapshot
  // -------------------------------------------------------------------------

  let customers: ExternalCustomer[] = [];

  await check("listCustomers yields well-formed customers", async () => {
    customers = await take(
      provider.listCustomers(fixtures.connection, new Date()),
      maxItems,
    );
    for (const c of customers) {
      if (!c.externalId?.trim()) return "a customer has an empty externalId";
      if (!isDate(c.createdAt)) return `customer ${c.externalId} has a non-Date createdAt`;
    }
    return null;
  });

  await check(
    "listCustomers yields no duplicate ids",
    async () => {
      // Duplicates would silently corrupt a baseline: the same customer counted
      // twice in the set, and the set's size is a number we publish.
      const seen = new Set<string>();
      for (const c of customers) {
        if (seen.has(c.externalId)) return `duplicate customer id: ${c.externalId}`;
        seen.add(c.externalId);
      }
      return null;
    },
  );

  await check(
    "listCustomers respects the `until` bound when the provider can filter",
    async () => {
      if (!cap.serverSideDateFilter) return null; // paging is bounded, not exact
      const until = new Date("2020-01-01T00:00:00Z");
      const rows = await take(provider.listCustomers(fixtures.connection, until), maxItems);
      // Exclusive: a customer created AT the boundary is new, not baseline.
      const late = rows.find((c) => c.createdAt >= until);
      return late
        ? `returned ${late.externalId} created ${late.createdAt.toISOString()}, at or after the bound`
        : null;
    },
  );

  // -------------------------------------------------------------------------
  // listPayments — the counted set
  // -------------------------------------------------------------------------

  const window = {
    since: new Date("2024-01-01T00:00:00Z"),
    until: new Date("2024-02-01T00:00:00Z"),
  };

  await check("listPayments yields well-formed payments", async () => {
    const payments: ProviderPayment[] = await take(
      provider.listPayments(fixtures.connection, window),
      maxItems,
    );
    for (const p of payments) {
      if (!p.externalCustomerId?.trim()) return "a payment has no customer id";
      if (!isDate(p.paidAt)) return `payment ${p.externalPaymentId} has a non-Date paidAt`;
      if (!Number.isInteger(p.amountMinor))
        return `payment ${p.externalPaymentId} amountMinor is not an integer`;
      if (p.kind !== "one_time" && p.kind !== "subscription")
        return `payment ${p.externalPaymentId} has unknown kind "${p.kind}"`;
    }
    return null;
  });

  await check(
    "listPayments stays inside the requested window",
    async () => {
      // The count is a comparison against race_start_at and race_end_at. A
      // provider that leaks a payment across the window boundary moves a
      // racer's number, so this is a correctness check, not tidiness.
      const payments = await take(
        provider.listPayments(fixtures.connection, window),
        maxItems,
      );
      const escaped = payments.find((p) => p.paidAt < window.since || p.paidAt >= window.until);
      return escaped
        ? `returned ${escaped.externalPaymentId} at ${escaped.paidAt.toISOString()}, outside the window`
        : null;
    },
  );

  // -------------------------------------------------------------------------
  // verifyWebhook
  // -------------------------------------------------------------------------

  await check("verifyWebhook rejects an empty body rather than throwing", async () => {
    const result = await provider.verifyWebhook("", new Headers());
    return result === null ? null : "returned an event for an empty body";
  });

  await check("verifyWebhook rejects an unsigned body", async () => {
    const result = await provider.verifyWebhook(
      JSON.stringify({ id: "evt_forged", type: "order_created" }),
      new Headers(),
    );
    return result === null ? null : "accepted a body with no signature";
  });

  if (fixtures.signWebhook) {
    const sign = fixtures.signWebhook;

    await check("verifyWebhook accepts a correctly signed body", async () => {
      const { rawBody, headers } = sign(JSON.stringify({ id: "evt_ok", type: "order_created" }));
      const event = await provider.verifyWebhook(rawBody, headers);
      if (!event) return "rejected a validly signed body";
      if (!event.id) return "verified event has no id";
      return null;
    });

    await check("verifyWebhook rejects a tampered body", async () => {
      // Same signature, different bytes. This is the attack the signature exists
      // to stop, and a provider that re-serialises before verifying will pass
      // this check while failing in production.
      const { headers } = sign(JSON.stringify({ id: "evt_ok", type: "order_created" }));
      const tampered = JSON.stringify({ id: "evt_ok", type: "order_created", amount: 999999 });
      const result = await provider.verifyWebhook(tampered, headers);
      return result === null ? null : "accepted a body whose signature did not match";
    });
  } else {
    results.push({
      name: "verifyWebhook positive case",
      ok: true,
      detail: "skipped: this provider cannot receive webhooks",
    });
  }

  return results;
}

export function summarise(results: ContractCheck[]) {
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, failed: failed.length, failedNames: failed.map((f) => f.name) };
}
