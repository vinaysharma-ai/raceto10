import { CredentialError } from "../verification/stripe/restricted.ts";
import type { ProviderConnection, ProviderPayment, VerificationProvider } from "../verification/types.ts";

/**
 * Reconciliation — turning a racing racer's payments into a live count.
 *
 * ## Polling, not webhooks
 *
 * `00` §50: a restricted Stripe key cannot deliver webhooks to us, so
 * verification polls. That is a product decision with a visible consequence —
 * a racer's count is up to ~30 minutes stale — and it is why `count_reconciled_at`
 * exists as a column rather than the count simply being trusted.
 *
 * ## Why this is idempotent by construction
 *
 * Three separate mechanisms, none of which depends on the others being correct:
 *
 *   1. `race_customer` has `unique (racer_id, external_customer_id)`. Replaying
 *      the same payment inserts nothing. The migration says so directly: this
 *      is "the constraint that makes replay harmless".
 *   2. The count is **recomputed** with `count(*)` over that table, never
 *      incremented. An increment would drift on replay; a recomputation cannot.
 *   3. `reached_ten_at` and the count advance are compare-and-set writes, so a
 *      concurrent second run loses rather than double-writing.
 *
 * So a run may be repeated, overlapped, or retried after a crash and the stored
 * state converges on the same answer. That property is what lets the poller
 * overlap its windows for safety without risking a double count.
 *
 * ## What this never accepts
 *
 * No count, customer, or timestamp from a caller. The only inputs are the store,
 * the provider and the clock. A client cannot influence a verified number
 * because there is no parameter for one to travel in.
 */

/** How far behind the last successful reconcile to re-read, for safety. */
export const OVERLAP_MS = 60 * 60 * 1000;

/** The finish line. */
export const TARGET_CUSTOMERS = 10;

export type ActiveRacer = {
  id: string;
  activatedAt: Date;
  /** When the window closes. The race cannot be counted past this instant. */
  endsAt: Date;
  currentCustomerCount: number;
  countReconciledAt: Date | null;
  reachedTenAt: Date | null;
};

export type ReconcileFailure =
  | "no_connection"
  | "connection_not_ready"
  | "provider_failed"
  /** The key was refused. Distinct from `provider_failed`, which is transient. */
  | "connection_lost"
  | "storage_error";

export type ReconcileOutcome =
  | {
      ok: true;
      racerId: string;
      /** The verified count after this run. */
      customerCount: number;
      /** True when this run moved the count. */
      advanced: boolean;
      /** True when this run was the one that reached ten. */
      finished: boolean;
      /** True when this run was the one that closed an unfinished race. */
      expired: boolean;
    }
  | { ok: false; racerId: string; reason: ReconcileFailure };

