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

  recordActivationEvent(input: {
    racerId: string;
    occurredAt: Date;
    customerCount: number;
  }): Promise<void>;
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

  try {
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

    if (!verdict.eligible) return refuse("not_eligible");

    // --- Write ---------------------------------------------------------------
    //
    // The baseline is empty whenever we reach here, because a non-empty one
    // fails eligibility above. It is written anyway: the table exists so that
    // "already had" is a set of ids rather than a number, and a racer whose
    // first customer arrives seconds after activation must not be counted
    // against a baseline that was never recorded.
    const raceEndAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

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

    await store.writeBaselineCustomers(
      racerId,
      baseline.map((customer) => customer.externalId),
    );

    await store.recordActivationSnapshot({
      racerId,
      connectionId: connection.id,
      customerCount: baseline.length,
      capturedAt: now,
    });

    await store.recordActivationEvent({
      racerId,
      occurredAt: now,
      customerCount: baseline.length,
    });

    return {
      ok: true,
      alreadyActive: false,
      activatedAt: now,
      raceEndAt,
      baselineCustomerCount: baseline.length,
      durationDays,
    };
  } catch {
    // Category and racer only. This path can see a provider failure, and a
    // provider's own message can quote the credential back — Stripe answers a
    // bad key with `"Invalid API Key provided: rk_live_…"`.
    console.error("[activation] failed", { racerId, code: "storage_error" });
    return refuse("storage_error");
  }
}

function refuse(reason: ActivationFailure): ActivationOutcome {
  return { ok: false, reason, message: describeActivationFailure(reason) };
}

/** Whole days between two instants, rounded — the window a racer actually got. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
