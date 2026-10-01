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
          "id, activated_at, current_customer_count, count_reconciled_at, reached_ten_at",
        )
        .eq("status", "racing");

      if (!data) return [];

      return data
        // A racer with no `activated_at` is not racing in any meaningful
        // sense — nothing can be counted against a window that does not exist.
        .filter((row) => row.activated_at !== null)
        .map((row) => ({
          id: row.id,
          activatedAt: new Date(row.activated_at as string),
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
