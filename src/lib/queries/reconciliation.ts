import "server-only";

import type { ActiveRacer, ReconcileStore } from "@/lib/race/reconcile.ts";

/**
 * The Supabase-backed reconciliation store.
 *
 * `src/lib/race/reconcile.ts` holds the rules; this is the half that knows about
 * tables. Two methods here carry the concurrency story — `advance` and
 * `markReachedTen` — and both are single conditional statements rather than
 * read-then-write pairs.
 */

export function reconciliationStore(): ReconcileStore {
  return {
    async activeRacers(): Promise<ActiveRacer[]> {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("racer")
        .select(
          "id, activated_at, race_end_at, current_customer_count, count_reconciled_at, reached_ten_at",
        )
        .eq("status", "racing");

      if (!data) return [];

      return data
        // A racer with no `activated_at` is not racing in any meaningful
        // sense — nothing can be counted against a window that does not exist.
        // Same for `race_end_at`: a start with no end is not a race this job
        // can decide anything about, and guessing an end from the configured
        // duration would be inventing a window the racer never agreed to.
        .filter((row) => row.activated_at !== null && row.race_end_at !== null)
        .map((row) => ({
          id: row.id,
          activatedAt: new Date(row.activated_at as string),
          endsAt: new Date(row.race_end_at as string),
          currentCustomerCount: row.current_customer_count ?? 0,
          countReconciledAt: row.count_reconciled_at ? new Date(row.count_reconciled_at) : null,
          reachedTenAt: row.reached_ten_at ? new Date(row.reached_ten_at) : null,
        }));
    },

    async connectionFor(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("provider_connections")
        .select("id, connection_status, external_account_ref")
        .eq("racer_id", racerId)
        .maybeSingle();

      if (!data) return null;
      return {
        id: data.id,
        status: data.connection_status,
        accountId: data.external_account_ref ?? "",
      };
    },

    async beginRun(connectionId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("reconciliation_runs")
        .insert({ provider_connection_id: connectionId, status: "running" })
        .select("id")
        .single();

      if (error || !data) throw new Error(error?.message ?? "could not open a run");
      return data.id;
    },

    async finishRun(runId, result) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("reconciliation_runs")
        .update({
          status: result.status,
          customer_count: result.customerCount,
          error_code: result.errorCode,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);

      if (error) throw new Error(error.message);
    },

    /**
     * Records payments, letting the database discard the ones already stored.
     *
     * `ignoreDuplicates` maps to `ON CONFLICT DO NOTHING` against
     * `race_customer_key (racer_id, external_customer_id)`. Replaying a window
     * is therefore not merely tolerated but a no-op, which is what lets the
     * poller overlap its windows to avoid stepping over a late-arriving payment.
     *
     * `first_paid_at` is deliberately not updated on conflict: a customer's
     * first payment is when they first paid, and letting a later payment move
     * it earlier or later would rewrite history.
     */
    async recordPayments(racerId, payments) {
      if (payments.length === 0) return;

      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      // One customer may have several payments in the window. The unique key is
      // on the customer, so duplicates within this batch would collide with
      // each other, not just with stored rows — collapsed here, keeping the
      // earliest, which is what `first_paid_at` means.
      const byCustomer = new Map<string, { customerId: string; paidAt: Date; paymentId: string }>();

      for (const payment of payments) {
        const existing = byCustomer.get(payment.externalCustomerId);
        if (!existing || payment.paidAt < existing.paidAt) {
          byCustomer.set(payment.externalCustomerId, {
            customerId: payment.externalCustomerId,
            paidAt: payment.paidAt,
            paymentId: payment.externalPaymentId,
          });
        }
      }

      const { error } = await db.from("race_customer").upsert(
        [...byCustomer.values()].map((row) => ({
          racer_id: racerId,
          external_customer_id: row.customerId,
          first_paid_at: row.paidAt.toISOString(),
          provider_payment_id: row.paymentId,
        })),
        { onConflict: "racer_id,external_customer_id", ignoreDuplicates: true },
      );

      if (error) throw new Error(error.message);
    },

    /**
     * The authoritative count.
     *
     * Recomputed rather than incremented — the migration says so directly:
     * "current_customer_count is count(*) over this table and is always safe to
     * recompute from scratch." An increment would drift on replay; this cannot.
     */
    async countCustomers(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { count, error } = await db
        .from("race_customer")
        .select("id", { count: "exact", head: true })
        .eq("racer_id", racerId);

      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    /**
     * Compare-and-set on the cached count.
     *
     * `.eq("current_customer_count", expected)` is the guard: two runs that both
     * read 3 and both want to write 5 — only one matches. The loser's event is
     * suppressed, so a milestone is announced once rather than twice.
     *
     * The null case is handled separately because a null column never equals
     * anything; a racer who has never been reconciled has no stored count yet.
     */
    async advance(racerId, expectedCount, nextCount, reconciledAt) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const base = db
        .from("racer")
        .update({
          current_customer_count: nextCount,
          count_reconciled_at: reconciledAt.toISOString(),
        })
        .eq("id", racerId);

      const guarded =
        expectedCount === 0
          ? base.or("current_customer_count.eq.0,current_customer_count.is.null")
          : base.eq("current_customer_count", expectedCount);

      const { data, error } = await guarded.select("id");
      if (error) throw new Error(error.message);

      return (data?.length ?? 0) > 0;
    },

    /**
     * Compare-and-set on the finish line.
     *
     * Exactly one run across the fleet wins this, so exactly one `finished`
     * event is emitted and `reached_ten_at` is written once. A second run
     * arriving moments later updates nothing and reports that it did not
     * finish the race.
     */
    async markReachedTen(racerId, at) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("racer")
        .update({ reached_ten_at: at.toISOString(), status: "finished" })
        .eq("id", racerId)
        .is("reached_ten_at", null)
        .select("id");

      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },

    /**
     * The nth customer's first payment, oldest first.
     *
     * `first_paid_at` is written by `recordPayments` from the charge's own
     * `created` instant, so this is the moment money arrived rather than the
     * moment a poller saw it. Ordering by it and taking one row is a single
     * query; the alternative — reading every customer back and sorting in
     * process — moves the same work somewhere it cannot be indexed.
     */
    async nthCustomerPaidAt(racerId, n) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("race_customer")
        .select("first_paid_at")
        .eq("racer_id", racerId)
        .order("first_paid_at", { ascending: true })
        .range(n - 1, n - 1)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data ? new Date(data.first_paid_at) : null;
    },

    /**
     * Compare-and-set on the closing of the window.
     *
     * Guarded on `status = 'racing'`, which is the whole safety of it: a race
     * that finished earlier in the same pass is no longer `racing`, so it
     * matches nothing and cannot be expired after being won.
     */
    async markExpired(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("racer")
        .update({ status: "expired" })
        .eq("id", racerId)
        .eq("status", "racing")
        .select("id");

      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },

    /**
     * The key stopped working.
     *
     * Only the connection is written. The count is frozen by leaving it exactly
     * as it was — writing it here, even to the same value, would make it a
     * number this job decided rather than the last number the provider
     * confirmed.
     *
     * `last_verified_at` is deliberately not touched: it records when the
     * account was last read successfully, and stamping it now would claim a
     * successful read that did not happen.
     */
    async markConnectionBroken(connectionId, errorCode) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("provider_connections")
        .update({
          connection_status: "broken",
          error_code: errorCode,
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionId)
        // Compare-and-set on the status, which is what makes the event count to
        // one: two runs failing at the same instant both update nothing on the
        // second pass, so only the first announces it.
        .eq("connection_status", "connected")
        .select("id");

      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },

    /**
     * Deletes the sealed key behind a racer's connection.
     *
     * Resolves the connection first, because the vault is keyed on the
     * connection's id rather than on the racer. A racer with no connection has
     * nothing to delete and no error to report — the promise is that no key is
     * held, and none is.
     *
     * Throwing on a real failure is deliberate. The caller decides whether a
     * failed deletion is worth failing the run over, and on the finished and
     * expired paths it is not — but silence here would leave a live credential
     * for a race that is over, which is the one outcome this exists to prevent.
     */
    async deleteCredential(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data: connection, error: readError } = await db
        .from("provider_connections")
        .select("id")
        .eq("racer_id", racerId)
        .maybeSingle();

      if (readError) throw new Error(readError.message);
      if (!connection) return;

      const { error } = await db
        .from("provider_credentials")
        .delete()
        .eq("provider_connection_id", connection.id);

      if (error) throw new Error(error.message);
    },

    async recordEvent(input) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db.from("race_event").insert({
        racer_id: input.racerId,
        event_type: input.type,
        milestone_customer_count: input.customerCount,
        occurred_at: input.occurredAt.toISOString(),
      });

      if (error) throw new Error(error.message);
    },
  };
}
