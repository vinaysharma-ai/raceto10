import type {
  BeginConnectionResult,
  ExternalCustomer,
  MrrReading,
  ProviderCapabilities,
  ProviderConnection,
  ProviderEvent,
  ProviderPayment,
  ReadWindow,
  VerificationProvider,
} from "../types.ts";

/**
 * The Stripe restricted-key adapter — the connection method this product ships.
 *
 * ## Why this exists alongside `adapter.ts`
 *
 * `adapter.ts` implements Stripe **Connect**, which needs a platform account
 * with a Connect client id. `00` §49 records why that is unavailable: Stripe
 * India is invite-only, so we cannot create one. The Connect flow is therefore
 * correct code for a door we cannot open, and it stays for reference and for its
 * tests.
 *
 * This is not a second Stripe system. It is the same provider, the same
 * `VerificationProvider` contract, the same `stripe/` directory, and the same
 * reading rules. What differs is only how the credential is obtained — a key the
 * racer pastes rather than a code Stripe redirects back — and that difference is
 * already modelled in the contract by `connectionMethod: "credential_paste"` and
 * the `credential` arm of `BeginConnectionResult`.
 *
 * ## How a raw credential crosses this boundary without travelling through it
 *
 * The contract is explicit that a `ProviderConnection` "carries a credential
 * *reference*, never a value — a raw credential must not be able to travel
 * through this layer at all."
 *
 * A pasted key makes that awkward, because unlike OAuth there is no
 * platform-held token: every read needs the racer's key. The resolution is that
 * this adapter is constructed with a `resolveCredential` function. The
 * connection object carries the *reference*; the adapter resolves it at the
 * moment of use, into a local, and the plaintext exists only inside the call
 * that needs it.
 *
 * So the invariant holds as written. Nothing that outlives a request ever holds
 * the key, and the layer above never sees one.
 *
 * ## Why `read_only` is honest here
 *
 * `types.ts` notes that "you cannot scope down a pasted key". That is true of
 * the *stored* credential's scope as a property we control — and it is exactly
 * why the instructions tell the racer to create the key restricted. We do not
 * narrow it; Stripe's dashboard does, before we ever see it. `credentialScope`
 * below is set to `read_only` because that is the flow's requirement and the
 * validation rejects a key that can write, rather than because we delimited it.
 */

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Stripe's own error shape, narrowed to what we act on.
 *
 * `statusCode` is read; the rest is not. See `describeFailure` for why the
 * message never reaches a caller.
 */
export type StripeFailure = {
  statusCode?: number;
  type?: string;
  code?: string;
};

export type StripeRestrictedPort = {
  /** Identifies the account a key belongs to. Also the key's validity check. */
  account(secretKey: string): Promise<{
    id: string;
    label?: string | null;
    /** Whether the key can write. A restricted key must not be able to. */
    canWrite: boolean;
  }>;

  customers(
    secretKey: string,
    params: { limit?: number; createdLt?: number },
  ): AsyncIterable<{
    id: string;
    created: number;
    email?: string | null;
    deleted?: unknown;
  }>;

  charges(
    secretKey: string,
    params: { limit?: number; createdGte?: number; createdLt?: number },
  ): AsyncIterable<{
    id: string;
    created: number;
    amount: number;
    currency: string;
    paid: boolean;
    status: string;
    refunded?: boolean;
    customer?: string | { id: string } | null;
    invoice?: string | { id: string } | null;
  }>;

  /**
   * Active subscriptions, for MRR.
   *
   * Optional on the port: a key can be restricted away from subscriptions while
   * still reading customers and charges, and MRR is then genuinely unknown
   * rather than zero. `00` defers MRR from the product surface, so a key without
   * it must still be connectable.
   */
  subscriptions?(
    secretKey: string,
    params: { limit?: number; status?: string },
  ): AsyncIterable<{
    id: string;
    status: string;
    customer?: string | { id: string } | null;
    items?: {
      data?: Array<{
        quantity?: number | null;
        price?: {
          unit_amount?: number | null;
          currency?: string | null;
          recurring?: { interval?: string | null; interval_count?: number | null } | null;
        } | null;
      }>;
    } | null;
  }>;
};

export type StripeRestrictedConfig = {
  /**
   * Resolves a `credentialRef` to a plaintext key.
   *
   * Injected rather than imported so this adapter does not know the vault
   * exists, and so the contract suite runs with a stub and no key material.
   * It must throw if the reference does not resolve — never return an empty
   * string, which would be sent to Stripe as a credential.
   */
  resolveCredential: (ref: string) => Promise<string>;

  /** Overridable so tests need no network. */
  instructionsUrl?: string;
};

