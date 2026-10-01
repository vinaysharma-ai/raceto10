/**
 * The numbers the sponsor flow has to agree on.
 *
 * Split out from `src/lib/validation/sponsorship.ts` so the browser can read
 * them without pulling `zod` into the client bundle — the modal needs the
 * description cap for its live counter and the term list for its price table,
 * and neither is worth shipping a validator for.
 *
 * Each of these mirrors a rule in the database. Where a constraint exists, it is
 * named, because a drift between the two is a bug that only shows up as a
 * confusing storage error at the worst moment.
 */

/**
 * The terms on sale.
 * Mirrors `sponsorship_term_allowed` and `sponsor_pricing_term_allowed`.
 */
export const SPONSOR_TERMS = [1, 3, 7] as const;

export type SponsorTerm = (typeof SPONSOR_TERMS)[number];

/** Positions 1–10. Mirrors `sponsor_slot_number_range`. */
export const SPONSOR_POSITION_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Hard cap on the description. Mirrors `sponsorship_description_length`.
 *
 * The card clamps to two lines at 180px, so anything longer is silently cut off
 * on screen — refusing it is more honest than publishing a truncated sentence
 * the sponsor did not write.
 */
export const SPONSOR_DESCRIPTION_MAX = 60;

/**
 * Length cap for the company name. Not a database constraint — the name is
 * rendered with `truncate`, so an overlong one degrades on screen rather than
 * breaking anything. Capped here so a card cannot be overrun.
 */
export const SPONSOR_NAME_MAX = 60;

/** How a term is described in copy. `1` -> "1 day". */
export function describeTerm(termDays: number): string {
  return termDays === 1 ? "1 day" : `${termDays} days`;
}
