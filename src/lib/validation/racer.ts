import { z } from "zod";

/**
 * Validation for race entry.
 *
 * Four fields. `name`, `product_name` and `x_handle` all appear on the public
 * leaderboard; `email` never leaves the database and is the only unique column
 * on `racer`. The form says which is which next to each field, because a form
 * that asks for something private-looking and publishes it is the kind of thing
 * people are right to be suspicious of.
 */

export const RACER_NAME_MAX = 60;
export const RACER_PRODUCT_MAX = 60;
/** X's own limit on a handle, in characters. */
export const RACER_X_HANDLE_MAX = 15;

/**
 * X handles, normalised from whatever someone pastes.
 *
 * People paste all four of these forms, and all four mean the same account.
 * Accepting only one would reject three quarters of people who clearly
 * answered the question.
 */
export function normaliseXHandle(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // The scheme is optional, because people paste `x.com/ada` as readily as the
  // full URL, and both mean the same account.
  value = value.replace(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com/i, "");

  // A leading slash or @ is decoration.
  value = value.replace(/^[/@]+/, "");

  // A query or fragment is not part of who someone is.
  value = value.split(/[?#]/)[0];

  // A trailing slash is.
  value = value.replace(/\/+$/, "");

  // Whatever is left must be ONE path segment. `x.com/a/b` links to something
  // that is not a profile, and taking its first segment would quietly store a
  // different handle than the one that was pasted — a valid-looking value
  // produced from an invalid input, which is worse than refusing it.
  if (value.includes("/")) return null;

  if (!/^[A-Za-z0-9_]{1,15}$/.test(value)) return null;

  return value;
}

export const racerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Add your name.")
    .max(RACER_NAME_MAX, `Keep your name under ${RACER_NAME_MAX} characters.`),

  productName: z
    .string()
    .trim()
    .min(1, "Add the product you're racing with.")
    .max(RACER_PRODUCT_MAX, `Keep the product name under ${RACER_PRODUCT_MAX} characters.`),

  /**
   * Required, and the entry's public identity.
   *
   * It was optional while there was also a separate `handle` field. The field
   * list is now name, product, X handle, email — so the X handle is the only
   * public identifier an entry has, and it is the first column of the
   * leaderboard. Making the identity column optional would mean rows with no
   * way to tell who they are.
   *
   * This also feeds `racer.handle`, which stays the canonical race identifier:
   * see the note on `RacerInput` in `src/lib/queries/racer.ts` for why the two
   * columns exist and are allowed to diverge later.
   */
  xHandle: z
    .string()
    .trim()
    .transform((value) => normaliseXHandle(value))
    .refine(
      (value): value is string => value !== null,
      "Add your X handle. It's how you appear on the board.",
    ),

  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: "Enter an email address we can reach you at." }))
    .refine((value) => value.length <= 254, "That email address is too long."),
});

export type RacerInput = z.infer<typeof racerSchema>;

/**
 * The honeypot, same shape as the waitlist's. A raid of bot signups on an open
 * form is not a hypothetical.
 */
export const HONEYPOT_FIELD = "company_website";
