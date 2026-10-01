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
  currentCustomerCount: number;
  countReconciledAt: Date | null;
  reachedTenAt: Date | null;
};

export type ReconcileFailure = "no_connection" | "connection_not_ready" | "provider_failed" | "storage_error";

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

  recordEvent(input: {
    racerId: string;
    type: "customer_milestone" | "finished";
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

  try {
    const connection = await store.connectionFor(racer.id);
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

    const payments: ProviderPayment[] = [];
    for await (const payment of provider.listPayments(asProviderConnection, { since, until: now })) {
      payments.push(payment);
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
    let finished = false;

    if (customerCount >= TARGET_CUSTOMERS && !racer.reachedTenAt) {
      // Compare-and-set, so exactly one run across the whole fleet is the one
      // that finishes the race and emits the event.
      finished = await store.markReachedTen(racer.id, now);

      if (finished) {
        await store.recordEvent({
          racerId: racer.id,
          type: "finished",
          customerCount,
          occurredAt: now,
        });
      }
    }

    await store.finishRun(runId, {
      status: "ok",
      customerCount,
      errorCode: null,
    });

    return { ok: true, racerId: racer.id, customerCount, advanced, finished };
  } catch {
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
      code: "provider_failed",
    });

    if (runId) {
      await store
        .finishRun(runId, { status: "failed", customerCount: null, errorCode: "provider_failed" })
        .catch(() => {
          // A failure to record a failure is not worth propagating; the next
          // poll tries again.
        });
    }

    return { ok: false, racerId: racer.id, reason: "provider_failed" };
  }
}

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

export type ReconcileSummary = {
  considered: number;
  reconciled: number;
  advanced: number;
  finished: string[];
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
  }

  return summary;
}
