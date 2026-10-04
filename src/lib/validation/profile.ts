import { z } from "zod";

// Relative with an explicit extension: Node's native type-stripping, which runs
// the tests, does not resolve the `@/` alias.
import { RACER_NAME_MAX, normaliseXHandle } from "./racer.ts";

/**
 * Validation for the fields a founder supplies themselves.
 *
 * `01` §7 orders `/join` as identity, then only the fields the provider did not
 * supply, then the provider connection, then eligibility. This module is the
 * second step: Google gives us a name and usually an address, X gives us a
 * handle, and whatever is still missing is asked for here.
 *
 * ## Why only two fields are required
 *
 * The same rule as `missingProfileFields` in `src/lib/auth/identity.ts`. An
 * address to reach them at, and the handle that identifies them on the board.
 * The name is cosmetic — a founder with no name is a blank cell, while one with
 * no handle has no public identity at all.
 *
 * ## Why the handle is normalised rather than merely checked
 *
 * `normaliseXHandle` is the same function the OAuth callback runs a provider's
 * handle through. Typed input and provider input are held to one rule, so a
 * handle cannot be valid by one path and invalid by the other.
 */

export const PROFILE_EMAIL_MAX = 254;

/**
 * Every field is coerced to a string before the schema sees it.
 *
 * `FormData.get` returns `null` for an absent field, a `File` for a file input,
 * and a string otherwise — and Zod treats an `undefined` property as *absent*
 * rather than as input, so a schema written on `z.string()` reports
 * "expected string, received undefined" for a field somebody simply left blank.
 * That is accurate and useless: it is the message a founder would read.
 *
 * Coercing first means the real rules always run, and a blank field fails the
 * check written for it rather than a type error.
 */
const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export const profileSchema = z.preprocess(
  (raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    return {
      name: asText(input.name),
      xHandle: asText(input.xHandle),
      email: asText(input.email),
    };
  },
  z.object({
    /**
     * Optional. Absent and empty mean the same thing: leave it as it is.
     *
     * Becomes `null` so the caller has one value to reason about rather than two
     * spellings of "nothing".
     */
    name: z
      .string()
      .refine(
        (value) => value.length <= RACER_NAME_MAX,
        `Keep your name under ${RACER_NAME_MAX} characters.`,
      )
      .transform((value) => (value.length > 0 ? value : null)),

    xHandle: z
      .string()
      .transform((value) => normaliseXHandle(value))
      .refine(
        (value): value is string => value !== null,
        "Add your X handle. It's how you appear on the board.",
      ),

    email: z
      .string()
      .transform((value) => value.toLowerCase())
      .pipe(z.email({ message: "Enter an email address we can reach you at." }))
      .refine(
        (value) => value.length <= PROFILE_EMAIL_MAX,
        "That email address is too long.",
      ),
  }),
);

export type ProfileInput = z.infer<typeof profileSchema>;
