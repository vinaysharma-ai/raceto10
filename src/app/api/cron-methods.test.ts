import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * `scripts/call-cron.mjs` and the routes it calls have to agree on the method.
 *
 * ## Why this test exists
 *
 * The script sent POST to both endpoints. `/api/cron/reconcile` exports only
 * GET — it is a scheduled read, and the GitHub workflow calls it that way — so
 * `npm run reconcile` answered 405 and the runbook told the owner to run a
 * command that could not work.
 *
 * Nothing caught it, and the shape of the gap is worth naming: the script is not
 * reachable from the unit-test runner, and the routes are only ever exercised
 * over HTTP, so the two halves of the same call were never compared. This
 * compares them by reading both files, which is not elegant and is exactly the
 * check that was missing.
 *
 * The lesson from the last two failures was that a value written on one side of
 * a boundary and constrained on the other is invisible until it is written. This
 * is the same class, one step earlier: the boundary is HTTP, and it can be
 * checked statically.
 */

const script = readFileSync(new URL("../../../scripts/call-cron.mjs", import.meta.url), "utf8");
const reconcile = readFileSync(new URL("./cron/reconcile/route.ts", import.meta.url), "utf8");
const activate = readFileSync(new URL("./admin/activate-ready/route.ts", import.meta.url), "utf8");

const exportsMethod = (source: string, method: string) =>
  new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(source);

test("the script sends GET to the reconcile route, which exports GET", () => {
  assert.match(script, /"\/api\/cron\/reconcile":\s*"GET"/);
  assert.equal(exportsMethod(reconcile, "GET"), true, "reconcile no longer exports GET");
  assert.equal(
    exportsMethod(reconcile, "POST"),
    false,
    "reconcile now exports POST — the script's method and the workflow's must be revisited together",
  );
});

test("the script sends POST to the activate route, which exports POST", () => {
  // The script keys this one off the ACTIVATE constant rather than the literal.
  assert.match(script, /\[ACTIVATE\]:\s*"POST"/);
  assert.match(script, /const ACTIVATE = "\/api\/admin\/activate-ready"/);

  assert.equal(exportsMethod(activate, "POST"), true, "activate-ready no longer exports POST");
  assert.equal(
    exportsMethod(activate, "GET"),
    false,
    "activate-ready now exports GET — a state change must not be reachable by a read",
  );
});

test("the script refuses an endpoint it has no method for", () => {
  // Rather than defaulting to one method, which is how a new endpoint silently
  // inherits the wrong verb.
  assert.match(script, /Unknown endpoint/);
  assert.match(script, /process\.exit\(2\)/);
});