export type ReconcileStore = {
  /** Racers currently racing. Not yet finished, not withdrawn. */
  activeRacers(): Promise<ActiveRacer[]>;

  connectionFor(racerId: string): Promise<{ id: string; status: string; accountId: string } | null>;

  /** Opens a `reconciliation_runs` row so a failure leaves a trace. */
  beginRun(connectionId: string): Promise<string>;

  finishRun(
    runId: string,
    result: { status: "ok" | "failed"; customerCount: number | null; errorCode: string | null },
  ): Promise<void>;

  /**
   * Records payments, ignoring ones already stored.
   *
   * The database's unique constraint does the deduplication; this method's job
   * is to not care whether a row was new. It must never throw on a duplicate.
   */
  recordPayments(racerId: string, payments: ProviderPayment[]): Promise<void>;

  /** `count(*)` over `race_customer` — the authoritative number. */
  countCustomers(racerId: string): Promise<number>;

  /**
   * Advances the cached count, but only from the value we read.
   *
   * Compare-and-set, like activation. Two concurrent runs both read 3 and both
   * want to write 5; only one matches `.eq("current_customer_count", 3)`. The
   * loser's write is discarded, so a milestone event is emitted once rather
   * than twice.
   */
  advance(
    racerId: string,
    expectedCount: number,
    nextCount: number,
    reconciledAt: Date,
  ): Promise<boolean>;

  /** Compare-and-set on `reached_ten_at`, so exactly one run finishes the race. */
  markReachedTen(racerId: string, at: Date): Promise<boolean>;

  /**
   * The instant the nth customer first paid, or null if there are fewer than n.
   *
   * This is what makes `finished_at` true rather than convenient. The moment a
   * race was won is the moment the tenth customer's money arrived, not the
   * moment a poller happened to notice — and those can be half an hour apart,
   * which is exactly the kind of gap a board claiming to record real events
   * cannot afford to paper over.
   */
  nthCustomerPaidAt(racerId: string, n: number): Promise<Date | null>;

  /**
   * Compare-and-set on the status, so exactly one run expires a race.
   *
   * Same shape as `markReachedTen`, and for the same reason: several instances
   * can see the same elapsed window, and only one of them may write the
   * transition and announce it.
   */
  markExpired(racerId: string): Promise<boolean>;

  /**
   * Freezes the count and marks the connection broken.
   *
   * The count is not touched — it is frozen precisely by leaving it alone. What
   * changes is the connection, so nothing reads it again until a racer
   * reconnects, and the public surface can say why it stopped moving.
   *
   * Returns whether this call was the one that broke it. Compare-and-set on
   * `connection_status = 'connected'`, so two runs failing at the same instant
   * produce one state change and therefore one `connection_lost` event.
   */
  markConnectionBroken(connectionId: string, errorCode: string): Promise<boolean>;

  recordEvent(input: {
    racerId: string;
    type: "customer_milestone" | "finished" | "expired" | "connection_lost";
    customerCount: number;
    occurredAt: Date;
  }): Promise<void>;
};

// ---------------------------------------------------------------------------
// One racer
// ---------------------------------------------------------------------------

/**
 * Reconciles a single racer.
 *
 * Never throws. A failure is recorded on the `reconciliation_runs` row and
 * returned, because one dead credential must not stop the poller from
 * reconciling everybody else — the loop's job is to keep going and leave a
 * trail, not to abort on the first problem.
 */
