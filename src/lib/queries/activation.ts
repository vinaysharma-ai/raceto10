import "server-only";

import { getRaceDuration } from "@/lib/race/config";
import { ActivationStorageError, type ActivationStore, type RacerState } from "@/lib/race/activate.ts";
import { getCurrentRacerId } from "@/lib/queries/provider-connection";

/**
 * A failed write, with the database's code kept.
 *
 * `throw new Error(error.message)` was the shape here, and it threw away the
 * only part that identifies the failure: PostgREST's `code`. A constraint
 * violation, a missing grant and a stale schema cache all produce a sentence
 * that reads like a sentence, and a `code` that distinguishes them.
 */
function fail(step: string, error: { code?: string | null; message: string }): never {
  throw new ActivationStorageError(step, error.code ?? null, error.message);
}

/**
 * The Supabase-backed activation store.
 *
 * `src/lib/race/activate.ts` holds the rules; this is the half that knows about
 * tables. The important part is `beginActivation`, which is where idempotency
 * actually lives — see the note on it below.
 */

/**
 * Every racer waiting for a clock, oldest first.
 *
 * The owner's batch reads this. Ordered by when they finished registering, so
 * somebody who has been waiting longest starts first — an unordered read would
 * make the order depend on the database's mood, and the first founder to sign up
 * would have no reason to be the last to start.
 */
export async function readyRacerIds(): Promise<string[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const db = createAdminClient();

  const { data, error } = await db
    .from("racer")
    .select("id")
    .eq("status", "ready")
    .order("created_at", { ascending: true });

  if (error) fail("readyRacerIds", error);
  return (data ?? []).map((row) => row.id);
}

/**
 * The activation store, for one racer.
 *
 * The parameter exists for the owner's batch, which has no session and
 * therefore no `currentRacerId`. It is deliberately a required-looking
 * parameter rather than a second function: two stores that differ only in where
 * the racer id comes from is how one of them ends up missing a method.
 *
 * Omitting it keeps the session-scoped behaviour every other caller relies on.
 */
