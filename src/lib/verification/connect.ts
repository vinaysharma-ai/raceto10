import type { ProviderConnection, VerificationProvider } from "./types.ts";
import { checkEligibility, describeIneligibility, type IneligibleReason } from "./eligibility.ts";
import { readEligibilityFacts } from "./probe.ts";
import { CredentialError, type CredentialFailure } from "./stripe/restricted.ts";

/**
 * Connecting a racer's provider account.
 *
 * ## Shape
 *
 * The ordering lives here; the database lives behind `ConnectionStore`. That is
 * the same split the rest of this codebase uses — `readRaceBoard` takes a
 * `RaceBoardReader`, `placeHold` takes a `HoldStore` — and it exists so the
 * rules that matter (ownership, replacement, the credential never touching a
 * non-secret row) are testable against a fake with no database and no Stripe.
 *
 * ## Ownership
 *
 * The racer is resolved from the **session**, inside the store, by
 * `currentRacerId()`. No function here accepts a racer id from a caller, so
 * there is no parameter a request body could supply. That is deliberate: the
 * check cannot be forgotten at a call site because there is no call site that
 * could pass one.
 *
 * ## The two tables, and what must never cross between them
 *
 *   * `provider_connections` — non-secret metadata. Rendered, listed, safe.
 *   * `provider_credentials` — the sealed key alone.
 *
 * The plaintext key is a parameter to exactly one function and is passed
 * straight into the seal. It is never put on an outcome object, never included
 * in an error, and never logged — including on the failure paths, where "the
 * key we tried" is the tempting thing to record.
 */

export type ConnectFailure = CredentialFailure | "account_in_use" | "no_racer" | "storage_error";

/**
 * The entry-gate verdict, as of this check.
 *
 * `unknown` is a distinct outcome rather than a refusal: the connection is real
 * and the key works, we simply could not read enough to decide. Collapsing it
 * into `ineligible` would tell a racer they have customers when the truth is
 * that a network call failed.
 */
export type ConnectEligibility =
  | { status: "eligible" }
  | { status: "ineligible"; reason: IneligibleReason }
  | { status: "unknown"; reason: string };

export type ConnectOutcome =
  | {
      ok: true;
      connectionId: string;
      accountId: string;
      accountLabel: string | null;
      /** True when an existing connection for this racer was replaced. */
      replaced: boolean;
      /** True when the credential was re-sealed and rewritten. */
      rotated: boolean;
      /** The entry gate, evaluated against the account as it stands now. */
      eligibility: ConnectEligibility;
    }
  | { ok: false; reason: ConnectFailure; message: string };

/** An existing connection row, as much of it as this flow reasons about. */
export type ExistingConnection = {
  id: string;
  accountId: string | null;
  status: string;
};

export type StoredCredential = {
  ciphertext: string;
  keyVersion: number;
};

export type ConnectionStore = {
  /** The racer id for the authenticated session, or null. Never a parameter. */
  currentRacerId(): Promise<string | null>;

  /** This racer's existing connection with a provider, if any. */
  findOwnConnection(racerId: string, provider: string): Promise<ExistingConnection | null>;

  /**
   * Any connection already holding this provider account, whoever owns it.
   *
   * Backs the one-account-one-race rule. The database also enforces it with
   * `unique (provider, external_account_ref)`; this exists so the racer gets a
   * sentence rather than a constraint violation.
   */
  findConnectionByAccount(
    provider: string,
    accountId: string,
  ): Promise<{ id: string; racerId: string } | null>;

  insertConnection(row: {
    racerId: string;
    provider: string;
    accountId: string;
    accountLabel: string | null;
    status: string;
  }): Promise<{ id: string }>;

  updateConnection(
    id: string,
    patch: { accountId?: string; accountLabel?: string | null; status?: string; errorCode?: string | null },
  ): Promise<void>;

  putCredential(connectionId: string, sealed: StoredCredential): Promise<void>;

  /** Removes the stored credential. Used when a connection is replaced. */
  clearCredential(connectionId: string): Promise<void>;

  /** Seals a plaintext key against a connection. Injected so tests need no key. */
  seal(plaintext: string, connectionId: string): StoredCredential;

  /**
   * Records the entry-gate result.
   *
   * `verification_snapshots` already has the columns and the constraints for
   * this — `verification_status ∈ (eligible, ineligible, failed)` and
   * `source = 'registration'` — so the check leaves an audit trail from the
   * first day rather than being recomputed with no record of what was decided.
   */
  insertSnapshot(row: {
    racerId: string;
    connectionId: string;
    customerCount: number;
    mrrMinor: number | null;
    currency: string | null;
    status: "eligible" | "ineligible" | "failed";
    source: "registration";
    errorCode: string | null;
  }): Promise<void>;
};

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/**
 * The sentence a racer reads, keyed on the category.
 *
 * `02` §257 forbids surfacing raw provider text. Stripe's own 401 message can
 * quote the submitted key back, and its request id helps nobody pasting a key.
 */