export async function reconcileRacer(
  store: ReconcileStore,
  provider: VerificationProvider,
  racer: ActiveRacer,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  let runId: string | null = null;
  // Hoisted so the failure handler can mark the connection broken. The
  // connection is resolved first inside the try, and everything that can fail
  // happens after it, so by the time the catch runs this is set.
  let connectionId: string | null = null;

  try {
    const connection = await store.connectionFor(racer.id);
    connectionId = connection?.id ?? null;
    if (!connection) return { ok: false, racerId: racer.id, reason: "no_connection" };
    if (connection.status !== "connected") {
      return { ok: false, racerId: racer.id, reason: "connection_not_ready" };
    }

    runId = await store.beginRun(connection.id);

    const asProviderConnection: ProviderConnection = {
      provider: provider.id,
      accountId: connection.accountId,
      credentialRef: connection.id,
    };

    // --- The window ---------------------------------------------------------
    //
    // From the last successful reconcile, less an overlap, or from activation
    // if this is the first run. The overlap exists because a payment can be
    // recorded at Stripe slightly after the instant we last looked, and a
    // window that resumed exactly where the last one ended could step over it.
    //
    // Re-reading is free: `race_customer`'s unique constraint discards what we
    // have already seen. Correctness does not depend on the arithmetic here.
    const since = new Date(
      Math.max(
        racer.activatedAt.getTime(),
        racer.countReconciledAt
          ? racer.countReconciledAt.getTime() - OVERLAP_MS
          : racer.activatedAt.getTime(),
      ),
    );

    // The window never runs past the end of the race. A payment taken after the
    // clock stopped is not a customer of this race, and counting one would let a
    // founder reach ten on a sale they made the day after they lost.
    const until = new Date(Math.min(now.getTime(), racer.endsAt.getTime()));

    // Nothing can have been earned in a window that ends before it starts. This
    // is the expired-race case: `endsAt` is in the past, `since` is the last
    // reconcile, and the intersection is empty. Skipping the read keeps the
    // provider call honest rather than asking Stripe for a negative range.
    const payments: ProviderPayment[] = [];

    if (since.getTime() < until.getTime()) {
      for await (const payment of provider.listPayments(asProviderConnection, { since, until })) {
        payments.push(payment);
      }
    }

    await store.recordPayments(racer.id, payments);

    // --- The count, recomputed ---------------------------------------------
    const customerCount = await store.countCustomers(racer.id);

    // Called even when the count is unchanged, because `count_reconciled_at`
    // is how a reader knows the number is fresh. A run that found nothing new
    // still looked, and recording that is what keeps the staleness honest.
    const advanced = await store.advance(
      racer.id,
      racer.currentCustomerCount,
      customerCount,
      now,
    );

    if (advanced && customerCount > racer.currentCustomerCount) {
      await store.recordEvent({
        racerId: racer.id,
        type: "customer_milestone",
        customerCount,
        occurredAt: now,
      });
    }

    // --- The finish line ----------------------------------------------------
    //
    // Reached first, because a race that hit ten keeps its win even if the
    // window closed before the poller noticed. Ordering these the other way
    // would expire a race that had already been won.
    let finished = false;
    let expired = false;

    if (customerCount >= TARGET_CUSTOMERS && !racer.reachedTenAt) {
      // The moment the tenth customer first paid, not the moment we looked.
      // Falls back to `now` only if the row is unreadable, which would mean the
      // count and the stored customers disagree — and reporting the win is
      // still better than reporting nothing.
      const tenthPaidAt = (await store.nthCustomerPaidAt(racer.id, TARGET_CUSTOMERS)) ?? now;

      // Compare-and-set, so exactly one run across the whole fleet is the one
      // that finishes the race and emits the event.
      finished = await store.markReachedTen(racer.id, tenthPaidAt);

      if (finished) {
        await store.recordEvent({
          racerId: racer.id,
          type: "finished",
          customerCount,
          // Also the paid-at instant, so the timeline and the race end agree
          // rather than differing by however long the poll interval was.
          occurredAt: tenthPaidAt,
        });
      }
    } else if (now.getTime() > racer.endsAt.getTime()) {
      // The window closed short of ten. Compare-and-set, so exactly one run
      // writes it — and so a race that finished on the previous branch cannot
      // be expired by the same pass.
      expired = await store.markExpired(racer.id);

      if (expired) {
        await store.recordEvent({
          racerId: racer.id,
          type: "expired",
          customerCount,
          // The close of the window, not the moment we noticed it had closed.
          occurredAt: racer.endsAt,
        });
      }
    }

    await store.finishRun(runId, {
      status: "ok",
      customerCount,
      errorCode: null,
    });

    return { ok: true, racerId: racer.id, customerCount, advanced, finished, expired };
  } catch (error) {
    // --- The key stopped working -------------------------------------------
    //
    // A 401 or a permission error is not a transient fault, and retrying it is
    // pointless: the credential is wrong, revoked, or scoped below what we need,
    // and it will answer the same way in thirty minutes and in thirty days. So
    // the connection is marked broken and nothing reads it again until the racer
    // reconnects.
    //
    // The count is left exactly as it was. Writing it here — even to the value
    // it already holds — would make it a number this job decided rather than the
    // last number the provider confirmed, and the difference matters when the
    // whole claim is that the numbers are real.
    //
    // No retry storm: the next run finds a connection that is not `connected`
    // and returns before touching the provider at all.
    const lost = isCredentialRefusal(error);

    if (lost && connectionId) {
      const broke = await store
        .markConnectionBroken(connectionId, lost)
        .catch(() => false);

      // Only the run that performed the transition announces it. Two runs
      // failing together produce one broken connection and one event.
      if (broke) {
        await store
          .recordEvent({
            racerId: racer.id,
            type: "connection_lost",
            customerCount: racer.currentCustomerCount,
            occurredAt: now,
          })
          .catch(() => {
            // The connection is already broken and the count already frozen;
            // losing the timeline entry is worse than a retry but not worth
            // failing the run over.
          });
      }
    }

    // A fixed category and an id. **Never the error's text.**
    //
    // This is not defensive habit. Stripe answers a bad key with
    // `"Invalid API Key provided: rk_live_51abc***"` — the credential's own
    // prefix, in the message — and `02` §257 forbids logging provider responses
    // or credential material. The adapter now reduces provider failures to
    // categories before they reach here, so this line would normally be safe;
    // it is written this way so that it stays safe if that ever regresses.
    //
    // The racer id is the useful part for debugging. The message never was.
    console.error("[reconcile] failed", {
      racerId: racer.id,
      code: lost ?? "provider_failed",
    });

    if (runId) {
      await store
        .finishRun(runId, {
          status: "failed",
          customerCount: null,
          errorCode: lost ?? "provider_failed",
        })
        .catch(() => {
          // A failure to record a failure is not worth propagating; the next
          // poll tries again.
        });
    }

    return {
      ok: false,
      racerId: racer.id,
      reason: lost ? "connection_lost" : "provider_failed",
    };
  }
}

