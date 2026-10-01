import { z } from "zod";

/**
 * Validation for the landing page's waitlist capture.
 *
 * Server-side first. The form mirrors these rules for helpfulness, but the
 * server is the boundary — client validation is a convenience and never a
 * guard.
 */

/** Matches the `customer_band` enum in the database exactly. */
export const CUSTOMER_BANDS = ["0", "1-5", "6+"] as const;

export const waitlistSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: "Enter an email address we can reach you at." }))
    .refine((value) => value.length <= 254, "That email address is too long."),

  customersNow: z.enum(CUSTOMER_BANDS, {
    message: "Pick the option that matches where you are today.",
  }),
});

export type WaitlistInput = z.infer<typeof waitlistSchema>;

/**
 * The honeypot. A field a human never sees and a naive bot fills in.
 *
 * Returning "accepted" rather than an error is deliberate: telling a bot it was
 * detected just teaches whoever wrote it to stop filling this field.
 */
export const HONEYPOT_FIELD = "company";
