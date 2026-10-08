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
  /**
   * The last four characters of the key, or null.
   *
   * Not the key, and not derivable into one. It exists so a founder can tell
   * which of their Stripe keys this connection is using, which is otherwise
   * unanswerable — the key itself is sealed and never read back.
   */
  keyLast4: string | null;
};

export type JoinRace = {
  status: string;
  /**
   * The racer's public page, so a founder can share their own race — or null,
   * when the row has no slug.
   *
   * Not private data: it is the address of a page anybody can already read. It
   * is carried here rather than looked up again because the founder's own view
   * and the public page must agree on which race is being shared.
   *
   * Null is a real state, not a typing inconvenience. Sharing is offered only
   * when there is something to share; a link to `/r/null` would be worse than
   * no link at all.
   */
  publicSlug: string | null;
  /** The product being raced, so a share names it rather than the founder. */
  productName: string | null;
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

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const db = createAdminClient();

  const { data: racer } = await db
    .from("racer")
    .select(
      "id, status, public_slug, product_name, activated_at, race_end_at, baseline_customer_count, current_customer_count, count_reconciled_at",
    )
    .eq("profile_id", profile.id)
    .maybeSingle();

  // The racer row is the record that the profile step was finished — it is
  // created by that step, carrying the product name and the consent. So its
  // absence *is* the "we still need your details" state, and an email or handle
  // being missing is not a second way to be incomplete.
  //
  // This used to test `profile.x_handle`, which made an X handle mandatory and
  // left Google-only founders unable to proceed at all. The handle is now
  // optional by design.
  if (!racer || !racer.product_name) {
    return { state: { stage: "profile-incomplete", profile }, durationDays };
  }

  // The connection is keyed by `racer_id`, not by profile, so it can only be
  // read once the racer row is known.
  const { data: connection } = await db
    .from("provider_connections")
    .select("id, connection_status, key_last4")
    .eq("racer_id", racer.id)
    .eq("provider", "stripe")
    .maybeSingle();

  const conn: JoinConnection | null = connection
    ? {
        id: connection.id,
        status: connection.connection_status,
        keyLast4: connection.key_last4,
      }
    : null;

  // --- Already racing, or done -------------------------------------------
  //
  // Checked before the connection, because a racer whose key has since died is
  // still racing: the count is frozen at its last reconcile and the clock keeps
  // running. Showing them "reconnect" as the primary state would be wrong.
  if (racer.activated_at && racer.race_end_at) {
    const race: JoinRace = {
      status: racer.status,
      publicSlug: racer.public_slug,
      productName: racer.product_name,
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
