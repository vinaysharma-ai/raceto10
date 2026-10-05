import { z } from "zod";

// Relative with an explicit extension: Node's native type-stripping, which runs
// the tests, does not resolve the `@/` alias.
import { RACER_NAME_MAX } from "./racer.ts";

/**
 * Validation for the profile step.
 *
 * ## What is asked for, and why each thing is here
 *
 * The product name and the consent are the two things the product cannot work
 * without: the first is what the board shows next to the founder, and the second
 * is what makes showing any of it legitimate. The display name is prefilled from
 * the provider and optional; the email is required only because some providers
 * (X, often) do not supply one.
 *
 * ## The X handle is no longer collected
 *
 * It used to be, with a message explaining it was how you appear on the board.
 * But a typed handle is a claim, not a proof: anybody could enter `@naval` and
 * the board would link it. The handle now comes only from an X sign-in, which is
 * the one path that proves the account. A Google-only founder appears under
 * their display name and has no X link, which is the honest rendering rather
 * than an unverified one.
 *
 * ## Consent is a checkbox that has to be ticked
 *
 * `z.literal("yes")` rather than a truthy coercion. An absent checkbox is the
 * string "no" or missing entirely, and both must fail with a sentence about
 * consent rather than a type error.
 */

export const PROFILE_EMAIL_MAX = 254;
export const PRODUCT_NAME_MIN = 2;
export const PRODUCT_NAME_MAX = 60;

/**
 * Every field is coerced to a string before the schema sees it.
 *
 * `FormData.get` returns `null` for an absent field, a `File` for a file input,
 * and a string otherwise — and Zod treats an `undefined` property as *absent*
 * rather than as input, so a schema written on `z.string()` reports
 * "expected string, received undefined" for a field somebody simply left blank.
 * That is accurate and useless: it is the message a founder would read.
 */
const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export const profileSchema = z.preprocess(
  (raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    return {
      name: asText(input.name),
      productName: asText(input.productName),
      email: asText(input.email),
      consent: asText(input.consent),
    };
  },
  z.object({
    /**
     * Optional, prefilled from the provider. Absent and empty mean the same
     * thing: leave whatever is there.
     */
    name: z
      .string()
      .refine(
        (value) => value.length <= RACER_NAME_MAX,
        `Keep your name under ${RACER_NAME_MAX} characters.`,
      )
      .transform((value) => (value.length > 0 ? value : null)),

    productName: z
      .string()
      .refine(
        (value) => value.length >= PRODUCT_NAME_MIN,
        "Add the name of the product you are racing.",
      )
      .refine(
        (value) => value.length <= PRODUCT_NAME_MAX,
        `Keep the product name under ${PRODUCT_NAME_MAX} characters.`,
      ),

    email: z
      .string()
      .transform((value) => value.toLowerCase())
      .pipe(z.email({ message: "Enter an email address we can reach you at." }))
      .refine(
        (value) => value.length <= PROFILE_EMAIL_MAX,
        "That email address is too long.",
      ),

    // The one checkbox. Everything it covers is listed next to it on the form,
    // so this is the literal agreement rather than a link to a policy.
    consent: z.literal("yes", {
      message: "Tick the box to race in public. Nothing is shown without it.",
    }),
  }),
);

export type ProfileInput = z.infer<typeof profileSchema>;