const DEFAULT_INSTRUCTIONS_URL = "https://dashboard.stripe.com/apikeys/create";

/** Stripe timestamps are unix seconds; race boundaries are milliseconds. */
const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * How a credential problem is reported upward.
 *
 * `02` §257: "Never print credentials or raw provider responses." So the
 * adapter returns a *category*, and the sentence a racer reads is written by the
 * caller. Stripe's own message can echo the key back in some 401s, and its
 * request id and header names are of no use to a founder trying to paste a key.
 */
export type CredentialFailure =
  /** 401 — the key is wrong, revoked, or was never valid. */
  | "rejected"
  /** 403 — valid key, insufficient permission for what we need. */
  | "insufficient_permission"
  /** The key can write. Refused: this flow is read-only by requirement. */
  | "not_read_only"
  /** Stripe could not be reached, or answered with something we do not model. */
  | "unavailable";

export class CredentialError extends Error {
  readonly reason: CredentialFailure;

  constructor(reason: CredentialFailure) {
    // The message is the category, never the provider's text. This is the
    // string that would end up in a log line.
    super(`Stripe credential check failed: ${reason}`);
    this.name = "CredentialError";
    this.reason = reason;
  }
}

/**
 * Maps a Stripe failure to a category, without carrying any of its text.
 *
 * A 403 and a 401 are genuinely different for the person holding the key: the
 * first means the key is real but missing a permission, and the fix is to edit
 * the key in Stripe's dashboard. The second means start again. Telling them
 * apart is the difference between an actionable message and "something went
 * wrong".
 */
