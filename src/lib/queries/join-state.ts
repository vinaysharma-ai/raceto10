import "server-only";

import { getCurrentProfile, type ProfileRow } from "@/lib/auth/profile";
import { getRaceDuration } from "@/lib/race/config";
import type { IneligibleReason } from "@/lib/verification/eligibility.ts";

/**
 * Where a founder is in the entry flow.
 *
 * Resolved on the server as **one value** rather than assembled from several
 * independent reads in the page. The distinction matters: the stages are
 * mutually exclusive, and a page fetching `profile`, `connection` and `verdict`
 * separately could render a combination that is not a real state — "eligible"
 * beside no connection, say. One function, one exhaustive switch.
 *
 * ## What this deliberately never returns
 *
 * No credential, and no raw provider identifier. The account id exists in the
 * database and the racer can see it in their own Stripe dashboard, but the join
 * page has no reason to print it, and a page that renders whatever it is handed
 * is one refactor away from rendering something it should not.
 */

export type JoinConnection = {
  /** The connection row's id, used to decide which panel to show. */
  id: string;
  status: string;
};

export type JoinRace = {
  status: string;
  activatedAt: Date;
  raceEndAt: Date;
  /** The verified count captured at activation. */
  baselineCustomerCount: number;
  /** The live count, refreshed by reconciliation. */
  currentCustomerCount: number;
  countReconciledAt: Date | null;
};

export type JoinState =
  | { stage: "signed-out" }
  | { stage: "profile-incomplete"; profile: ProfileRow }
  | { stage: "no-connection"; profile: ProfileRow }
  | { stage: "connection-unhealthy"; profile: ProfileRow; connection: JoinConnection }
  | { stage: "unverified"; profile: ProfileRow; connection: JoinConnection }
  | { stage: "ineligible"; profile: ProfileRow; connection: JoinConnection; reason: IneligibleReason }
  | { stage: "eligible"; profile: ProfileRow; connection: JoinConnection }
  | { stage: "racing"; profile: ProfileRow; connection: JoinConnection | null; race: JoinRace }
  | { stage: "finished"; profile: ProfileRow; connection: JoinConnection | null; race: JoinRace }
  | { stage: "withdrawn"; profile: ProfileRow; race: JoinRace };

export type JoinView = { state: JoinState; durationDays: number | null };

export async function getJoinState(): Promise<JoinView> {
  const [profile, durationDays] = await Promise.all([getCurrentProfile(), getRaceDuration()]);

  if (!profile) return { state: { stage: "signed-out" }, durationDays };

  // An incomplete profile has no racer row — the racer is created at activation
  // — so there is nothing further to read and no point trying.
  if (!profile.x_handle || !profile.email) {
    return { state: { stage: "profile-incomplete", profile }, durationDays };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const db = createAdminClient();

  const { data: racer } = await db
    .from("racer")
    .select(
      "id, status, activated_at, race_end_at, baseline_customer_count, current_customer_count, count_reconciled_at",
    )
    .eq("profile_id", profile.id)
    .maybeSingle();

  // A racer row is created at activation, so a founder who has never started
  // has none — and with no racer there is nothing to connect and no verdict to
  // look for. Returned here rather than below so the rest of this function has
  // a non-null racer to work with.
  if (!racer) return { state: { stage: "no-connection", profile }, durationDays };

  // The connection is keyed by `racer_id`, not by profile, so it can only be
  // read once the racer row is known.
  const { data: connection } = await db
    .from("provider_connections")
    .select("id, connection_status")
    .eq("racer_id", racer.id)
    .eq("provider", "stripe")
    .maybeSingle();

  const conn: JoinConnection | null = connection
    ? { id: connection.id, status: connection.connection_status }
    : null;

  // --- Already racing, or done -------------------------------------------
  //
  // Checked before the connection, because a racer whose key has since died is
  // still racing: the count is frozen at its last reconcile and the clock keeps
  // running. Showing them "reconnect" as the primary state would be wrong.
  if (racer.activated_at && racer.race_end_at) {
    const race: JoinRace = {
      status: racer.status,
      activatedAt: new Date(racer.activated_at),
      raceEndAt: new Date(racer.race_end_at),
      baselineCustomerCount: racer.baseline_customer_count ?? 0,
      currentCustomerCount: racer.current_customer_count ?? 0,
      countReconciledAt: racer.count_reconciled_at ? new Date(racer.count_reconciled_at) : null,
    };

    if (racer.status === "finished") {
      return { state: { stage: "finished", profile, connection: conn, race }, durationDays };
    }
    if (racer.status === "withdrawn" || racer.status === "disqualified") {
      return { state: { stage: "withdrawn", profile, race }, durationDays };
    }
    return { state: { stage: "racing", profile, connection: conn, race }, durationDays };
  }

  if (!conn) return { state: { stage: "no-connection", profile }, durationDays };

  if (conn.status !== "connected") {
    return { state: { stage: "connection-unhealthy", profile, connection: conn }, durationDays };
  }

  // --- The registration verdict ------------------------------------------
  //
  // The same newest-registration row `activateRacer` requires, read here so the
  // page can show the founder the verdict *before* they press start rather than
  // letting them press it and be refused.
  const { data: snapshot } = await db
    .from("verification_snapshots")
    .select("verification_status, customer_count, mrr_minor")
    .eq("racer_id", racer.id)
    .eq("source", "registration")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const verdict = snapshot?.verification_status;

  if (verdict === "eligible") {
    return { state: { stage: "eligible", profile, connection: conn }, durationDays };
  }

  if (verdict === "ineligible") {
    // Derived from the snapshot rather than stored: the reason is not a column,
    // and a message that says "you have customers" to someone whose actual
    // problem is unreadable MRR would send them to fix the wrong thing.
    const reason: IneligibleReason =
      (snapshot?.customer_count ?? 0) > 0 ? "has_customers" : "has_mrr";

    return { state: { stage: "ineligible", profile, connection: conn, reason }, durationDays };
  }

  // No verdict, or one that failed. Distinct from ineligible because the fix
  // differs: this is "let us look again", not "your account doesn't qualify".
  return { state: { stage: "unverified", profile, connection: conn }, durationDays };
}
