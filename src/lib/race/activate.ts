import type { ExternalCustomer, ProviderConnection, VerificationProvider } from "../verification/types.ts";
import { checkEligibility } from "../verification/eligibility.ts";

/**
 * Activation — the moment a racer's clock starts.
 *
 * ## The rule this file exists to enforce
 *
 * **The baseline is read from the provider, never supplied.** `activateRacer`
 * takes no count and no timestamp from its caller, so there is no parameter a
 * request body could reach. The only inputs are `now` (for testability) and the
 * racer, and the racer comes from the session inside the store. A client that
 * wanted to start with a favourable baseline would have to change this file.
 *
 * That matters more here than anywhere else in the product: the baseline is
 * what makes "10 customers" mean "10 NEW customers", and a racer who could set
 * it to their current count would start the race already finished.
 *
 * ## Why activation is a separate act from connecting
 *
 * Connecting proves the credential works. Activation starts the clock. They are
 * separated because a racer may connect days before they are ready to start,
 * and because the duration is read at activation — so a founder who connects
 * today and activates next week races for whatever the duration is *then*, which
 * is the honest reading of a configurable window.
 *
 * ## Idempotency
 *
 * `activated_at` is the marker. A second call reads the existing activation and
 * returns it unchanged rather than extending the race or re-capturing a
 * baseline. The check is inside the store's transaction, so two concurrent
 * requests cannot both win.
 */

/**
 * A write that failed, carrying the database's own code.
 *
 * ## Why this exists
 *
 * A store method used to do `throw new Error(error.message)`, which discards
 * the PostgREST code — and the code is the only part that says *what* went
 * wrong. `23514` is a constraint, `42501` is a permission, `PGRST204` is
 * PostgREST's schema cache not knowing a column. Without it a storage failure
 * is a mystery that has to be reproduced to be diagnosed.
 *
 * `step` names the operation, so a log line can say where without the caller
 * having to guess from a stack.
 */
export class ActivationStorageError extends Error {
  readonly step: string;
  readonly code: string | null;

  constructor(step: string, code: string | null, message: string) {
    super(message);
    this.name = "ActivationStorageError";
    this.step = step;
    this.code = code;
  }
}

/** Exit reasons, each with copy written for the person who hit it. */
export type ActivationFailure =
  | "no_racer"
  | "no_connection"
  | "connection_not_ready"
  /** No passing registration check on record — the gate was never run, or failed. */
  | "not_verified"
  | "not_eligible"
  /**
   * The founder has not agreed to race in public.
   *
   * A precondition, not a formality. `public_consent_at` is what every public
   * view filters on (`where r.public_consent_at is not null`), so a racer who
   * started without it would be invisible on the board, the globe and the feed
   * — competing in a race nobody can see, which is not this product.
   */
  | "no_consent"
  | "duration_unavailable"
  | "verification_failed"
  | "storage_error";

export type ActivationOutcome =
  | {
      ok: true;
      /** True when this call found an activation that already existed. */
      alreadyActive: boolean;
      activatedAt: Date;
      raceEndAt: Date;
      baselineCustomerCount: number;
      durationDays: number;
    }
  | { ok: false; reason: ActivationFailure; message: string };

export function describeActivationFailure(reason: ActivationFailure): string {
  switch (reason) {
    case "no_racer":
      return "Finish setting up your profile before starting your race.";
    case "no_connection":
      return "Connect a payment provider before starting your race.";
    case "connection_not_ready":
      return "Your payment provider connection isn't healthy. Reconnect it and try again.";
    case "not_verified":
      return "We don't have a passing eligibility check on record for this account. Reconnect your payment provider to run one.";
    case "not_eligible":
      return "Your account doesn't qualify to enter yet.";
    case "no_consent":
      return "Agree to race in public before starting. The board shows your name, handle, product and verified customer count.";
    case "duration_unavailable":
      return "We couldn't read the race duration just now. Nothing was started. Try again in a moment.";
    case "verification_failed":
      return "We couldn't verify your account just now. Nothing was started. Your clock has not begun.";
    case "storage_error":
      return "We couldn't start your race just now. Nothing was started. Try again in a moment.";
  }
}

/** A racer row, as much of it as activation reasons about. */
export type RacerState = {
  id: string;
  status: string;
  activatedAt: Date | null;
  raceEndAt: Date | null;
  baselineCustomerCount: number | null;
};

/** An existing activation, reconstructed for the idempotent path. */
export type ExistingActivation = {
  activatedAt: Date;
  raceEndAt: Date;
  baselineCustomerCount: number;
};

