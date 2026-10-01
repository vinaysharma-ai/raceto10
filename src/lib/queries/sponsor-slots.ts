import { cache } from "react";

import type { LiveSponsorship, SlotPlacement, SlotState, TermPrice } from "@/lib/sponsors/board";

/**
 * Reading the sponsor board.
 *
 * Everything pure — the shapes, the price formatting, the safety guards — lives
 * in `src/lib/sponsors/board.ts`. It is separated because the `/sponsor` grid is
 * a client component and this module is not safe to bundle for the browser: it
 * imports `react.cache` and, through `getSponsorBoard`, the server Supabase
 * client.
 */

export type SponsorBoard =
  | { ok: true; slots: SlotState[]; pricing: TermPrice[] }
  /** The board could not be read. Distinct from "everything is free". */
  | { ok: false; reason: string };

/**
 * The slice of a Supabase client this module needs.
 *
 * Deliberately loose — `Record<string, unknown>[]` rather than a typed row — so
 * a fake can satisfy it and so this file does not depend on generated database
 * types. The narrowing to our own shapes happens in one place below, against a
 * schema this repository owns.
 */
export type BoardReader = {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        options: { ascending: boolean },
      ): PromiseLike<{
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      }>;
    };
  };
};

export async function readSponsorBoard(reader: BoardReader): Promise<SponsorBoard> {
  try {
    const [positions, live, pricing] = await Promise.all([
      reader
        // The public view, not the table. `sponsor_slot` has never had a grant
        // for `anon`, so reading it directly failed for every visitor — and it
        // failed in a way that looked like "no sponsors yet" rather than like a
        // permission error.
        .from("public_sponsor_slots")
        .select("slot_number, placement")
        .order("slot_number", { ascending: true }),
      reader
        .from("sponsorship_live")
        .select(
          "id, slot_id, slot_number, sponsor_name, sponsor_description, sponsor_logo_url, sponsor_link, ends_at",
        )
        .order("slot_number", { ascending: true }),
      reader
        .from("sponsor_pricing")
        .select("term_days, price_cents")
        .order("term_days", { ascending: true }),
    ]);

    const firstError = positions.error ?? live.error ?? pricing.error;
    if (firstError) return { ok: false, reason: firstError.message };
    if (!positions.data || !live.data || !pricing.data) {
      return { ok: false, reason: "the sponsor board returned no rows" };
    }

    // Keyed by slot number rather than by the internal id, because the public
    // view does not expose one — and `sponsorship_live` already carries the
    // number, so the join needs nothing else. A booking for a position that no
    // longer exists simply never matches, and is dropped rather than
    // misattached to a neighbour.
    const occupiedBySlot = new Map<number, LiveSponsorship>();
    for (const row of live.data) {
      occupiedBySlot.set(Number(row.slot_number), row as unknown as LiveSponsorship);
    }

    const slots: SlotState[] = positions.data.map((row) => ({
      slot_number: Number(row.slot_number),
      placement: row.placement as SlotPlacement,
      occupiedBy: occupiedBySlot.get(Number(row.slot_number)) ?? null,
    }));

    return {
      ok: true,
      slots,
      pricing: pricing.data as unknown as TermPrice[],
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** One read per request, shared by both rails, both bars, and the grid. */
export const getSponsorBoard = cache(async (): Promise<SponsorBoard> => {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    return await readSponsorBoard(await createClient());
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
});
