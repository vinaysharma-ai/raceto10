import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { FAKE_FULL_ACCESS_KEY } from "../verification/test-fixtures.ts";

import {
  CURRENT_KEY_VERSION,
  openSecret,
  parseKey,
  sealSecret,
  secretsMatch,
} from "./crypto.ts";

/**
 * The credential vault.
 *
 * The tests that matter are the negative ones. A round trip proves the code
 * runs; it does not prove that a ciphertext moved onto another racer's row
 * fails to open, and that is the property the whole design rests on.
 */

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONNECTION = "22222222-2222-4222-8222-222222222222";
const SECRET = FAKE_FULL_ACCESS_KEY;

// Mirrors the private header layout the module uses, so the truncation test
// below cannot drift from the implementation.
const IV_BYTES = 12;
const TAG_BYTES = 16;

test("a sealed secret opens back to exactly what went in", () => {
  const sealed = sealSecret(SECRET, KEY, CONNECTION);
  assert.equal(openSecret(sealed, KEY, CONNECTION), SECRET);
});

test("the plaintext is nowhere in the stored value", () => {
  // The single most important assertion in this file. A vault that stores the
  // secret alongside the ciphertext would pass every round-trip test above.
  const sealed = sealSecret(SECRET, KEY, CONNECTION);

  assert.equal(sealed.ciphertext.includes(SECRET), false);
  const decoded = Buffer.from(sealed.ciphertext, "base64").toString("utf8");
  assert.equal(decoded.includes(SECRET), false);
  assert.equal(decoded.includes("sk_live"), false);
});

test("a ciphertext moved to another connection does not open", () => {
  // The associated-data binding. Without it, anyone who could write to
  // `provider_credentials` could copy one racer's blob onto another's row and
  // the vault would hand back a valid key for the wrong account — counts would
  // then be read from somebody else's Stripe.
  const sealed = sealSecret(SECRET, KEY, CONNECTION);

  assert.throws(
    () => openSecret(sealed, KEY, OTHER_CONNECTION),
    /could not be opened/,
  );
});

test("a tampered ciphertext does not open", () => {
  const sealed = sealSecret(SECRET, KEY, CONNECTION);
  const raw = Buffer.from(sealed.ciphertext, "base64");

  // Flip one bit in the body, past the iv and tag header.
  const target = IV_BYTES + TAG_BYTES + 4;
  raw[target] ^= 0x01;

  assert.throws(
    () => openSecret({ ...sealed, ciphertext: raw.toString("base64") }, KEY, CONNECTION),
    /could not be opened/,
  );
});

test("a tampered auth tag does not open", () => {
  const sealed = sealSecret(SECRET, KEY, CONNECTION);
  const raw = Buffer.from(sealed.ciphertext, "base64");
  raw[IV_BYTES] ^= 0x01;

  assert.throws(
    () => openSecret({ ...sealed, ciphertext: raw.toString("base64") }, KEY, CONNECTION),
    /could not be opened/,
  );
});

test("the wrong key does not open", () => {
  const sealed = sealSecret(SECRET, KEY, CONNECTION);
  assert.throws(() => openSecret(sealed, OTHER_KEY, CONNECTION), /could not be opened/);
});

test("a truncated blob is refused rather than decoded to nothing", () => {
  for (const length of [0, 1, 12, 27, 28]) {
    const truncated = randomBytes(length).toString("base64");
    assert.throws(
      () => openSecret({ ciphertext: truncated, keyVersion: 1 }, KEY, CONNECTION),
      /malformed|could not be opened/,
      `length ${length}`,
    );
  }
});

test("the key version is recorded, and defaults to current", () => {
  assert.equal(sealSecret(SECRET, KEY, CONNECTION).keyVersion, CURRENT_KEY_VERSION);
  assert.equal(sealSecret(SECRET, KEY, CONNECTION, 7).keyVersion, 7);
});

test("sealing the same secret twice produces different bytes", () => {
  // A fresh IV per seal. Reusing one under the same key is the failure that
  // breaks GCM completely, so this is worth pinning.
  const first = sealSecret(SECRET, KEY, CONNECTION);
  const second = sealSecret(SECRET, KEY, CONNECTION);

  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(openSecret(first, KEY, CONNECTION), SECRET);
  assert.equal(openSecret(second, KEY, CONNECTION), SECRET);
});

test("an empty plaintext still round-trips", () => {
  // Not a valid credential, but the vault should not be the thing that decides
  // that — validation happens before sealing.
  const sealed = sealSecret("", KEY, CONNECTION);
  assert.equal(openSecret(sealed, KEY, CONNECTION), "");
});

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

test("a 32-byte base64 key parses", () => {
  const encoded = randomBytes(32).toString("base64");
  assert.equal(parseKey(encoded).length, 32);
});

test("a key of the wrong size is refused, with the size in the message", () => {
  // A short key would otherwise surface as an OpenSSL error at the first
  // connection attempt — long after the misconfiguration, and only for
  // whichever racer happened to be first.
  for (const bytes of [16, 24, 31, 33, 64]) {
    const encoded = randomBytes(bytes).toString("base64");
    assert.throws(() => parseKey(encoded), /must decode to 32 bytes/, `${bytes} bytes`);
  }
});

test("surrounding whitespace is tolerated", () => {
  // A trailing newline from `openssl rand -base64 32 > file` or a copy-paste
  // into a dashboard field is the ordinary case.
  const encoded = randomBytes(32).toString("base64");
  assert.equal(parseKey(`  ${encoded}\n`).length, 32);
});

test("an empty key is refused rather than silently padded", () => {
  assert.throws(() => parseKey(""), /must decode to 32 bytes/);
});

test("sealing with a wrong-sized key is refused", () => {
  assert.throws(() => sealSecret(SECRET, randomBytes(16), CONNECTION), /32-byte key/);
});

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

test("secretsMatch agrees with equality for equal and unequal values", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abc", "abd"), false);
  assert.equal(secretsMatch("abc", "abcd"), false);
  assert.equal(secretsMatch("", ""), true);
  assert.equal(secretsMatch("", "a"), false);
});
