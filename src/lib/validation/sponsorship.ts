import { z } from "zod";

import {
  SPONSOR_DESCRIPTION_MAX,
  SPONSOR_NAME_MAX,
  SPONSOR_POSITION_NUMBERS,
  SPONSOR_TERMS,
} from "../sponsors/limits.ts";
import { safeExternalUrl } from "../sponsors/urls.ts";

/**
 * Validation for buying a sponsor position.
 *
 * Server-side first, like the waitlist. The modal mirrors these rules for
 * helpfulness — a live character counter, a disabled submit — but the server is
 * the boundary, and client validation is a convenience rather than a guard.
 *
 * Two rules here are deliberately **not** enforced by this file:
 *
 * - whether the position is actually free. That is settled by the exclusion
 *   constraint when the hold is inserted. A validation rule that drifted would
 *   otherwise let a double-sale through, and no check-then-write can be trusted
 *   against a concurrent writer anyway.
 * - the price. It is read from `sponsor_pricing` inside `placeHold`. The client
 *   never sends it and no price is written down in code or copy.
 */

// The terms, the position numbers and the length caps live in
// `src/lib/sponsors/limits.ts` so the modal can read them without bundling zod.

export const sponsorshipHoldSchema = z.object({
  slotNumber: z.coerce
    .number({ message: "Pick a position." })
    .int("Pick a position.")
    .refine(
      (value) => (SPONSOR_POSITION_NUMBERS as readonly number[]).includes(value),
      "Pick one of the ten positions.",
    ),

  termDays: z.coerce
    .number({ message: "Pick how long you want the position for." })
    .int("Pick how long you want the position for.")
    .refine(
      (value) => (SPONSOR_TERMS as readonly number[]).includes(value),
      "Terms are 1, 3 or 7 days.",
    ),

  sponsorName: z
    .string()
    .trim()
    .min(1, "Add the name you want shown on the card.")
    .max(SPONSOR_NAME_MAX, `Keep the name under ${SPONSOR_NAME_MAX} characters.`),

  sponsorDescription: z
    .string()
    .trim()
    .min(1, "Add a short line about what you do.")
    .max(
      SPONSOR_DESCRIPTION_MAX,
      `Keep the description to ${SPONSOR_DESCRIPTION_MAX} characters or fewer.`,
    ),

  // Checked for shape here so the sponsor gets a useful message; checked again
  // inside `placeHold`, because that is the function that writes it to a row.
  sponsorLink: z
    .string()
    .trim()
    .min(1, "Add the link your card should point to.")
    .refine(
      (value) => safeExternalUrl(value) !== null,
      "That needs to be a full web address, starting with https://",
    ),
});

export type SponsorshipHoldInput = z.infer<typeof sponsorshipHoldSchema>;
