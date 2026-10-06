import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The Stripe client reads, and only reads.
 *
 * ## Why this is a source assertion rather than a behavioural one
 *
 * Every other test in this directory proves what the adapter *does*. This one
 * proves what it *can* do, and those are different claims. A behavioural test
 * can only cover the calls somebody thought to write; a founder pastes a key
 * whose entire safety argument is that this product never writes to their
 * account, and "no test happened to exercise a write" is not that argument.
 *
 * So the source is read and inspected. It is the one place in this codebase
 * where that is the right tool, and the reason is that the property is about the
 * absence of code rather than the behaviour of it.
 *
 * ## What it looks for
 *
 * The Stripe SDK exposes writes as `.create`, `.update`, `.del`, `.capture`,
 * `.cancel`, `.refund` and friends. The read paths this product needs are
 * `.list` and, for accounts, `.list({ limit: 1 })` — an earlier version used
 * `.retrieve`, which is also a read, but newer API versions require an id for it
 * and the id is what we do not have.
 *
 * A raw `fetch` with a mutating method would bypass all of that, which is why
 * the HTTP verbs are checked too.
 */

/**
 * Both files that touch Stripe, not just the one the SDK is constructed in.
 *
 * The SDK moved to `port.ts` when the probe needed to run the same code without
 * importing `server-only`. Splitting them is exactly when a mutating call could
 * slip into whichever half nobody was checking, so both are scanned.
 */
const CLIENTS = [
  "src/lib/verification/stripe/port.ts",
  "src/lib/verification/stripe/restricted-client.ts",
];

/** Stripe SDK methods that change state. */
const WRITE_METHODS = [
  ".create(",
  ".update(",
  ".del(",
  ".delete(",
  ".capture(",
  ".cancel(",
  ".refund(",
  ".confirm(",
  ".void(",
  ".close(",
  ".reverse(",
  ".expire(",
  ".pay(",
  ".finalize(",
];

/** HTTP verbs that change state, in case the SDK is bypassed. */
const WRITE_VERBS = ['method: "POST"', "method: 'POST'", 'method: "DELETE"', 'method: "PATCH"', 'method: "PUT"'];

test("the Stripe client contains no mutating SDK call", () => {
  for (const file of CLIENTS) {
    const source = readFileSync(file, "utf8");
    const found = WRITE_METHODS.filter((method) => source.includes(method));

    assert.deepEqual(
      found,
      [],
      `${file} calls ${found.join(", ")}. This product may only read a racer's account.`,
    );
  }
});

test("the Stripe client issues no mutating HTTP verb", () => {
  for (const file of CLIENTS) {
    const source = readFileSync(file, "utf8");
    const found = WRITE_VERBS.filter((verb) => source.includes(verb));

    assert.deepEqual(found, [], `${file} issues ${found.join(", ")}`);
  }
});

test("the client is only ever constructed with a credential, never with a platform key", () => {
  const source = readFileSync("src/lib/verification/stripe/port.ts", "utf8");

  // `new Stripe(...)` must always be passed the resolved racer key. A second
  // construction with an environment value would be a platform-level client,
  // which is the shape that could act across accounts.
  const constructions = [...source.matchAll(/new Stripe\(([^)]*)\)/g)].map((m) => m[1].trim());

  assert.ok(constructions.length > 0, "no Stripe client is constructed at all");
  for (const argument of constructions) {
    assert.equal(
      argument,
      "secretKey",
      `a Stripe client was constructed with \`${argument}\` rather than the resolved credential`,
    );
  }
});

test("the GET-only property is stated where the port is defined, not only here", () => {
  const source = readFileSync("src/lib/verification/stripe/restricted.ts", "utf8");

  // The port is the other half of the same guarantee: a caller cannot ask for a
  // write through it, because there is no method to ask with.
  for (const method of ["create", "update", "delete", "refund"]) {
    assert.equal(
      new RegExp(`^\\s*${method}\\(`, "m").test(source),
      false,
      `the port declares a \`${method}\` method`,
    );
  }
});
