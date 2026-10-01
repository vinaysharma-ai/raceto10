import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sealing and opening a stored credential.
 *
 * `02` §89: "Private vault … encrypt with application key. Never log, return, or
 * echo plaintext credentials."
 *
 * ## The construction
 *
 * AES-256-GCM. Authenticated encryption, so a ciphertext that has been altered
 * fails to open rather than decrypting to something plausible — which matters
 * here because the plaintext is a live API key and the failure mode of
 * unauthenticated encryption is handing Stripe garbage while believing we handed
 * it the key.
 *
 * The stored value is `base64(iv ‖ authTag ‖ ciphertext)`, with the IV and tag
 * leading so the layout is self-describing. `key_version` lives in its own
 * column (`provider_credentials.key_version`, `02` §94), not inside this string,
 * so rotating the key is an UPDATE over one column rather than a parse of every
 * row.
 *
 * ## Why the associated data matters
 *
 * Every seal is bound to the id of the connection it belongs to. GCM's
 * associated data is authenticated but not encrypted, so it is not a secret —
 * what it buys is that a ciphertext cannot be *moved*. Without it, anyone able
 * to write to `provider_credentials` could copy one racer's encrypted blob onto
 * another racer's row, and the decryption would succeed: the vault would hand
 * back a valid key belonging to somebody else, and the reads that followed would
 * count the wrong account's customers. With it, that row is undecryptable.
 *
 * The id is not a secret, and this is not a substitute for the row-level
 * policies — it closes the one gap those cannot, which is a ciphertext that is
 * valid but in the wrong place.
 *
 * ## Why this module has no `server-only` import
 *
 * It is pure and holds no key of its own; the key arrives as an argument. That
 * is what lets the test suite exercise it directly, and it means the module
 * cannot reach into the environment behind a caller's back. The impure half —
 * reading the key from configuration — lives in `./key.ts`, which is
 * server-only.
 */

/** Bumped when the key itself changes, not when this code changes. */
export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SealedSecret = {
  /** base64(iv ‖ authTag ‖ ciphertext) */
  ciphertext: string;
  keyVersion: number;
};

/**
 * Turns the configured value into a key.
 *
 * `00` §88 says to generate it with `openssl rand -base64 32`, so base64 is the
 * documented form. The length is checked rather than trusted: a short key here
 * would otherwise surface as a confusing OpenSSL error at the first connection
 * attempt, long after the misconfiguration, and only for whichever racer
 * happened to be first.
 */
export function parseKey(encoded: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encoded.trim(), "base64");
  } catch {
    throw new Error("The credential encryption key is not valid base64.");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `The credential encryption key must decode to ${KEY_BYTES} bytes; ` +
        `this one decodes to ${key.length}. Generate one with ` +
        "`openssl rand -base64 32`.",
    );
  }

  return key;
}

/** Seals a plaintext credential for storage against one connection. */
export function sealSecret(
  plaintext: string,
  key: Buffer,
  connectionId: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): SealedSecret {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Expected a ${KEY_BYTES}-byte key, received ${key.length}.`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Authenticated, not encrypted. See the note above on why this is the
  // connection id rather than anything secret.
  cipher.setAAD(Buffer.from(connectionId, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([iv, tag, ciphertext]).toString("base64"),
    keyVersion,
  };
}

/**
 * Opens a stored credential.
 *
 * Throws on anything that is not a byte-for-byte authentic record: a wrong key,
 * a wrong connection id, a truncated blob, a tampered byte. Every one of those
 * is "this credential cannot be trusted", and they are deliberately not
 * distinguished — the caller has no useful action that differs between them, and
 * a precise error here is a decryption oracle.
 */
export function openSecret(
  sealed: SealedSecret,
  key: Buffer,
  connectionId: string,
): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Expected a ${KEY_BYTES}-byte key, received ${key.length}.`);
  }

  const raw = Buffer.from(sealed.ciphertext, "base64");

  // Strictly less than the header, not less-than-or-equal: a sealed empty
  // string is exactly `iv ‖ tag` with no body, and GCM produces a valid tag for
  // it. Rejecting that would be rejecting a well-formed record. Anything
  // shorter cannot contain the header at all, and slicing it would silently
  // yield empty buffers rather than failing.
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("The stored credential is malformed.");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(connectionId, "utf8"));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately opaque. Distinguishing "wrong key" from "tampered" from
    // "wrong row" would tell an attacker which of the three they achieved.
    throw new Error("The stored credential could not be opened.");
  }
}

/**
 * Compares two secrets without leaking their difference through timing.
 *
 * Used when checking a submitted credential against a stored one — a plain `===`
 * on a string short-circuits at the first differing byte, which is a real (if
 * slow) way to recover a secret one character at a time.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on length mismatch, and the length is not the
  // secret — so a mismatch is answered directly rather than padded.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
