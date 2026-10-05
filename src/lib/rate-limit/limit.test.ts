import assert from "node:assert/strict";
import { test } from "node:test";

import { RULES, decide, windowStart, type RateLimitRule } from "./limit.ts";

/**
 * The window arithmetic and the decision.
 *
 * Both call sites depend on these agreeing about where a window begins, and a
 * disagreement is not a subtle bug: it means two attempts land in different rows
 * and the limit silently doubles. So the boundary cases are tested rather than
 * assumed.
 */

const HOUR = 60 * 60 * 1000;
const rule: RateLimitRule = RULES.stripeKeyVerify;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test("a window starts at a multiple of its own length", () => {
  const start = windowStart(new Date("2026-10-05T13:47:33.412Z"), HOUR);
  assert.equal(start.toISOString(), "2026-10-05T13:00:00.000Z");
});

test("every instant in one window maps to the same start", () => {
  // The property the unique constraint relies on. If two instants in the same
  // hour produced different starts, they would be two rows and two limits.
  const first = windowStart(new Date("2026-10-05T13:00:00.000Z"), HOUR);
  const middle = windowStart(new Date("2026-10-05T13:30:00.000Z"), HOUR);
  const last = windowStart(new Date("2026-10-05T13:59:59.999Z"), HOUR);

  assert.equal(first.toISOString(), middle.toISOString());
  assert.equal(middle.toISOString(), last.toISOString());
});

test("the next hour is a different window", () => {
  const before = windowStart(new Date("2026-10-05T13:59:59.999Z"), HOUR);
  const after = windowStart(new Date("2026-10-05T14:00:00.000Z"), HOUR);
  assert.notEqual(before.toISOString(), after.toISOString());
});

test("the window is absolute, not relative to the first attempt", () => {
  // 13:37 computed by a process that never saw 13:00 must land on the same
  // boundary. This is what lets two serverless instances agree.
  const a = windowStart(new Date("2026-10-05T13:37:00.000Z"), HOUR);
  const b = windowStart(new Date("2026-10-05T13:37:00.000Z"), HOUR);
  assert.equal(a.toISOString(), b.toISOString());
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("attempts below the limit are allowed, and the last one is", () => {
  const now = new Date("2026-10-05T13:10:00.000Z");
  const window = windowStart(now, HOUR);

  for (let attempts = 0; attempts < rule.limit; attempts += 1) {
    const decision = decide(attempts, rule, window, now);
    assert.equal(decision.allowed, true, `attempt ${attempts + 1} should be allowed`);
  }
});

test("the attempt after the limit is refused", () => {
  const now = new Date("2026-10-05T13:10:00.000Z");
  const decision = decide(rule.limit, rule, windowStart(now, HOUR), now);

  assert.equal(decision.allowed, false);
});

test("remaining counts down and reaches zero on the last allowed attempt", () => {
  const now = new Date("2026-10-05T13:10:00.000Z");
  const window = windowStart(now, HOUR);

  const first = decide(0, rule, window, now);
  const last = decide(rule.limit - 1, rule, window, now);

  if (first.allowed) assert.equal(first.remaining, rule.limit - 1);
  if (last.allowed) assert.equal(last.remaining, 0);
});

test("a refusal says how long the wait actually is, not a whole window", () => {
  // Somebody who tries at minute 59 is told to wait a minute, not an hour. The
  // clock would contradict the longer answer almost immediately, and a message
  // the user can watch turn out to be wrong is worse than no message.
  const window = new Date("2026-10-05T13:00:00.000Z");
  const late = new Date("2026-10-05T13:59:00.000Z");

  const decision = decide(rule.limit, rule, window, late);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.retryAfterMs, 60_000);
});

test("a refusal never reports a negative wait", () => {
  // The window has already elapsed — which happens when the clock moves or when
  // a caller passes a window older than `now`. Zero is the honest floor.
  const window = new Date("2026-10-05T13:00:00.000Z");
  const after = new Date("2026-10-05T15:00:00.000Z");

  const decision = decide(rule.limit, rule, window, after);
  if (!decision.allowed) assert.equal(decision.retryAfterMs, 0);
});

test("a limit of zero refuses everything", () => {
  // Not a configuration anybody wants, but it is the boundary, and a limiter
  // that lets one through at zero is a limiter with an off-by-one at its most
  // dangerous end.
  const zero: RateLimitRule = { bucket: "test", limit: 0, windowMs: HOUR };
  const now = new Date("2026-10-05T13:10:00.000Z");

  assert.equal(decide(0, zero, windowStart(now, HOUR), now).allowed, false);
});

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

test("the two rules are the limits the spec names", () => {
  assert.equal(RULES.stripeKeyVerify.limit, 5);
  assert.equal(RULES.stripeKeyVerify.windowMs, HOUR);
  assert.equal(RULES.waitlistSignup.limit, 5);
  assert.equal(RULES.waitlistSignup.windowMs, HOUR);
});

test("every bucket name fits the column's shape", () => {
  // `rate_limit_counter_bucket_shape` is `^[a-z_]{3,40}$`. A name that fails it
  // is a write that throws at runtime rather than at review time.
  for (const [name, config] of Object.entries(RULES)) {
    assert.match(config.bucket, /^[a-z_]{3,40}$/, `${name} has an invalid bucket name`);
  }
});

test("no two rules share a bucket", () => {
  // Sharing one would mean the two operations limited each other.
  const buckets = Object.values(RULES).map((r) => r.bucket);
  assert.equal(new Set(buckets).size, buckets.length);
});
