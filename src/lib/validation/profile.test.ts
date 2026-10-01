import assert from "node:assert/strict";
import { test } from "node:test";

import { profileSchema } from "./profile.ts";

/**
 * The two fields a founder types themselves.
 *
 * The handle is the one that matters. It is the first column of the leaderboard
 * and the thing the board links to, so a value that is *nearly* right is worse
 * than a rejection: it would point at somebody else's account under this
 * founder's name.
 */

const base = { xHandle: "ada", email: "ada@example.com" };

test("a complete submission parses", () => {
  const result = profileSchema.safeParse({ ...base, name: "Ada Lovelace" });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data, {
    name: "Ada Lovelace",
    xHandle: "ada",
    email: "ada@example.com",
  });
});

test("the name is optional and becomes null, not an empty string", () => {
  for (const input of [{ ...base }, { ...base, name: "" }, { ...base, name: "   " }]) {
    const result = profileSchema.safeParse(input);
    assert.equal(result.success, true, JSON.stringify(input));
    if (result.success) assert.equal(result.data.name, null);
  }
});

test("a handle is accepted in every form people paste", () => {
  // Every spelling `normaliseXHandle` was written for. They all mean one
  // account, so refusing any of them would be refusing the person.
  //
  // A query or fragment belongs here rather than with the refusals: people
  // paste `x.com/ada?ref=something` straight from a share sheet, and the
  // referrer is not part of who they are.
  for (const raw of [
    "ada",
    "@ada",
    "x.com/ada",
    "https://x.com/ada",
    "twitter.com/ada",
    "ada?x=1",
    "ada#top",
  ]) {
    const result = profileSchema.safeParse({ ...base, xHandle: raw });
    assert.equal(result.success, true, raw);
    if (result.success) assert.equal(result.data.xHandle, "ada", raw);
  }
});

test("a handle that would point at the wrong account is refused", () => {
  // `x.com/a/b` is not a profile. Taking its first segment would store a
  // different handle than the one pasted — a valid-looking value produced from
  // an invalid input, which is the failure mode this guards.
  for (const raw of ["a/b", "x.com/a/b", "a b", "ad$a", "ada!"]) {
    const result = profileSchema.safeParse({ ...base, xHandle: raw });
    assert.equal(result.success, false, `${JSON.stringify(raw)} should be refused`);
  }
});

test("an over-long handle is refused rather than truncated", () => {
  // Truncating would store a handle belonging to somebody else.
  const result = profileSchema.safeParse({ ...base, xHandle: "a".repeat(16) });
  assert.equal(result.success, false);
});

test("a missing handle is refused, because the board has no other identifier", () => {
  const result = profileSchema.safeParse({ email: "ada@example.com" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /X handle/);
  }
});

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
    email: `${"a".repeat(250)}@example.com`,
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
    const result = profileSchema.safeParse({ ...base, xHandle: bad });
    assert.equal(result.success, false, JSON.stringify(bad));
  }
});
