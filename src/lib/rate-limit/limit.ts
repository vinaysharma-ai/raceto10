/**
 * Fixed-window rate limiting: the arithmetic, with no storage in sight.
 *
 * ## Why fixed windows
 *
 * A sliding window is more precise and needs per-attempt timestamps. This needs
 * to bound how often somebody can make us call Stripe with a key they chose, and
 * a fixed window does that with one integer per subject. The cost is the
 * boundary: ten attempts can straddle two windows. At these limits that is a
 * curiosity, not a hole.
 *
 * ## Why the window is derived, not stored per request
 *
 * `windowStart` floors the current instant to a multiple of the window. Two
 * processes an hour apart compute the same key without coordinating, and the
 * unique constraint on `(bucket, subject, window_start)` is what makes the row
 * single. A counter keyed on "when this subject first tried" would need a read
 * before it could be written.
 *
 * ## Why this file has no database in it
 *
 * The rules are the part worth testing and the part that must not differ between
 * buckets. Storage lives in `src/lib/queries/rate-limit.ts`.
 */

export type RateLimitRule = {
  /** What is being limited. Matches the `rate_limit_counter.bucket` shape. */
  bucket: string;
  /** How many attempts are allowed inside one window. */
  limit: number;
  /** The window length in milliseconds. */
  windowMs: number;
};

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

/** The five things Phase 4 and Phase 9 limit. */
export const RULES = {
  /** Five key checks per user per hour. Each one makes us call Stripe. */
  stripeKeyVerify: {
    bucket: "stripe_key_verify",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  },
  /** Five waitlist submissions per IP per hour. */
  waitlistSignup: {
    bucket: "waitlist_signup",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  },
  /**
   * Twenty sign-in starts per IP per hour.
   *
   * The loosest of the three, and deliberately so. Starting a sign-in is not
   * expensive — no third-party call, no key, no write — and it is the step a
   * real person repeats when they mistype a password, pick the wrong account, or
   * come back on a second device. The bucket exists to bound a script that
   * drives the OAuth provider, not to ration a human.
   */
  signinStart: {
    bucket: "signin_start",
    limit: 20,
    windowMs: 60 * 60 * 1000,
  },
} as const satisfies Record<string, RateLimitRule>;

export type RuleName = keyof typeof RULES;

/**
 * The start of the window containing `now`.
 *
 * Floored to a multiple of the window from the epoch, so the boundaries are
 * absolute rather than relative to the first attempt — which is what lets two
 * processes agree without talking to each other.
 */
export function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Whether this attempt is allowed, given how many have already been counted.
 *
 * `attempts` is the count *before* this one. The limit is inclusive: with a
 * limit of 5, attempts 0 through 4 are allowed and the sixth is refused.
 */
export function decide(
  attempts: number,
  rule: RateLimitRule,
  startedAt: Date,
  now: Date,
): RateLimitDecision {
  if (attempts < rule.limit) {
    return { allowed: true, remaining: rule.limit - attempts - 1 };
  }

  // When the current window ends, not when this subject must wait a full window.
  // The difference is real to somebody who tried at minute 59: telling them to
  // wait an hour when the counter resets in sixty seconds is a lie the clock
  // contradicts almost immediately.
  const endsAt = startedAt.getTime() + rule.windowMs;
  return { allowed: false, retryAfterMs: Math.max(0, endsAt - now.getTime()) };
}