export type ActivationStore = {
  /** The racer for the authenticated session, or null. Never a parameter. */
  currentRacerId(): Promise<string | null>;

  loadRacer(racerId: string): Promise<RacerState | null>;

  /**
   * Moves a racer to `ineligible`, because the gate was re-run and failed.
   *
   * Conditional on the current status, so a racer whose clock is somehow already
   * running cannot be pulled back out of a race by a stale re-check.
   */
  markIneligible(racerId: string): Promise<void>;

  /**
   * Deletes the sealed credential for a racer's connection.
   *
   * Called on every terminal state, and the reason it is on this interface
   * rather than left to the caller is that /privacy makes a promise about it:
   * "It is deleted when your race ends". A promise kept at four call sites by
   * four different people is a promise that will eventually be kept at three.
   */
  deleteCredential(racerId: string): Promise<void>;

  /**
   * What the start email needs, or null.
   *
   * The address comes from `profiles`, not from the racer: `racer` has never
   * held one. A racer with no address has not finished registering, and the
   * caller skips rather than failing.
   */
  loadEmailContext(racerId: string): Promise<{
    email: string | null;
    productName: string | null;
    publicSlug: string | null;
    raceEndAt: Date | null;
    /** Null means not yet sent, so the next run retries. */
    emailSentAt: Date | null;
  } | null>;

  /**
   * Records a successful send.
   *
   * Called only on success. A failure or a skip leaves the column null, which is
   * what makes the retry possible — a failure marker would mean the racer never
   * receives it even once a provider is configured.
   */
  markEmailSent(racerId: string, at: Date): Promise<void>;

  /**
   * The racer's provider connection, if any.
   *
   * `accountId` is carried because the Connect adapter reads against it with a
   * platform key, while the restricted-key adapter ignores it and uses the
   * credential alone. An empty string here would work for the adapter that
   * ships today and break silently for the other one.
   */
  loadConnection(
    racerId: string,
    provider: string,
  ): Promise<{ id: string; status: string; accountId: string } | null>;

  /**
   * The most recent registration-time eligibility verdict, or null if none.
   *
   * Read alongside the live re-check rather than instead of it. The stored
   * verdict is what the founder was *told* when they connected; the re-check is
   * what is true now. Requiring both means a founder cannot reach activation on
   * a connection whose gate never passed — and cannot slip through on a stale
   * pass either.
   */
  latestRegistrationEligibility(
    racerId: string,
  ): Promise<"eligible" | "ineligible" | "failed" | null>;

  /** The configured race length, or null when it could not be read. */
  raceDurationDays(): Promise<number | null>;

  /**
   * Records the activation and moves the racer into `racing`.
   *
   * One call rather than several so the compare-and-set lives in the database:
   * it must write only when `activated_at` is still null, and report which
   * happened. A read-then-write pair here would let two requests both believe
   * they were first, and the second would overwrite the first racer's baseline.
   */
  beginActivation(input: {
    racerId: string;
    activatedAt: Date;
    raceEndAt: Date;
    baselineCustomerCount: number;
    baselineCapturedAt: Date;
    /**
     * The state the racer moves into. Passed in rather than hardcoded in the
     * store's SQL so the transition is visible from here and assertable in a
     * test — a status change that only exists inside a query string is a status
     * change nobody reviews.
     */
    status: "racing";
    /**
     * When the founder agreed to race in public.
     *
     * Written in the same statement as the clock, so there is no window in
     * which a racer is `racing` but invisible to every public view — which is
     * what a separate write would allow if it failed between the two.
     */
    publicConsentAt: Date;
  }): Promise<{ won: true } | { won: false; existing: ExistingActivation }>;

  /** Persists the baseline customer ids that define "already had". */
  writeBaselineCustomers(racerId: string, externalIds: string[]): Promise<void>;

  recordActivationSnapshot(input: {
    racerId: string;
    connectionId: string;
    customerCount: number;
    capturedAt: Date;
  }): Promise<void>;

  /**
   * Records that the clock started.
   *
   * ## Why there is no count here
   *
   * There used to be, and it was the bug. `race_event.milestone_customer_count`
   * is constrained to `NULL or between 1 and 10` — it is a *milestone* number,
   * which is why the column is named that. Activation's baseline is zero, and
   * zero is not a milestone: it is the absence of one. Writing `0` failed
   * `race_event_customer_number_range` with a `23514`, which surfaced as an
   * unhelpful `storage_error` on a race whose clock had already started.
   *
   * Passing no count makes that unrepresentable rather than merely fixed: a
   * caller cannot send a number that the column would reject. The feed agrees —
   * `describeActivity` reads the count for `customer_milestone` and `expired`,
   * and for `activated` it says "started a race" and ignores it.
   */
  recordActivationEvent(input: { racerId: string; occurredAt: Date }): Promise<void>;
};

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Activates a racer.
 *
 * `consent` is the one thing a caller supplies, and it is deliberately the only
 * one. It is a decision the founder makes, not a fact we verify — unlike the
 * baseline, the duration and the window, which are all read from the provider
 * and `race_config`. Note what is still absent: no count, no start, no end.
 */