export function describeConnectFailure(reason: ConnectFailure): string {
  switch (reason) {
    case "rejected":
      return "Stripe didn't accept that key. Check you copied the whole key, and that it hasn't been revoked.";
    case "insufficient_permission":
      return "That key is valid but can't read what we need. Give it Read access to Customers, Charges and Subscriptions, then paste it again.";
    case "not_read_only":
      return "That key can write to your Stripe account. RaceTo10 only ever needs read access — create a restricted key with read permissions and no write access.";
    case "account_in_use":
      return "That Stripe account is already connected to another race. One account can only back one entry.";
    case "unavailable":
      return "We couldn't reach Stripe just now. Nothing was saved — try again in a moment.";
    case "no_racer":
      return "Finish setting up your profile before connecting a payment provider.";
    case "storage_error":
      return "We couldn't save that just now. Try again in a moment.";
  }
}

function refusal(reason: ConnectFailure): ConnectOutcome {
  return { ok: false, reason, message: describeConnectFailure(reason) };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Runs the entry gate and records the result.
 *
 * ## Why a failure here does not fail the connection
 *
 * The key is valid and stored by this point. A network failure while counting
 * customers says nothing about the credential, so reporting `storage_error`
 * would send the racer to re-paste a key that works. The verdict is `unknown`
 * and the snapshot records `failed` — the connection stands, and activation is
 * what refuses to proceed on an undecided gate.
 *
 * ## What gets written
 *
 * A `verification_snapshots` row with `source: 'registration'`. The count is a
 * **floor, not a total**, whenever the probe short-circuited — see
 * `src/lib/verification/probe.ts`. It is stored anyway because the verdict is
 * what matters here and the accurate baseline is captured at activation, but
 * the number must not later be read as a metric. `truncated` is folded into
 * `error_code` so that distinction survives in the row itself rather than
 * depending on someone reading this comment.
 */
async function evaluateEligibility(
  store: ConnectionStore,
  provider: VerificationProvider,
  connection: { id: string; accountId: string },
  racerId: string,
): Promise<ConnectEligibility> {
  const asProviderConnection: ProviderConnection = {
    provider: provider.id,
    accountId: connection.accountId,
    credentialRef: connection.id,
  };

  let facts;
  try {
    facts = await readEligibilityFacts(provider, asProviderConnection);
  } catch {
    // Category only — never the error's text. This path can see a provider
    // failure, and a provider's message can quote the credential back.
    console.error("[provider] eligibility probe failed", { code: "probe_failed" });

    await safeSnapshot(store, {
      racerId,
      connectionId: connection.id,
      customerCount: 0,
      mrrMinor: null,
      currency: null,
      status: "failed",
      source: "registration",
      errorCode: "probe_failed",
    });

    return { status: "unknown", reason: "We couldn't read your account just now." };
  }

  const verdict = checkEligibility({
    existingCustomers: facts.payingCustomers.count,
    mrrMinor: facts.mrrMinor,
  });

  await safeSnapshot(store, {
    racerId,
    connectionId: connection.id,
    customerCount: facts.payingCustomers.count,
    mrrMinor: facts.mrrMinor,
    currency: facts.currency,
    status: verdict.eligible ? "eligible" : "ineligible",
    source: "registration",
    errorCode: facts.payingCustomers.truncated
      ? "count_truncated"
      : (facts.mrrUnavailable ?? null),
  });

  if (verdict.eligible) return { status: "eligible" };

  // `mrr_unknown` is not a refusal about the racer's business — it is us being
  // unable to see. Reported as unknown so the copy can say what to fix on the
  // key rather than telling them they have customers they do not have.
  if (verdict.reason === "mrr_unknown") {
    return { status: "unknown", reason: describeIneligibility("mrr_unknown") };
  }

  return { status: "ineligible", reason: verdict.reason };
}

/** A snapshot write must never be the reason a successful connect is reported as failed. */
async function safeSnapshot(
  store: ConnectionStore,
  row: Parameters<ConnectionStore["insertSnapshot"]>[0],
): Promise<void> {
  try {
    await store.insertSnapshot(row);
  } catch (error) {
    console.error("[provider] could not record the eligibility snapshot", error);
  }
}

/**
 * Validates a submitted key and stores it against the signed-in racer.
 *
 * Order, and why each step is where it is:
 *
 *   1. **Resolve the racer from the session.** Before anything is written, and
 *      before the provider is called — an unauthenticated request should not be
 *      able to make us contact Stripe at all.
 *   2. **Validate the key with the provider.** The only step that touches the
 *      plaintext, and it happens before any row exists, so a bad key leaves no
 *      trace behind.
 *   3. **Refuse an account another racer already holds.** Checked here for the
 *      message; enforced by a unique constraint for the truth.
 *   4. **Write the metadata row**, then **seal and write the credential**
 *      against that row's id — the id is the vault's associated data, so it has
 *      to exist first.
 *
 * A failure at step 4 leaves the connection row present without a credential.
 * That is recoverable and honest: `connection_status` is not `connected`, so
 * nothing reads it, and reconnecting repairs it in place.
 */
export async function connectProviderAccount(
  store: ConnectionStore,
  provider: VerificationProvider,
  apiKey: string,
): Promise<ConnectOutcome> {
  const racerId = await store.currentRacerId();
  if (!racerId) return refusal("no_racer");

  // --- 1. Validate, before anything is written -----------------------------
  let resolved: ProviderConnection;
  try {
    resolved = await provider.completeConnection({ apiKey });
  } catch (error) {
    if (error instanceof CredentialError) return refusal(error.reason);
    // An unrecognised throw is not a credential verdict. Reported as a storage
    // problem so the racer retries rather than editing a key that may be fine.
    return refusal("storage_error");
  }

  const accountId = resolved.accountId;

  try {
    // --- 2. One account, one race ------------------------------------------
    const holder = await store.findConnectionByAccount(provider.id, accountId);
    if (holder && holder.racerId !== racerId) {
      return refusal("account_in_use");
    }

    // --- 3. This racer's existing connection, if any -----------------------
    const existing = await store.findOwnConnection(racerId, provider.id);

    if (existing) {
      // Reconnecting is an update, not a second row. The unique constraint on
      // `(provider, external_account_ref)` would refuse a second one anyway, and
      // two rows for one racer would make "which account am I racing with?"
      // unanswerable.
      const replacingAccount = existing.accountId !== accountId;

      if (replacingAccount) {
        // The old credential belongs to an account this racer no longer races
        // with. Leaving it would mean holding a live key for an account we have
        // no reason to read.
        await store.clearCredential(existing.id);
      }

      await store.updateConnection(existing.id, {
        accountId,
        accountLabel: resolved.accountLabel ?? null,
        status: "connected",
        errorCode: null,
      });

      // Re-sealed even when the account is unchanged: the racer pasted a key,
      // and the reasonable reading is that they want this key used. The vault's
      // AAD is the same connection id either way.
      await store.putCredential(existing.id, store.seal(apiKey, existing.id));

      const eligibility = await evaluateEligibility(
        store,
        provider,
        { id: existing.id, accountId },
        racerId,
      );

      return {
        ok: true,
        connectionId: existing.id,
        accountId,
        accountLabel: resolved.accountLabel ?? null,
        replaced: true,
        rotated: true,
        eligibility,
      };
    }

    // --- 4. A first connection ---------------------------------------------
    const created = await store.insertConnection({
      racerId,
      provider: provider.id,
      accountId,
      accountLabel: resolved.accountLabel ?? null,
      status: "connected",
    });

    await store.putCredential(created.id, store.seal(apiKey, created.id));

    const eligibility = await evaluateEligibility(
      store,
      provider,
      { id: created.id, accountId },
      racerId,
    );

    return {
      ok: true,
      connectionId: created.id,
      accountId,
      accountLabel: resolved.accountLabel ?? null,
      replaced: false,
      rotated: false,
      eligibility,
    };
  } catch {
    // Category only. See the note on the probe handler above.
    console.error("[provider] connect failed", { code: "storage_error" });
    return refusal("storage_error");
  }
}

/**
 * Marks a connection dead after a read fails.
 *
 * Kept separate from connecting because the two have different causes and
 * different fixes: this one is usually a key the racer revoked in Stripe, and
 * the racer has to return and paste a new one.
 */
export async function markConnectionInvalid(
  store: ConnectionStore,
  connectionId: string,
  reason: ConnectFailure,
): Promise<void> {
  try {
    await store.updateConnection(connectionId, {
      status: reason === "rejected" ? "revoked" : "invalid",
      errorCode: reason,
    });
  } catch (error) {
    // A failure to record a failure is not worth propagating: the read has
    // already been reported unhealthy, and the next reconcile will try again.
    console.error("[provider] could not mark connection invalid", error);
  }
}