export function activationStore(racerId?: string): ActivationStore {
  return {
    currentRacerId: racerId ? async () => racerId : getCurrentRacerId,

    async loadRacer(racerId): Promise<RacerState | null> {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("racer")
        .select(
          "id, status, activated_at, race_end_at, baseline_customer_count",
        )
        .eq("id", racerId)
        .maybeSingle();

      if (!data) return null;

      return {
        id: data.id,
        status: data.status,
        activatedAt: data.activated_at ? new Date(data.activated_at) : null,
        raceEndAt: data.race_end_at ? new Date(data.race_end_at) : null,
        baselineCustomerCount: data.baseline_customer_count,
      };
    },

    async loadConnection(racerId, provider) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("provider_connections")
        .select("id, connection_status, external_account_ref")
        .eq("racer_id", racerId)
        .eq("provider", provider)
        .maybeSingle();

      if (!data) return null;
      return {
        id: data.id,
        status: data.connection_status,
        accountId: data.external_account_ref ?? "",
      };
    },

    /**
     * The most recent registration-time verdict.
     *
     * Ordered by `captured_at` and limited to the registration source, so a
     * later activation or reconcile snapshot cannot be mistaken for the entry
     * decision. Reconnecting a provider writes a fresh registration row, which
     * is what lets a founder who fixed their account try again.
     */
    async latestRegistrationEligibility(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("verification_snapshots")
        .select("verification_status")
        .eq("racer_id", racerId)
        .eq("source", "registration")
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) return null;

      const status = data.verification_status;
      // The column is constrained to these three, but the generated type widens
      // to `string`; anything unrecognised is treated as no verdict at all
      // rather than as a pass.
      if (status === "eligible" || status === "ineligible" || status === "failed") {
        return status;
      }
      return null;
    },

    /**
     * Out of the batch, permanently.
     *
     * Conditional on the prior status for the same reason `beginActivation` is:
     * a racer whose clock is running must not be pulled out of a race by a
     * stale re-check. `ready` and `verification_failed` are the only states this
     * can move.
     */
    async markIneligible(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("racer")
        .update({ status: "ineligible" })
        .eq("id", racerId)
        .in("status", ["ready", "verification_failed"]);

      if (error) fail("markIneligible", error);
    },

    /**
     * Deletes the sealed key behind a racer's connection.
     *
     * Resolves the connection first, because the vault is keyed on the
     * connection's id rather than on the racer. A racer with no connection has
     * nothing to delete and no error to report — the promise is that no key is
     * held, and none is.
     *
     * A failure here throws rather than being swallowed. Activation reports it
     * as a storage problem, which is the truth, and the racer stays `ineligible`
     * with the owner able to see why. Silence would leave a live credential for
     * a racer who is never coming back, which is exactly what this exists to
     * prevent.
     */
    async deleteCredential(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data: connection, error: readError } = await db
        .from("provider_connections")
        .select("id")
        .eq("racer_id", racerId)
        .maybeSingle();

      if (readError) fail("deleteCredential.read", readError);
      if (!connection) return;

      const { error } = await db
        .from("provider_credentials")
        .delete()
        .eq("provider_connection_id", connection.id);

      if (error) fail("deleteCredential.delete", error);
    },

    /**
     * What the start email needs about a racer.
     *
     * The address comes from `profiles`, not from `racer`: it is the signed-in
     * person's, and `racer` has never held one. A racer whose profile has no
     * address gets null and is skipped — X sign-ins often carry none, and the
     * profile step is what asks for one.
     */
    async loadEmailContext(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("racer")
        .select("product_name, public_slug, race_end_at, email_sent_at, profiles(email)")
        .eq("id", racerId)
        .maybeSingle();

      if (!data) return null;

      const profile = data.profiles as { email: string | null } | null;

      return {
        email: profile?.email ?? null,
        productName: data.product_name,
        publicSlug: data.public_slug,
        raceEndAt: data.race_end_at ? new Date(data.race_end_at) : null,
        emailSentAt: data.email_sent_at ? new Date(data.email_sent_at) : null,
      };
    },

    /**
     * Records that the email went.
     *
     * Called only on a successful send. A failure or a skip leaves the column
     * null, which is the retry state — writing a failure marker instead would
     * mean the racer never receives it even after the provider is configured.
     */
    async markEmailSent(racerId, at) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("racer")
        .update({ email_sent_at: at.toISOString() })
        .eq("id", racerId);

      if (error) fail("markEmailSent", error);
    },

    raceDurationDays: getRaceDuration,

    /**
     * The compare-and-set.
     *
     * One conditional UPDATE rather than a read followed by a write. The
     * `.is("activated_at", null)` is the whole point: two requests arriving
     * together both see a null column when they read, and only one of them can
     * match this predicate. A read-then-write pair would let both believe they
     * were first, and the second would overwrite the first racer's baseline
     * with its own — a racer's starting position is not something to lose to a
     * double-tap.
     *
     * Zero rows updated means somebody else won, and the existing activation is
     * read back so the caller can return the race that actually started.
     */
    async beginActivation(input) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("racer")
        .update({
          status: input.status,
          activated_at: input.activatedAt.toISOString(),
          race_end_at: input.raceEndAt.toISOString(),
          baseline_customer_count: input.baselineCustomerCount,
          baseline_captured_at: input.baselineCapturedAt.toISOString(),
          public_consent_at: input.publicConsentAt.toISOString(),
        })
        .eq("id", input.racerId)
        .is("activated_at", null)
        .select("activated_at, race_end_at, baseline_customer_count")
        .maybeSingle();

      if (error) fail("beginActivation", error);

      if (data) return { won: true as const };

      // Somebody else activated first. Read theirs.
      const { data: existing, error: readError } = await db
        .from("racer")
        .select("activated_at, race_end_at, baseline_customer_count")
        .eq("id", input.racerId)
        .maybeSingle();

      if (readError || !existing?.activated_at || !existing.race_end_at) {
        fail(
          "beginActivation.readExisting",
          readError ?? { message: "activation state is unreadable" },
        );
      }

      return {
        won: false as const,
        existing: {
          activatedAt: new Date(existing.activated_at),
          raceEndAt: new Date(existing.race_end_at),
          baselineCustomerCount: existing.baseline_customer_count ?? 0,
        },
      };
    },

    async writeBaselineCustomers(racerId, externalIds) {
      // Empty for every racer who passes the gate, because eligibility requires
      // zero existing customers. Written anyway: the table exists so "already
      // had" is a set of ids rather than a number, and a racer whose first
      // customer arrives seconds after activation must not be counted against
      // a baseline that was never recorded.
      if (externalIds.length === 0) return;

      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db.from("race_baseline_customer").insert(
        externalIds.map((externalId) => ({
          racer_id: racerId,
          external_customer_id: externalId,
        })),
      );

      if (error) fail("writeBaselineCustomers", error);
    },

    async recordActivationSnapshot(input) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db.from("verification_snapshots").insert({
        racer_id: input.racerId,
        provider_connection_id: input.connectionId,
        customer_count: input.customerCount,
        mrr_minor: 0,
        verification_status: "eligible",
        source: "activation",
        captured_at: input.capturedAt.toISOString(),
      });

      if (error) fail("recordActivationSnapshot", error);
    },

    async recordActivationEvent(input) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db.from("race_event").insert({
        racer_id: input.racerId,
        event_type: "activated",
        // NULL, and it has to be. `race_event_customer_number_range` allows
        // `null` or a value in 1..10, because the column holds a *milestone*
        // number. An activation has none — the baseline is zero, which means
        // "no customer yet" rather than "customer number zero". Writing 0 here
        // was a 23514 that surfaced as `storage_error` on a race whose clock
        // had already started.
        milestone_customer_count: null,
        occurred_at: input.occurredAt.toISOString(),
      });

      if (error) fail("recordActivationEvent", error);
    },
  };
}
