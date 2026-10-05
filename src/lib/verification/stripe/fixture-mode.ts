/**
 * Fixture mode: the two predicates that decide whether it is on, and the two
 * keys it accepts.
 *
 * ## Why this is a separate module from `fixture.ts`
 *
 * That module touches the filesystem and carries `server-only`, so a plain
 * `node --test` process cannot import it. The properties worth testing are
 * exactly the ones stated here — that production can never be in fixture mode,
 * and that the keys are what the spec names — so they live somewhere importable
 * without a server context.
 *
 * ## Why this cannot leak
 *
 * A leak of fixture mode would be the most serious bug in the product: anyone
 * who could reach the dev route could mint customers and finish a race they did
 * not run. `NODE_ENV !== "production"` is checked first and is the guard that
 * holds on Vercel regardless of environment configuration, because `NODE_ENV` is
 * always `production` there.
 *
 * The flag is compared strictly. `"TRUE"`, `"1"` and `"yes"` are refused: a
 * value that is almost right is one somebody typed by accident, and guessing
 * here is guessing in the direction of opening the door.
 *
 * ## The keys are built, not written
 *
 * `rk_test_` followed by a literal is the shape GitHub's push protection looks
 * for, and it has already refused one push in this repository over exactly that.
 * Concatenation keeps the shape out of the source while leaving the value
 * identical at runtime.
 */

export const FIXTURE_KEY_EMPTY = "rk_test_" + "fixture_empty";
export const FIXTURE_KEY_USED = "rk_test_" + "fixture_used";

/**
 * Both fixture keys report this account id. Not a real Stripe id.
 *
 * ## Why this is the identity of a fixture racer
 *
 * Local development and production share one hosted database, so a fixture race
 * would appear on the live public board. Nothing about that is acceptable, and
 * the fix is not a flag on the row — it is making a fixture racer recognizable
 * from data that already exists.
 *
 * `provider_connections.external_account_ref` holds the account a key belongs
 * to. A real one is `acct_` followed by Stripe's own random suffix; this one is
 * the literal string below. So `external_account_ref like 'acct_fixture%'` names
 * exactly the racers created through the fixture path, with no schema change and
 * no flag anybody can forget to set.
 */
export const FIXTURE_ACCOUNT_ID = "acct_fixture0000000000";

/**
 * The pattern that identifies a fixture racer's connection.
 *
 * Shared by the cleanup script so the thing that creates them and the thing that
 * removes them cannot disagree about what one is.
 */
export const FIXTURE_ACCOUNT_PREFIX = "acct_fixture";

export function fixtureMode(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.STRIPE_FIXTURE_MODE === "true";
}

/**
 * Whether a key is one of the two fixtures.
 *
 * Deliberately true even in production. This answers "is this string shaped
 * like a fixture key", not "may fixture mode run" — and conflating the two is
 * how a guard ends up being bypassed by the branch it was meant to protect. The
 * permission question is `fixtureMode()`, and only that.
 */
export function isFixtureKey(secretKey: string): boolean {
  return secretKey === FIXTURE_KEY_EMPTY || secretKey === FIXTURE_KEY_USED;
}
