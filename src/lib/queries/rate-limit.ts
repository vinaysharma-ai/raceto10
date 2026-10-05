import "server-only";

import { RULES, decide, windowStart, type RateLimitDecision, type RuleName } from "@/lib/rate-limit/limit.ts";

/**
 * The counter, against `rate_limit_counter`.
 *
 * ## Service role, and why that is not a shortcut
 *
 * The table is revoked from `anon` and `authenticated` and has RLS on with no
 * policy, so nothing but the service role can reach it. That is the point: a
 * rate limit a client can write is a rate limit a client can lift.
 *
 * ## The race, stated plainly
 *
 * PostgREST cannot express `attempts = attempts + 1`, so this reads the row,
 * decides, and writes the new value. Two attempts arriving together can both
 * read the same count and both be allowed, so the effective limit is
 * `limit + (concurrent attempts)`. Doing better needs a SQL function, which is a
 * schema change.
 *
 * That is an acceptable trade here and worth being explicit about: the bucket
 * exists to stop somebody making thousands of Stripe calls, and it does. It is
 * not a guarantee of exactly five.
 *
 * ## Failing closed
 *
 * `consume` returns `allowed: false` when the counter cannot be read. A limiter
 * that opens when its storage is broken is not a limiter, and the operation
 * behind it costs real money at Stripe. The cost of the conservative direction
 * is somebody being told to try again later during an outage, which is
 * recoverable; the cost of the other direction is unbounded.
 *
 * `consumeUnlimitedOnError` is the opposite choice, for the waitlist, where a
 * database problem should not be the reason a genuine signup is refused. Both
 * are here so the choice is visible at each call site rather than implied.
 */

type CounterRow = { attempts: number };

async function admin() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

/**
 * The current count for a subject in the window containing `now`.
 *
 * Returns null when it could not be read, which callers must treat as an error
 * rather than as zero.
 */
async function readCount(
  bucket: string,
  subject: string,
  window: Date,
): Promise<number | null> {
  try {
    const db = await admin();

    const { data, error } = await db
      .from("rate_limit_counter")
      .select("attempts")
      .eq("bucket", bucket)
      .eq("subject", subject)
      .eq("window_start", window.toISOString())
      .maybeSingle<CounterRow>();

    if (error) {
      console.error("[rate-limit] read failed", { bucket, code: error.code });
      return null;
    }

    return data?.attempts ?? 0;
  } catch {
    // Category only. The message could contain the subject, which for the
    // waitlist bucket is an IP address and for key verification is a user id.
    console.error("[rate-limit] read threw", { bucket });
    return null;
  }
}

/** Records one more attempt. Best-effort: a failure here does not fail the call. */
async function increment(
  bucket: string,
  subject: string,
  window: Date,
  next: number,
): Promise<void> {
  try {
    const db = await admin();

    const { error } = await db.from("rate_limit_counter").upsert(
      {
        bucket,
        subject,
        window_start: window.toISOString(),
        attempts: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bucket,subject,window_start" },
    );

    if (error) console.error("[rate-limit] write failed", { bucket, code: error.code });
  } catch {
    console.error("[rate-limit] write threw", { bucket });
  }
}

/**
 * Counts an attempt and says whether it is allowed.
 *
 * `failClosed: true` refuses when the counter is unreadable; `false` allows.
 * There is no default, deliberately — the caller has to have decided.
 */
export async function consume(
  ruleName: RuleName,
  subject: string,
  options: { failClosed: boolean; now?: Date },
): Promise<RateLimitDecision> {
  const rule = RULES[ruleName];
  const now = options.now ?? new Date();
  const window = windowStart(now, rule.windowMs);

  const attempts = await readCount(rule.bucket, subject, window);

  if (attempts === null) {
    if (options.failClosed) {
      // Told to wait, not told why: an outage on our side is not something the
      // person can act on, and "the counter is down" invites them to try to
      // work around it.
      return { allowed: false, retryAfterMs: rule.windowMs };
    }
    return { allowed: true, remaining: rule.limit };
  }

  const decision = decide(attempts, rule, window, now);

  // Counted whether or not it was allowed. A refused attempt still cost us the
  // read, and not counting it would let somebody sit at the limit forever.
  await increment(rule.bucket, subject, window, attempts + 1);

  return decision;
}

/**
 * A sentence to show somebody who has been limited.
 *
 * Rounded up to whole minutes, and never "0 minutes": a message that says to
 * wait nothing is worse than no message, because it invites an immediate retry
 * that will also fail.
 */
export function describeLimit(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return minutes === 1
    ? "That is as many times as you can try in an hour. Try again in a minute."
    : `That is as many times as you can try in an hour. Try again in ${minutes} minutes.`;
}
