import assert from "node:assert/strict";
import { test } from "node:test";

import { stripeKeySchema } from "./provider.ts";
import { FIXTURE_KEY_EMPTY, FIXTURE_KEY_USED } from "../verification/stripe/fixture-mode.ts";
import {
  FAKE_FULL_ACCESS_KEY,
  FAKE_RESTRICTED_LIVE_KEY,
  FAKE_RESTRICTED_TEST_KEY,
  FAKE_TRUNCATED_KEY,
} from "../verification/test-fixtures.ts";

/**
 * The two fixture keys against the shape check.
 *
 * ## The bug these exist for
 *
 * `rk_test_fixture_empty` is not shaped like a Stripe key. Its body is thirteen
 * characters where the pattern demands sixteen, and it contains an underscore
 * where the pattern allows only alphanumerics — two independent reasons the
 * regex refuses it. So the walkthrough's own key was rejected by the format
 * check before any adapter could see it.
 *
 * ## What must not change
 *
 * Loosening a validator to let a test key through is how a real key stops being
 * validated. Every case below that is about a real key asserts the same thing
 * with fixture mode **on**, so the exemption cannot be widening anything it is
 * not meant to.
 *
 * The environment is moved rather than stubbed, the same way
 * `src/lib/verification/stripe/fixture.test.ts` does it, and `fixtureMode()`
 * reads it at call time so a change here is visible to the schema.
 */

const mutableEnv = process.env as Record<string, string | undefined>;

type Env = { NODE_ENV?: string; STRIPE_FIXTURE_MODE?: string };

