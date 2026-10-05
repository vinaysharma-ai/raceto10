import assert from "node:assert/strict";
import { test } from "node:test";

import { PROFILE_EMAIL_MAX, PRODUCT_NAME_MAX, profileSchema } from "./profile.ts";

/**
 * The profile step: product name, display name, email, consent.
 *
 * The two that matter are the product name and the consent. The first is what
 * the board shows beside the founder, and the second is what makes showing any
 * of it legitimate — so both are required, and the consent has to be an actual
 * tick rather than anything truthy.
 *
 * The X handle is deliberately absent. It used to be collected here, and it
 * moved to the sign-in path because a typed handle is a claim rather than a
 * proof, and the board publishes it as a link.
 */

const base = { productName: "Ledgerly", email: "ada@example.com", consent: "yes" };

test("a complete submission parses", () => {
  const result = profileSchema.safeParse({ ...base, name: "Ada Lovelace" });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data, {
    name: "Ada Lovelace",
    productName: "Ledgerly",
    email: "ada@example.com",
    consent: "yes",
  });
});

test("the name is optional and becomes null, not an empty string", () => {
  for (const input of [{ ...base }, { ...base, name: "" }, { ...base, name: "   " }]) {
    const result = profileSchema.safeParse(input);
    assert.equal(result.success, true, JSON.stringify(input));
    if (result.success) assert.equal(result.data.name, null);
  }
});

// ---------------------------------------------------------------------------
// The product name
// ---------------------------------------------------------------------------

test("a product name is required, and a blank one is not a name", () => {
  for (const productName of [undefined, "", " ", "a"]) {
    const result = profileSchema.safeParse({ ...base, productName });
    assert.equal(result.success, false, JSON.stringify(productName));
  }
});

test("a two-character product name is accepted", () => {
  // The boundary is inclusive. A product genuinely called "X" or "10" is short,
  // not invalid, and refusing it would be refusing a real founder.
  const result = profileSchema.safeParse({ ...base, productName: "10" });
  assert.equal(result.success, true);
});

test("an over-long product name is refused rather than truncated", () => {
  const result = profileSchema.safeParse({
    ...base,
    productName: "a".repeat(PRODUCT_NAME_MAX + 1),
  });
  assert.equal(result.success, false);
});

test("the product name is trimmed before it is measured", () => {
  // Otherwise "  Ledgerly  " passes a length check on its padding.
  const result = profileSchema.safeParse({ ...base, productName: "  Ledgerly  " });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.productName, "Ledgerly");
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test("consent has to be the ticked value, not merely present", () => {
  // An unticked checkbox submits nothing or "no"; a truthy coercion would take
  // both as agreement. This is the one field where that would matter most.
  for (const consent of [undefined, "", "no", "on", "true", "YES"]) {
    const result = profileSchema.safeParse({ ...base, consent });
    assert.equal(result.success, false, JSON.stringify(consent));
  }
});

test("a missing consent says so, rather than reporting a type error", () => {
  const result = profileSchema.safeParse({ productName: "Ledgerly", email: "ada@example.com" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /Tick the box/);
  }
});

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

test("the email is trimmed and lowercased", () => {
  const result = profileSchema.safeParse({ ...base, email: "  Ada@Example.COM  " });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.email, "ada@example.com");
});

test("an address that is not one is refused", () => {
  for (const email of ["", "ada", "ada@", "@example.com", "a b@example.com"]) {
    const result = profileSchema.safeParse({ ...base, email });
    assert.equal(result.success, false, `${JSON.stringify(email)} should be refused`);
  }
});

test("an over-long address is refused", () => {
  const result = profileSchema.safeParse({
    ...base,
    email: `${"a".repeat(PROFILE_EMAIL_MAX)}@example.com`,
  });
  assert.equal(result.success, false);
});

test("an over-long name is refused", () => {
  const result = profileSchema.safeParse({ ...base, name: "a".repeat(61) });
  assert.equal(result.success, false);
});

test("non-string input does not crash the parser", () => {
  // FormData can hand back a File for a field, and a form can simply omit one.
  for (const bad of [null, undefined, 42, {}, []]) {
    const result = profileSchema.safeParse({ ...base, productName: bad });
    assert.equal(result.success, false, JSON.stringify(bad));
  }
});
