import assert from "node:assert/strict";
import { test } from "node:test";

import { FIXTURE_KEY_EMPTY, FIXTURE_KEY_USED, isFixtureKey } from "./fixture-mode.ts";

/**
 * Fixture mode cannot be on in production.
 *
 * This is the most consequential property in the codebase to get wrong. With
 * fixture mode reachable on a deployment, anyone who could reach the dev route
 * could mint paying customers and finish a race they did not run — and the
 * product's entire claim is that the number is real. So the guard is tested from
 * both of the directions it could fail: the flag being set in production, and
 * the flag being set to something that merely looks like true.
 *
 * `NODE_ENV` is process-global and typed read-only, so the cases below go
 * through a mutable view of it and restore what they found. Node's test runner
 * runs these in one process; a leaked value would make the following tests
 * assert the wrong thing.
 */

const mutableEnv = process.env as Record<string, string | undefined>;

/** Runs `check` with the environment set, and puts it back whatever happens. */
async function withEnv(
  env: { NODE_ENV?: string; STRIPE_FIXTURE_MODE?: string },
  check: () => void | Promise<void>,
): Promise<void> {
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

/**
 * Read at call time rather than import time, so the cases above can move the
 * environment under it.
 */
async function fixtureModeNow(): Promise<boolean> {
  const predicates = await import("./fixture-mode.ts");
  return predicates.fixtureMode();
}

test("production can never be in fixture mode, however the flag is set", async () => {
  for (const flag of ["true", "TRUE", "1", "yes", "on"]) {
    await withEnv({ NODE_ENV: "production", STRIPE_FIXTURE_MODE: flag }, async () => {
      assert.equal(
        await fixtureModeNow(),
        false,
        `fixture mode was on in production with the flag ${flag}`,
      );
    });
  }
});

test("the flag has to be exactly true, even outside production", async () => {
  for (const flag of [undefined, "", "TRUE", "1", "yes", "on", "false"]) {
    await withEnv({ NODE_ENV: "development", STRIPE_FIXTURE_MODE: flag }, async () => {
      assert.equal(
        await fixtureModeNow(),
        false,
        `fixture mode was on with the flag ${JSON.stringify(flag)}`,
      );
    });
  }
});

test("outside production, with the flag exactly true, it is on", async () => {
  await withEnv({ NODE_ENV: "development", STRIPE_FIXTURE_MODE: "true" }, async () => {
    assert.equal(await fixtureModeNow(), true);
  });
});

test("a missing NODE_ENV is not production, but is also not on without the flag", async () => {
  await withEnv({ NODE_ENV: undefined, STRIPE_FIXTURE_MODE: undefined }, async () => {
    assert.equal(await fixtureModeNow(), false);
  });
});

test("the fixture keys are the two the spec names", () => {
  assert.equal(FIXTURE_KEY_EMPTY, "rk_test_fixture_empty");
  assert.equal(FIXTURE_KEY_USED, "rk_test_fixture_used");
});

test("a real key is never mistaken for a fixture key", () => {
  // The `rk_test_` prefix alone is not enough: a racer's own test-mode key
  // starts with the same seven characters, and treating one as a fixture would
  // report an account full of customers nobody paid for.
  for (const key of [
    "rk_test_51AbCdEfGhIjKlMnO",
    "rk_live_51AbCdEfGhIjKlMnO",
    "sk_test_51AbCdEfGhIjKlMnO",
    "rk_test_fixture",
    "rk_test_fixture_empty_extra",
    "",
  ]) {
    assert.equal(isFixtureKey(key), false, key);
  }
});

test("isFixtureKey answers about the string, not about permission", async () => {
  // It stays true in production on purpose. The permission question is
  // `fixtureMode()`, and conflating the two is how a guard gets bypassed by the
  // branch it was meant to protect.
  await withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(isFixtureKey(FIXTURE_KEY_EMPTY), true);
    assert.equal(isFixtureKey(FIXTURE_KEY_USED), true);
  });
});
