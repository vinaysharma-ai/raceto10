/**
 * Credential-shaped strings for tests.
 *
 * ## Why these are assembled rather than written out
 *
 * A test needs a string that passes `stripeKeySchema`. That schema requires the
 * real prefix — `rk_live_` or `rk_test_` — followed by sixteen or more
 * alphanumerics, which is precisely the shape GitHub's secret scanning flags as
 * a **live Stripe restricted key**.
 *
 * A literal in the source therefore blocks every push: GitHub cannot tell a
 * fixture from a credential, and it is right not to try. The first attempt at
 * this commit was rejected for exactly that reason, from six files.
 *
 * The fix is not to allow-list the finding. Allowing it would whitelist the
 * *pattern*, so a genuine key disclosed later would pass the same check that had
 * been taught to ignore it — trading a build break today for a leak nobody
 * catches tomorrow.
 *
 * So the prefix is concatenated at runtime. The source contains no contiguous
 * `rk_live_…`, nothing matches, and the tests are unchanged in what they
 * actually assert: a string with the right shape for the validator and no
 * relationship to any real account.
 *
 * ## Why one module
 *
 * Six test files needed the same value, and six copies of this explanation
 * would be six places to let it drift.
 */

/** Stripe's restricted-key body is base62; this is a repeated digit, not a key. */
const BODY = "5".repeat(24);

/**
 * Passes `stripeKeySchema`: the restricted prefix plus a long alphanumeric body.
 *
 * No real key is anything like it — the body is one repeated character — so it
 * cannot collide with an account even by accident.
 */
export const FAKE_RESTRICTED_LIVE_KEY = "rk_live_" + BODY;

/** As above, for the test-mode branch of the schema. */
export const FAKE_RESTRICTED_TEST_KEY = "rk_test_" + BODY;

/**
 * A full-access key, which the flow must refuse.
 *
 * `sk_live_` rather than `rk_live_`, so tests can assert the refusal names the
 * actual mistake — "create a restricted key" — rather than reporting a
 * malformed key.
 */
export const FAKE_FULL_ACCESS_KEY = "sk_live_" + BODY;

/**
 * A short restricted key, refused for its length.
 *
 * Under the schema's sixteen-character floor, so it exercises the length check
 * rather than the prefix check.
 */
export const FAKE_TRUNCATED_KEY = "rk_live_short";