export async function activateRacer(
  store: ActivationStore,
  provider: VerificationProvider,
  consent: boolean,
  now: Date = new Date(),
): Promise<ActivationOutcome> {
  const racerId = await store.currentRacerId();
  if (!racerId) return refuse("no_racer");

  // Checked before anything is read. A racer who has not agreed to be public
  // cannot start a public race, and finding that out after the clock began
  // would mean either an invisible racer or a reversed activation.
  if (!consent) return refuse("no_consent");

  // Names the operation in flight, so a storage failure can say which one it
  // was. Assigned before each step rather than derived from a stack afterwards,
  // because the error has been re-wrapped by the time it arrives.
  let step = "start";

  try {
    step = "loadRacer";
    const racer = await store.loadRacer(racerId);
    if (!racer) return refuse("no_racer");

    // --- Idempotency, first --------------------------------------------------
    //
    // Checked before anything else is read or written. A founder who taps the
    // button twice, or reloads the page, must get the race they already have —
    // not a second baseline, and not an extended window.
    if (racer.activatedAt && racer.raceEndAt && racer.baselineCustomerCount !== null) {
      return {
        ok: true,
        alreadyActive: true,
        activatedAt: racer.activatedAt,
        raceEndAt: racer.raceEndAt,
        baselineCustomerCount: racer.baselineCustomerCount,
        // Derived rather than stored: the duration is the window they actually
        // got, which is what matters if the config changed since.
        durationDays: daysBetween(racer.activatedAt, racer.raceEndAt),
      };
    }

    // A racer who finished, withdrew or was disqualified does not restart by
    // activating again.
    if (racer.status === "finished" || racer.status === "withdrawn" || racer.status === "disqualified") {
      return refuse("not_eligible");
    }

    // --- The connection must be healthy -------------------------------------
    step = "loadConnection";
    const connection = await store.loadConnection(racerId, provider.id);
    if (!connection) return refuse("no_connection");
    if (connection.status !== "connected") return refuse("connection_not_ready");

    // --- The registration gate must have passed ------------------------------
    //
    // Checked before the live re-check, and for a different reason. This one
    // asks "was this account ever admitted?", which is a fact about the
    // connection's history. A racer whose probe failed at registration has
    // never been told they qualify — letting them activate on the strength of
    // a fresh check alone would skip the step where they saw the verdict.
    step = "registrationEligibility";
    const registrationVerdict = await store.latestRegistrationEligibility(racerId);
    if (registrationVerdict === null || registrationVerdict === "failed") {
      return refuse("not_verified");
    }
    if (registrationVerdict === "ineligible") return refuse("not_eligible");

    const asProviderConnection: ProviderConnection = {
      provider: provider.id,
      accountId: connection.accountId,
      credentialRef: connection.id,
    };

    // --- The duration, read now ---------------------------------------------
    step = "raceDuration";
    const durationDays = await store.raceDurationDays();
    if (!durationDays || durationDays <= 0) return refuse("duration_unavailable");

    // --- Re-verify at activation --------------------------------------------
    //
    // Not a formality. Registration may have been days ago, and the rule is
    // that a racer starts from zero — so the gate is re-run against the account
    // as it stands at the moment the clock starts.
    //
    // The baseline read and the eligibility read are the same page of
    // customers, so this costs nothing extra: everything created before `now`
    // is both "already had" and "not starting from zero".
    let baseline: ExternalCustomer[];
    let mrrMinor: number | null;

    step = "providerRead";
    try {
      baseline = [];
      for await (const customer of provider.listCustomers(asProviderConnection, now)) {
        baseline.push(customer);

        // Stops at the first customer. Eligibility cannot pass with a
        // non-empty baseline, so paging an established account in full would
        // only be to prove something the opening row already proves — and the
        // count is therefore exact for the only case that proceeds: zero.
        break;
      }

      if (provider.readMonthlyRecurringRevenue) {
        const mrr = await provider.readMonthlyRecurringRevenue(asProviderConnection);
        mrrMinor = mrr.known ? mrr.mrrMinor : null;
      } else {
        mrrMinor = null;
      }
    } catch {
      // A dead key, a revoked credential, or an unreachable provider. The clock
      // must not start on a count we could not read — that is precisely the
      // number the whole product rests on.
      return refuse("verification_failed");
    }

    const verdict = checkEligibility({
      existingCustomers: baseline.length,
      mrrMinor,
    });

    // --- The re-check failed ------------------------------------------------
    //
    // The account had customers or revenue at the moment the clock was due to
    // start. Three things happen, and all three matter:
    //
    //   1. The status becomes `ineligible`. Left as `ready`, this racer would sit
    //      in every future activation batch, re-checked each time, and the board
    //      would count them as waiting for a clock that is never going to start.
    //   2. The key is deleted. They are not going to race, and /privacy says the
    //      key is deleted when the race ends — this is a race that ended before
    //      it began. Holding a live credential for an account we have no
    //      remaining reason to read is the one thing the vault is built to avoid.
    // NOT DONE: the event. `race_event_type` is
    // `joined | activated | customer_milestone | finished`, with no value for a
    // racer who failed the gate, so writing one needs an enum migration that has
    // not been approved. Nothing is published about this racer either way — they
    // never became public — so the only thing missing is the audit line, not the
    // honesty of the board.
    //
    // No email is sent and none is owed: they were told at registration that a
    // change would stop the clock, and nothing has been published about them.
    if (!verdict.eligible) {
      step = "markIneligible";
      await store.markIneligible(racerId);

      // Deleted after the status, and deliberately not before: if this throws,
      // the racer is already `ineligible` and out of the batch, and the
      // credential is then the only thing left on the failure path. The reverse
      // order would delete a key for a racer who then stayed `ready` and could
      // still be activated with no credential — a race that starts and can never
      // be counted.
      step = "deleteCredential";
      await store.deleteCredential(racerId);

      return refuse("not_eligible");
    }

    // --- Write ---------------------------------------------------------------
    //
    // The baseline is empty whenever we reach here, because a non-empty one
    // fails eligibility above. It is written anyway: the table exists so that
    // "already had" is a set of ids rather than a number, and a racer whose
    // first customer arrives seconds after activation must not be counted
    // against a baseline that was never recorded.
    const raceEndAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    step = "beginActivation";
    const begun = await store.beginActivation({
      racerId,
      activatedAt: now,
      raceEndAt,
      baselineCustomerCount: baseline.length,
      baselineCapturedAt: now,
      status: "racing",
      publicConsentAt: now,
    });

    if (!begun.won) {
      // Another request activated first. Its window is the real one; ours is
      // discarded rather than written over it.
      return {
        ok: true,
        alreadyActive: true,
        activatedAt: begun.existing.activatedAt,
        raceEndAt: begun.existing.raceEndAt,
        baselineCustomerCount: begun.existing.baselineCustomerCount,
        durationDays: daysBetween(begun.existing.activatedAt, begun.existing.raceEndAt),
      };
    }

    step = "writeBaselineCustomers";
    await store.writeBaselineCustomers(
      racerId,
      baseline.map((customer) => customer.externalId),
    );

    step = "recordActivationSnapshot";
    await store.recordActivationSnapshot({
      racerId,
      connectionId: connection.id,
      customerCount: baseline.length,
      capturedAt: now,
    });

    step = "recordActivationEvent";
    await store.recordActivationEvent({ racerId, occurredAt: now });

    return {
      ok: true,
      alreadyActive: false,
      activatedAt: now,
      raceEndAt,
      baselineCustomerCount: baseline.length,
      durationDays,
    };
  } catch (error) {
    logStorageError(racerId, step, error);
    return refuse("storage_error");
  }
}