/** Runs `check` with the environment set, and puts it back whatever happens. */
async function withEnv(env: Env, check: () => void | Promise<void>): Promise<void> {
  const beforeNode = mutableEnv.NODE_ENV;
  const beforeFlag = mutableEnv.STRIPE_FIXTURE_MODE;

  try {
    if (env.NODE_ENV === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = env.NODE_ENV;

    if (env.STRIPE_FIXTURE_MODE === undefined) delete mutableEnv.STRIPE_FIXTURE_MODE;
    else mutableEnv.STRIPE_FIXTURE_MODE = env.STRIPE_FIXTURE_MODE;

    await check();
  } finally {
    if (beforeNode === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = beforeNode;

    if (beforeFlag === undefined) delete mutableEnv.STRIPE_FIXTURE_MODE;
    else mutableEnv.STRIPE_FIXTURE_MODE = beforeFlag;
  }
}

const FIXTURE_KEYS = [FIXTURE_KEY_EMPTY, FIXTURE_KEY_USED];

const MALFORMED = "That doesn't look like a restricted Stripe key. They start with rk_live_ or rk_test_.";

/** The message a refusal produced, or null when it was accepted. */
function messageFor(apiKey: unknown): string | null {
  const result = stripeKeySchema.safeParse({ apiKey });
  return result.success ? null : (result.error.issues[0]?.message ?? "");
}

const FIXTURE_MODE_ON: Env = { NODE_ENV: "development", STRIPE_FIXTURE_MODE: "true" };

// ---------------------------------------------------------------------------
// The exemption, where it applies
// ---------------------------------------------------------------------------

test("both fixture keys are accepted in fixture mode outside production", async () => {
  await withEnv(FIXTURE_MODE_ON, () => {
    for (const key of FIXTURE_KEYS) {
      const result = stripeKeySchema.safeParse({ apiKey: key });
      assert.equal(result.success, true, `${key} was refused in fixture mode`);
      // And it comes through trimmed and intact, like every other key.
      if (result.success) assert.equal(result.data.apiKey, key);
    }
  });
});

test("padding is trimmed off a fixture key, as it is off a real one", async () => {
  // Copying from a terminal brings a trailing newline; the preprocess trims
  // before the refinement runs, so this is the same string by then.
  await withEnv(FIXTURE_MODE_ON, () => {
    const result = stripeKeySchema.safeParse({ apiKey: `  ${FIXTURE_KEY_EMPTY}\n` });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.apiKey, FIXTURE_KEY_EMPTY);
  });
});

// ---------------------------------------------------------------------------
// The exemption, where it does not
// ---------------------------------------------------------------------------

test("the flag has to be exactly true", async () => {
  for (const flag of [undefined, "", "TRUE", "True", "1", "yes", "on", "false"]) {
    await withEnv({ NODE_ENV: "development", STRIPE_FIXTURE_MODE: flag }, () => {
      for (const key of FIXTURE_KEYS) {
        assert.equal(
          messageFor(key),
          MALFORMED,
          `${key} was accepted with STRIPE_FIXTURE_MODE=${JSON.stringify(flag)}`,
        );
      }
    });
  }
});

test("production refuses both fixture keys however the flag is set", async () => {
  for (const flag of ["true", "TRUE", "1", "yes"]) {
    await withEnv({ NODE_ENV: "production", STRIPE_FIXTURE_MODE: flag }, () => {
      for (const key of FIXTURE_KEYS) {
        assert.equal(
          messageFor(key),
          MALFORMED,
          `${key} was accepted in production with STRIPE_FIXTURE_MODE=${flag}`,
        );
      }
    });
  }
});

test("a lookalike is refused even in fixture mode", async () => {
  // The exemption is two literal strings, not a shape. Each of these differs
  // from a fixture key by one character or by one extra one.
  const lookalikes = [
    "rk_test_fixture_empty2",
    "rk_test_fixture_",
    "rk_test_fixture_usedx",
    "rk_test_fixture_Empty",
    "xrk_test_fixture_empty",
    "rk_test_fixture_empt",
    "RK_TEST_FIXTURE_EMPTY",
    "rk_test_fixture_empty;",
  ];

  await withEnv(FIXTURE_MODE_ON, () => {
    for (const key of lookalikes) {
      assert.equal(
        messageFor(key),
        MALFORMED,
        `${key} was accepted; the exemption is wider than two literals`,
      );
    }
  });
});

test("a key long enough for the length rule is still refused for its charset", async () => {
  // The fixture keys fail the pattern on two counts, so this isolates one of
  // them. Twenty-four characters clears the sixteen minimum, leaving the
  // underscore as the only thing refusing it — which is a character no Stripe
  // key body contains. `rk_test_` plus twenty-four *alphanumerics* would be
  // accepted, and correctly so: that is what a real key looks like.
  await withEnv(FIXTURE_MODE_ON, () => {
    const key = `rk_test_${"fixtureempty_".repeat(2)}`;
    assert.ok(key.replace(/^rk_test_/, "").length >= 16, "the case does not test the charset");
    assert.equal(messageFor(key), MALFORMED);
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

test("the real-key rules are identical with fixture mode on and off", async () => {
  // The same assertions under both, so a regression that only shows up while
  // the flag is set cannot hide behind the tests that run with it off.
  const cases: Array<{ value: unknown; accepted: boolean; note: string }> = [
    { value: FAKE_RESTRICTED_LIVE_KEY, accepted: true, note: "restricted live" },
    { value: FAKE_RESTRICTED_TEST_KEY, accepted: true, note: "restricted test" },
    { value: FAKE_FULL_ACCESS_KEY, accepted: false, note: "full access" },
    { value: "pk_live_51abcdefghijklmnopqrstuvwx", accepted: false, note: "publishable" },
    { value: FAKE_TRUNCATED_KEY, accepted: false, note: "truncated" },
    { value: `rk_live_${"a".repeat(400)}`, accepted: false, note: "over-long" },
    { value: "", accepted: false, note: "empty" },
    { value: "rk_live_" + "a".repeat(15), accepted: false, note: "one short of sixteen" },
  ];

  for (const env of [FIXTURE_MODE_ON, { NODE_ENV: "development" } as Env]) {
    await withEnv(env, () => {
      for (const { value, accepted, note } of cases) {
        const result = stripeKeySchema.safeParse({ apiKey: value });
        assert.equal(
          result.success,
          accepted,
          `${note} was ${result.success ? "accepted" : "refused"} with fixture mode ${env.STRIPE_FIXTURE_MODE ?? "off"}`,
        );
      }
    });
  }
});

test("a full-access key is still refused by name while fixture mode is on", async () => {
  // The exemption is on the restricted-key refinement. If it had been put
  // anywhere earlier it would have shadowed this message, which is the one that
  // tells somebody what to create instead.
  await withEnv(FIXTURE_MODE_ON, () => {
    const message = messageFor(FAKE_FULL_ACCESS_KEY);
    assert.match(message ?? "", /restricted key/i);
    assert.match(message ?? "", /read-only|read access/i);
  });
});

test("no fixture refusal echoes the submitted value", async () => {
  await withEnv({ NODE_ENV: "development" }, () => {
    for (const key of [...FIXTURE_KEYS, "rk_test_fixture_empty2"]) {
      const message = messageFor(key);
      assert.equal(message?.includes(key), false, `the message for ${key} contained it`);
    }
  });
});
