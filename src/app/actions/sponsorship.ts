"use server";

import { createHold } from "@/lib/queries/sponsorship";
import { sponsorshipHoldSchema } from "@/lib/validation/sponsorship";

/**
 * Holding a sponsor position.
 *
 * ## This step takes no money, and says so
 *
 * The action creates a real reservation — a `pending` sponsorship row with a
 * 30-minute window — and stops there. Checkout is a later step. Nothing here
 * claims otherwise, and the caller renders the reservation as a reservation
 * rather than as a purchase. A confirmation screen that implied payment had
 * happened would be the single worst thing this file could do.
 *
 * ## Fail loudly server-side, vaguely client-side
 *
 * Every outcome is a typed result. The sponsor gets one sentence they can act
 * on — "someone is buying that position right now" — and never a database
 * error, a constraint name, or a stack trace. Throwing is reserved for genuine
 * bugs, which is why there is no `try`/`catch` here: `createHold` already maps
 * storage failures to a result.
 *
 * A `"use server"` module may only export async functions, so the initial state
 * lives with the component that uses it.
 */

export type HoldState =
  | { status: "idle" }
  | {
      status: "held";
      slotNumber: number;
      termDays: number;
      priceCents: number;
      /** ISO. When the reservation lapses if checkout is not started. */
      holdExpiresAt: string;
    }
  | { status: "error"; message: string };

export async function startSponsorshipHold(
  _previous: HoldState,
  formData: FormData,
): Promise<HoldState> {
  const parsed = sponsorshipHoldSchema.safeParse({
    slotNumber: formData.get("slotNumber"),
    termDays: formData.get("termDays"),
    sponsorName: formData.get("sponsorName"),
    sponsorDescription: formData.get("sponsorDescription"),
    sponsorLink: formData.get("sponsorLink"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };
  }

  const result = await createHold(parsed.data);

  if (!result.ok) {
    return { status: "error", message: result.message };
  }

  return {
    status: "held",
    slotNumber: result.slotNumber,
    termDays: result.termDays,
    priceCents: result.priceCents,
    holdExpiresAt: result.holdExpiresAt,
  };
}
