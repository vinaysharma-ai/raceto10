import { z } from "zod";

/**
 * Shape validation for a submitted Stripe key.
 *
 * ## What this is, and what it is not
 *
 * This is *not* the security check. Whether a key is real, live, read-only and
 * permitted to read what we need is decided by Stripe, and nothing here
 * substitutes for that. What this does is reject input that cannot possibly be
 * a Stripe key before it is sent anywhere — so a typo, a paste of the wrong
 * field, or an empty submission costs one round trip to our own server rather
 * than one to Stripe.
 *
 * ## Why the prefix is checked here as well as in the adapter
 *
 * The adapter refuses a non-restricted key because that is a *product* rule —
 * this flow is read-only, so a full-access key is the wrong thing to accept.
 * Checking the prefix here means the racer is told immediately, with a message
 * about what to create, rather than after a network call.
 *
 * ## Why the value is never echoed back
 *
 * The error messages deliberately do not include what was submitted. A
 * validation error is one of the easiest places for a secret to end up in a log
 * line or a rendered form.
 */

/** Stripe restricted keys: `rk_live_…` or `rk_test_…`, 32+ chars of body. */
const RESTRICTED_KEY = /^rk_(live|test)_[A-Za-z0-9]{16,}$/;

/** A full-access key, matched so the refusal can name the actual mistake. */
const FULL_ACCESS_KEY = /^sk_(live|test)_[A-Za-z0-9]{16,}$/;

export const STRIPE_KEY_MAX = 200;

export const stripeKeySchema = z.preprocess(
  (raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    return {
      apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : "",
    };
  },
  z.object({
    apiKey: z
      .string()
      .min(1, "Paste your restricted Stripe key.")
      .max(STRIPE_KEY_MAX, "That is longer than a Stripe key.")
      .refine(
        (value) => !FULL_ACCESS_KEY.test(value),
        "That is a full-access key. Create a restricted key with read-only permissions instead. RaceTo10 never needs to write to your account.",
      )
      .refine(
        (value) => RESTRICTED_KEY.test(value),
        "That doesn't look like a restricted Stripe key. They start with rk_live_ or rk_test_.",
      ),
  }),
);

export type StripeKeyInput = z.infer<typeof stripeKeySchema>;