/**
 * The one line a storage failure leaves.
 *
 * ## What it says, and what it refuses to
 *
 * The step, always. Outside production it also carries the database's code and
 * message, because diagnosing a write that failed without reproducing it needs
 * the difference between a constraint, a permission and a stale schema cache —
 * and those are three different fixes.
 *
 * In production the detail is dropped. A PostgREST message can quote the values
 * in the failing row, and this path is one provider failure away from a message
 * that contains a credential — Stripe answers a bad key with `"Invalid API Key
 * provided: rk_live_…"`, which is exactly the string this codebase refuses to
 * log anywhere else. The racer id is an internal uuid the owner already holds,
 * and the step is ours, so both stay.
 *
 * The HTTP response is unchanged either way: a fixed reason, never this.
 */
function logStorageError(racerId: string, step: string, error: unknown): void {
  const named = error instanceof ActivationStorageError ? error.step : step;

  if (process.env.NODE_ENV === "production") {
    console.error("[activate] storage_error", { racerId, step: named, code: "storage_error" });
    return;
  }

  const detail = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };

  console.error("[activate] storage_error", {
    racerId,
    step: named,
    code: "storage_error",
    pgCode: (error instanceof ActivationStorageError ? error.code : null) ?? detail.code ?? null,
    pgMessage: typeof detail.message === "string" ? detail.message : String(error),
    ...(detail.details ? { pgDetails: detail.details } : {}),
    ...(detail.hint ? { pgHint: detail.hint } : {}),
  });
}

function refuse(reason: ActivationFailure): ActivationOutcome {
  return { ok: false, reason, message: describeActivationFailure(reason) };
}

/** Whole days between two instants, rounded — the window a racer actually got. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