/**
 * Whether a thrown error means the credential itself was refused.
 *
 * Returns the category to record, or null for anything transient. Only two of
 * the adapter's categories are permanent: `rejected` (401 — wrong, revoked, or
 * never valid) and `insufficient_permission` (403 — valid but scoped below what
 * we need). Both need the racer to make a new key, which is why they are
 * separated from a network failure that just needs another poll.
 *
 * Matched on the class rather than on the message, because the message is
 * exactly what must never be inspected — Stripe's own text quotes the key back.
 */
function isCredentialRefusal(error: unknown): "rejected" | "insufficient_permission" | null {
  if (!(error instanceof CredentialError)) return null;
  if (error.reason === "rejected" || error.reason === "insufficient_permission") {
    return error.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

export type ReconcileSummary = {
  considered: number;
  reconciled: number;
  advanced: number;
  finished: string[];
  expired: string[];
  failures: Array<{ racerId: string; reason: ReconcileFailure }>;
};

/**
 * Reconciles every active racer.
 *
 * Sequential rather than concurrent, deliberately: this runs on a schedule
 * against a third-party API with rate limits, and the number of concurrent
 * racers in a 7-day race is small. Parallelising would trade a real risk of
 * being rate-limited for a latency nobody is waiting on.
 *
 * One racer's failure does not stop the others. The summary reports what
 * happened so a scheduled run leaves evidence rather than a single number.
 */
export async function reconcileActiveRacers(
  store: ReconcileStore,
  /**
   * A provider scoped to one racer — a function, not an instance.
   *
   * This is not incidental. `stripeRestrictedProvider(owner)` binds the racer
   * at construction so credential resolution is ownership-checked inside the
   * database query. A fleet-wide job is the one caller that legitimately spans
   * every racer, and the tempting shortcut — build one provider with no owner —
   * would resolve nothing at all, because the ownership filter would compare
   * against an empty id and match no row.
   *
   * Passing a factory keeps the property intact: even here, a credential is
   * only ever resolved for the racer it belongs to, so a bug in this loop
   * cannot read one racer's Stripe account into another's race.
   */
  providerFor: (racerId: string) => VerificationProvider,
  now: Date = new Date(),
): Promise<ReconcileSummary> {
  const racers = await store.activeRacers();

  const summary: ReconcileSummary = {
    considered: racers.length,
    reconciled: 0,
    advanced: 0,
    finished: [],
    expired: [],
    failures: [],
  };

  for (const racer of racers) {
    const outcome = await reconcileRacer(store, providerFor(racer.id), racer, now);

    if (!outcome.ok) {
      summary.failures.push({ racerId: outcome.racerId, reason: outcome.reason });
      continue;
    }

    summary.reconciled += 1;
    if (outcome.advanced) summary.advanced += 1;
    if (outcome.finished) summary.finished.push(outcome.racerId);
    if (outcome.expired) summary.expired.push(outcome.racerId);
  }

  return summary;
}
