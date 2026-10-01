import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RACER_NAME_MAX,
  RACER_PRODUCT_MAX,
  normaliseXHandle,
  racerSchema,
} from "./racer.ts";

/** What `formData.get()` hands over: strings, always. */
function form(overrides: Record<string, unknown> = {}) {
  return {
    name: "Ada Lovelace",
    productName: "Ledgerly",
    xHandle: "ada",
    email: "ada@example.com",
    ...overrides,
  };
}

const messageFor = (input: unknown) => {
  const parsed = racerSchema.safeParse(input);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
};

test("a complete entry passes", () => {
  const parsed = racerSchema.safeParse(form());
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.xHandle, "ada");
  assert.equal(parsed.success && parsed.data.email, "ada@example.com");
});

// ---------------------------------------------------------------------------
// The X handle — the entry's public identity
// ---------------------------------------------------------------------------

test("all the ways people write an X handle mean the same account", () => {
  for (const input of [
    "ada",
    "@ada",
    "x.com/ada",
    "https://x.com/ada",
    "https://www.x.com/ada",
    "https://twitter.com/ada",
    "https://x.com/ada/",
    "https://x.com/ada?ref=raceto10",
  ]) {
    assert.equal(normaliseXHandle(input), "ada", `${input} should normalise to ada`);
  }
});

test("the X handle is required — it is the board's identity column", () => {
  // It was optional while a separate `handle` field existed. With the field
  // list reduced to name, product, X handle, email, this is the only public
  // identifier an entry has; making it optional would produce rows nobody can
  // be identified by.
  assert.notEqual(messageFor(form({ xHandle: "" })), null);
  assert.notEqual(messageFor(form({ xHandle: "   " })), null);
  assert.notEqual(messageFor(form({ xHandle: undefined })), null);
});

test("something that is not a handle is refused rather than stored", () => {
  for (const input of [
    "hello world",
    "ada!",
    "a".repeat(16),
    "https://example.com/ada",
    // `x.com/a/b` links to something that is not a profile. Taking its first
    // segment would store a different handle than the one pasted — a
    // valid-looking value produced from an invalid input.
    "https://x.com/a/b",
  ]) {
    assert.equal(normaliseXHandle(input), null, `${input} should not normalise`);
  }
});

test("a stored X handle is safe to put in a URL", () => {
  // The leaderboard builds `https://x.com/${handle}`. A handle containing a
  // slash or a query would rewrite that URL.
  const parsed = racerSchema.safeParse(form({ xHandle: "https://x.com/a/b" }));
  assert.equal(parsed.success, false);
});

// ---------------------------------------------------------------------------
// Name, product, email
// ---------------------------------------------------------------------------

test("blank names and products are refused rather than trimmed to nothing", () => {
  assert.notEqual(messageFor(form({ name: "   " })), null);
  assert.notEqual(messageFor(form({ productName: "" })), null);
  assert.equal(racerSchema.safeParse(form({ name: "  Ada  " })).success, true);
});

test("the name and product are length-capped", () => {
  assert.equal(racerSchema.safeParse(form({ name: "a".repeat(RACER_NAME_MAX) })).success, true);
  assert.notEqual(messageFor(form({ name: "a".repeat(RACER_NAME_MAX + 1) })), null);

  assert.equal(
    racerSchema.safeParse(form({ productName: "a".repeat(RACER_PRODUCT_MAX) })).success,
    true,
  );
  assert.notEqual(messageFor(form({ productName: "a".repeat(RACER_PRODUCT_MAX + 1) })), null);
});

test("the email is lowercased and validated", () => {
  const parsed = racerSchema.safeParse(form({ email: "  Ada@Example.COM " }));
  assert.equal(parsed.success && parsed.data.email, "ada@example.com");

  for (const email of ["", "ada", "ada@", "@example.com", "a b@example.com"]) {
    assert.notEqual(messageFor(form({ email })), null, `${email} should be refused`);
  }
});
