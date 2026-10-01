import "server-only";

import {
  placeHold,
  type HoldOutcome,
  type HoldRequest,
  type HoldStore,
  type NewHold,
} from "@/lib/sponsors/hold";

/**
 * The Supabase-backed store for placing a hold.
 *
 * This file is the only part of the hold mechanism that knows about the
 * database, and it is `server-only`: the browser never touches `sponsorship`.
 * `anon` holds a SELECT grant on that table — Realtime requires it, and the
 * policy restricts it to `confirmed` rows — but no INSERT, so a direct client
 * write is impossible by construction rather than by policy.
 *
 * Everything interesting — the ordering, the failure mapping, the price lookup
 * — lives in `src/lib/sponsors/hold.ts`, which is pure and tested against a
 * fake. What is left here is translation.
 */

/**
 * Service role, deliberately.
 *
 * A sponsor is not an account; there is no session to attribute the write to,
 * and the row must exist before any payment identifies who is paying. That
 * means the write cannot be authorised by RLS and has to bypass it. The
 * compensating control is that this module accepts only the shapes in
 * `hold.ts` — there is no path here that takes arbitrary columns from a caller.
 */
async function supabaseHoldStore(): Promise<HoldStore> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const db = createAdminClient();

  return {
    async priceForTerm(termDays: number) {
      const { data, error } = await db
        .from("sponsor_pricing")
        .select("price_cents")
        .eq("term_days", termDays)
        .maybeSingle();

      if (error || !data) return null;

      const cents = Number(data.price_cents);
      return Number.isFinite(cents) && cents > 0 ? cents : null;
    },

    async findPosition(slotNumber: number) {
      const { data, error } = await db
        .from("sponsor_slot")
        .select("id")
        .eq("slot_number", slotNumber)
        .maybeSingle();

      if (error || !data) return null;
      return String(data.id);
    },

    async cancelStaleHolds(slotId: string, at: Date) {
      const { error } = await db
        .from("sponsorship")
        .update({ status: "cancelled" })
        .eq("slot_id", slotId)
        .eq("status", "pending")
        .lt("hold_expires_at", at.toISOString());

      // A failure here is not fatal to the caller — the insert that follows
      // re-checks everything through the exclusion constraint. But a silent
      // failure would look like "nobody was holding it", so it is raised and
      // mapped to a storage error rather than swallowed.
      if (error) throw new Error(error.message);
    },

    async insertHold(row: NewHold) {
      const { data, error } = await db
        .from("sponsorship")
        .insert({
          slot_id: row.slotId,
          status: "pending",
          term_days: row.termDays,
          starts_at: row.startsAt.toISOString(),
          ends_at: row.endsAt.toISOString(),
          hold_expires_at: row.holdExpiresAt.toISOString(),
          price_cents: row.priceCents,
          sponsor_name: row.sponsorName,
          sponsor_description: row.sponsorDescription,
          sponsor_logo_url: row.sponsorLogoUrl,
          sponsor_link: row.sponsorLink,
        })
        .select("id")
        .single();

      if (error) return { error: { code: error.code, message: error.message } };
      return { id: String(data.id) };
    },
  };
}

export async function createHold(request: HoldRequest): Promise<HoldOutcome> {
  try {
    return await placeHold(await supabaseHoldStore(), request);
  } catch (error) {
    // Nothing from the store escapes as a thrown error to the caller. The
    // sponsor sees one honest sentence; the detail goes to the server log.
    console.error("[sponsorship] hold failed", error);
    return {
      ok: false,
      reason: "storage-error",
      message: "We could not hold that position. Try again in a moment.",
    };
  }
}