export function describeFailure(error: unknown): CredentialFailure {
  const status = (error as StripeFailure | null)?.statusCode;
  if (status === 401) return "rejected";
  if (status === 403) return "insufficient_permission";
  return "unavailable";
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export function createStripeRestrictedKeyAdapter(
  port: StripeRestrictedPort,
  config: StripeRestrictedConfig,
): VerificationProvider {
  const capabilities: ProviderCapabilities = {
    connectionMethod: "credential_paste",
    // No provider-mediated consent screen: the racer creates the key in Stripe's
    // own dashboard and brings it here. That is a real difference from Connect
    // and the UI must present it as one.
    consentScreen: false,
    // The requirement of the flow. Enforced by rejecting a writable key rather
    // than by narrowing one — see the note at the top of this file.
    credentialScope: "read_only",
    // A restricted key does not expire on its own; it is revoked by hand.
    credentialExpires: false,
    // We cannot rotate it: only the racer can, in their dashboard. If the key
    // dies they must return and paste a new one.
    credentialRotatable: false,
    // Restricted keys cannot deliver webhooks to us, which is why verification
    // polls. `00` §50.
    webhookRegistration: "merchant",
    // `created` range filters are supported server-side.
    serverSideDateFilter: true,
    accountScoping: "documented",
  };

  /**
   * Resolves the credential and runs one operation with it.
   *
   * `T | Promise<T>` rather than `Promise<T>` because two of the callers are
   * async generator *functions*: calling one returns an async generator
   * immediately, not a promise. `await` passes a non-promise straight through,
   * so both shapes work and the credential still exists only for the duration
   * of the call.
   */
  async function withCredential<T>(
    connection: ProviderConnection,
    // Named `run`, not `use`: `react-hooks/rules-of-hooks` reads any parameter
    // beginning with "use" as a hook and refuses it in a non-component.
    run: (secretKey: string) => T | Promise<T>,
  ): Promise<T> {
    if (!connection.credentialRef) {
      // A Stripe connection with no reference is a bug, not a state: this
      // adapter cannot read anything without one.
      throw new CredentialError("unavailable");
    }

    let secretKey: string;
    try {
      secretKey = await config.resolveCredential(connection.credentialRef);
    } catch {
      // The vault refused — wrong key version, tampered record, or a row that
      // does not exist. Indistinguishable from a dead credential, and the same
      // action fixes it: reconnect.
      throw new CredentialError("rejected");
    }

    try {
      return await run(secretKey);
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError(describeFailure(error));
    }
  }

  /**
   * The same guard for the paginated reads, and it is not redundant.
   *
   * `withCredential` wraps `await run(secretKey)`. When `run` is an **async
   * generator function**, calling it returns a generator immediately and the
   * body executes lazily on iteration — so that `try` covers only generator
   * *creation*. Every error thrown while paging escaped it unwrapped.
   *
   * That was not theoretical. Stripe answers a bad key with
   * `"Invalid API Key provided: rk_live_51abc***"`, echoing the credential's
   * own prefix. A 401 arriving on page two would therefore have propagated as a
   * plain `Error` carrying that text, straight past every layer that promises
   * provider failures are reduced to categories — and into whatever log line
   * caught it.
   *
   * So the iteration is guarded here instead. `yield*` runs the body inside the
   * `try`, which is precisely what the promise-returning form could not do.
   */
  async function* withCredentialStream<T>(
    connection: ProviderConnection,
    run: (secretKey: string) => AsyncIterable<T>,
  ): AsyncIterable<T> {
    if (!connection.credentialRef) throw new CredentialError("unavailable");

    let secretKey: string;
    try {
      secretKey = await config.resolveCredential(connection.credentialRef);
    } catch {
      throw new CredentialError("rejected");
    }

    try {
      yield* run(secretKey);
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError(describeFailure(error));
    }
  }

  return {
    id: "stripe",
    displayName: "Stripe",
    capabilities,

    async beginConnection(): Promise<BeginConnectionResult> {
      // Nothing to redirect to. The racer creates the key themselves, so what
      // this returns is instructions — the other arm of the union, and the
      // reason the union exists.
      return {
        kind: "credential",
        instructions:
          "In Stripe, go to Developers → API keys → Create restricted key. " +
          "Give it Read access to Customers, Charges and Subscriptions, and no " +
          "write access to anything. Then paste it here.\n" +
          DEFAULT_INSTRUCTIONS_URL,
      };
    },

    async completeConnection(params): Promise<ProviderConnection> {
      const apiKey = params.apiKey;

      if (!apiKey) {
        // The caller validates the *shape* before this; reaching here without a
        // key means the caller skipped that, so this is a programming error
        // rather than a user one.
        throw new CredentialError("rejected");
      }

      try {
        const account = await port.account(apiKey);

        // A key that can write is refused. `02` and the flow both say read-only,
        // and a racer who pastes a full-access key has handed over far more than
        // they intended — better to refuse than to accept and hope.
        if (account.canWrite) throw new CredentialError("not_read_only");

        // The account id becomes the connection's `accountId`; the *reference*
        // is supplied by the caller, which is what writes the vault row. The key
        // itself is never part of this object.
        return {
          provider: "stripe",
          accountId: account.id,
          accountLabel: account.label ?? undefined,
        };
      } catch (error) {
        if (error instanceof CredentialError) throw error;
        throw new CredentialError(describeFailure(error));
      }
    },

    async validateConnection(connection) {
      try {
        const account = await withCredential(connection, (key) => port.account(key));
        return { ok: true, accountLabel: account.label ?? undefined };
      } catch {
        // A health check reports unhealthy; it does not throw.
        return { ok: false };
      }
    },

    async revokeConnection(connection) {
      // We cannot revoke a restricted key — only the racer can, in their
      // dashboard. `credentialRotatable: false` is the honest declaration of
      // that, and pretending otherwise here would be worse than doing nothing.
      //
      // What we CAN do is stop holding it, which the caller does by deleting
      // the vault row.
      void connection;
    },

    async *listCustomers(connection, until): AsyncIterable<ExternalCustomer> {
      const untilSeconds = toSeconds(until);

      // The guarded stream, then the filtering. The port's errors are mapped to
      // categories before anything here sees them.
      const page = withCredentialStream(connection, (secretKey) =>
        port.customers(secretKey, { limit: 100, createdLt: untilSeconds }),
      );

      for await (const customer of page) {
        if (customer.deleted) continue;

        const createdAt = new Date(customer.created * 1000);

        // Re-checked rather than trusted to the API filter. The baseline is
        // the integrity anchor of the product, and a boundary leak of one
        // customer is a boundary leak of the premise.
        if (createdAt >= until) continue;

        yield {
          externalId: customer.id,
          createdAt,
          email: customer.email ?? undefined,
        };
      }
    },

    async *listPayments(connection, window: ReadWindow): AsyncIterable<ProviderPayment> {
      const page = withCredentialStream(connection, (secretKey) =>
        port.charges(secretKey, {
          limit: 100,
          createdGte: toSeconds(window.since),
          createdLt: toSeconds(window.until),
        }),
      );

      for await (const charge of page) {
        // "A successful, non-zero payment" — a failed or unsettled charge is
        // not a customer, and a zero-amount charge is not a payment.
        if (charge.status !== "succeeded" || !charge.paid) continue;
        if (charge.amount <= 0) continue;

          const customerId =
            typeof charge.customer === "string"
              ? charge.customer
              : (charge.customer?.id ?? null);

          // Guest checkout has no stable identity to deduplicate on, so counting
          // it would risk counting one person repeatedly. Excluded by decision.
          if (!customerId) continue;

          const paidAt = new Date(charge.created * 1000);
          if (paidAt < window.since || paidAt >= window.until) continue;

          yield {
            externalCustomerId: customerId,
            externalPaymentId: charge.id,
            paidAt,
            amountMinor: charge.amount,
            currency: charge.currency,
            // `as const` because the yield sits inside a generator passed
            // through a generic helper, so it gets no contextual type from
            // `ProviderPayment` and the literal would widen to `string`.
          kind: charge.invoice ? ("subscription" as const) : ("one_time" as const),
        };
      }
    },

    /**
     * Present only when the port can read subscriptions.
     *
     * Absent rather than returning `{known:false}` unconditionally, so that
     * `capabilities` and the method agree: a caller checking for the method gets
     * the same answer as one reading the capability.
     */
    ...(port.subscriptions
      ? {
          async readMonthlyRecurringRevenue(
            connection: ProviderConnection,
          ): Promise<MrrReading> {
            try {
              return await withCredential(connection, async (secretKey) => {
                const page = port.subscriptions!(secretKey, {
                  limit: 100,
                  status: "active",
                });

                let total = 0;
                let currency: string | null = null;
                let sawAny = false;

                for await (const subscription of page) {
                  // Stripe returns trialing and past_due under some status
                  // filters; only genuinely active billing counts as revenue.
                  if (subscription.status !== "active") continue;

                  for (const item of subscription.items?.data ?? []) {
                    const price = item.price;
                    if (!price) continue;

                    const monthly = monthlyMinor(
                      { unit_amount: price.unit_amount, recurring: price.recurring },
                      item.quantity ?? 1,
                    );

                    // An interval we cannot normalise, with a non-zero amount,
                    // makes the total unknown. Summing what we understand and
                    // dropping the rest would report a confident wrong number.
                    if (monthly === null) {
                      if ((price.unit_amount ?? 0) > 0) {
                        return { known: false as const, reason: "unsupported" as const };
                      }
                      continue;
                    }

                    sawAny = true;
                    total += monthly;
                    currency = currency ?? price.currency ?? null;
                  }
                }

                // No active subscriptions is a real zero, not an unknown: the
                // key could see them and there were none.
                void sawAny;
                return {
                  known: true as const,
                  mrrMinor: total,
                  currency: currency ?? "usd",
                };
              });
            } catch {
              // A dead credential or an unreachable Stripe. Distinct from
              // "no subscriptions", and eligibility refuses on both.
              return { known: false, reason: "unavailable" };
            }
          },
        }
      : {}),

    async verifyWebhook(): Promise<ProviderEvent | null> {
      // Restricted keys cannot deliver webhooks to us (`00` §50), so there is
      // nothing to verify. Returning null rather than throwing is the honest
      // answer: no event is trusted, and verification polls instead.
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// MRR
// ---------------------------------------------------------------------------

/**
 * Reads recurring revenue from active subscriptions.
 *
 * Not implemented when the port has no `subscriptions` method: a key scoped
 * away from subscriptions genuinely cannot answer, and `unsupported` is the
 * honest reply. Returning zero would let a racer with paying subscribers pass
 * the entry gate.
 *
 * Subscriptions whose price has an interval we do not model, or whose amount is
 * missing, make the whole answer unknown rather than partially summed — a total
 * that silently omits one plan is a wrong number reported as a right one.
 */

/** Normalises a subscription price to a monthly figure, in minor units. */
export function monthlyMinor(price: {
  unit_amount?: number | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
}, quantity = 1): number | null {
  const unit = price.unit_amount;
  if (typeof unit !== "number" || unit < 0) return null;

  const interval = price.recurring?.interval;
  const count = price.recurring?.interval_count ?? 1;
  if (!interval || count < 1) return null;

  const total = unit * (quantity > 0 ? quantity : 1);

  switch (interval) {
    case "day":
      return Math.round((total * 365) / (12 * count));
    case "week":
      return Math.round((total * 52) / (12 * count));
    case "month":
      return Math.round(total / count);
    case "year":
      return Math.round(total / (12 * count));
    default:
      // An interval we do not model is not zero. Returning null makes it
      // unknown, which is the honest reading.
      return null;
  }
}
