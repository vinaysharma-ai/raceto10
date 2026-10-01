import assert from "node:assert/strict";
import { test } from "node:test";

import { FAKE_FULL_ACCESS_KEY, FAKE_RESTRICTED_LIVE_KEY, FAKE_RESTRICTED_TEST_KEY, FAKE_TRUNCATED_KEY } from "../verification/test-fixtures.ts";

import { stripeKeySchema } from "./provider.ts";

/**
 * Shape validation for a submitted Stripe key.
 *
 * The tests that matter are the ones about what the error *says*. A validation
 * failure is one of the easiest places for a secret to end up in a log line or
 * a rendered form, so several of these assert the message does not contain the
 * submitted value.
 */

const VALID = FAKE_RESTRICTED_LIVE_KEY;

test("a restricted live key parses", () => {
  const result = stripeKeySchema.safeParse({ apiKey: VALID });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.apiKey, VALID);
});

test("a restricted test key parses", () => {
  const key = FAKE_RESTRICTED_TEST_KEY;
  assert.equal(stripeKeySchema.safeParse({ apiKey: key }).success, true);
});

test("surrounding whitespace is trimmed", () => {
  // Copying from Stripe's dashboard routinely brings a trailing newline.
  const result = stripeKeySchema.safeParse({ apiKey: `  ${VALID}\n` });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.apiKey, VALID);
});

test("a full-access key is refused by name, not as malformed", () => {
  // The racer made a specific, fixable mistake. Telling them "that doesn't look
  // like a key" would leave them pasting the same wrong thing again.
  const result = stripeKeySchema.safeParse({
    apiKey: FAKE_FULL_ACCESS_KEY,
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /restricted key/i);
    assert.match(result.error.issues[0]?.message ?? "", /read-only|read access/i);
  }
});

test("a publishable key is refused", () => {
  assert.equal(stripeKeySchema.safeParse({ apiKey: "pk_live_51abc" }).success, false);
});

test("an empty or missing key is refused with a usable message", () => {
  for (const input of [{ apiKey: "" }, { apiKey: "   " }, {}, { apiKey: null }]) {
    const result = stripeKeySchema.safeParse(input);
    assert.equal(result.success, false, JSON.stringify(input));
    if (!result.success) {
      assert.ok((result.error.issues[0]?.message ?? "").length > 10);
    }
  }
});

test("a truncated key is refused", () => {
  assert.equal(stripeKeySchema.safeParse({ apiKey: FAKE_TRUNCATED_KEY }).success, false);
});

test("an over-long value is refused", () => {
  const result = stripeKeySchema.safeParse({ apiKey: `rk_live_${"a".repeat(400)}` });
  assert.equal(result.success, false);
});

test("non-string input does not crash the parser", () => {
  // FormData can hand back a File for a file input.
  for (const bad of [42, {}, [], true]) {
    assert.equal(stripeKeySchema.safeParse({ apiKey: bad }).success, false, JSON.stringify(bad));
  }
});

test("no error message ever contains the submitted value", () => {
  // The property this file exists to protect. A rejected key is still a
  // credential — it may be a real key for the wrong account, or a typo of one
  // that works — and echoing it into a message puts it on screen and in logs.
  const attempts = [
    FAKE_FULL_ACCESS_KEY,
    FAKE_TRUNCATED_KEY,
    "pk_live_51abcdefghijklmnopqrstuvwx",
    `${"x".repeat(300)}`,
  ];

  for (const value of attempts) {
    const result = stripeKeySchema.safeParse({ apiKey: value });
    assert.equal(result.success, false, value.slice(0, 12));
    if (!result.success) {
      for (const issue of result.error.issues) {
        assert.equal(
          issue.message.includes(value),
          false,
          `message echoed the submitted value: ${issue.message}`,
        );
      }
    }
  }
});
