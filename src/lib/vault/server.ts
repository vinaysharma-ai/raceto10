import "server-only";

import { credentialEnv } from "@/lib/env.server";

import {
  CURRENT_KEY_VERSION,
  openSecret,
  parseKey,
  sealSecret,
  type SealedSecret,
} from "./crypto.ts";

/**
 * The impure half of the vault: it holds the key, and nothing else does.
 *
 * `crypto.ts` is pure and takes a key as an argument so it can be tested
 * directly. This module is where that key comes from, and the `server-only`
 * import above is what stops any of it reaching the browser bundle — the guard
 * is a build error rather than a leak.
 *
 * ## The rule this module exists to keep
 *
 * **A plaintext credential never leaves this file except into an outbound
 * provider call.** It is not returned to a caller for display, not included in
 * an error, and not logged. `openForConnection` is the only way out, and the
 * only callers are provider reads.
 */

/** Parsed once per process. A wrong key is a configuration fault, not a runtime one. */
let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = parseKey(credentialEnv().PROVIDER_CREDENTIAL_KEY);
  return cachedKey;
}

/** Seals a credential for storage against one connection. */
export function sealForConnection(
  plaintext: string,
  connectionId: string,
): SealedSecret {
  return sealSecret(plaintext, key(), connectionId);
}

/**
 * Opens a credential for use in a provider call.
 *
 * The result must be passed straight into the outbound request. It must not be
 * assigned to anything that is logged, returned from a Server Action, or
 * serialised into a response — including a React Server Component payload,
 * which is a place a value like this can end up without anyone writing
 * `console.log`.
 */
export function openForConnection(sealed: SealedSecret, connectionId: string): string {
  return openSecret(sealed, key(), connectionId);
}

/**
 * The key version a new record should carry.
 *
 * Re-exported rather than reached for through `crypto.ts` directly, so that
 * every caller in the app goes through this module and there is one place to
 * change when the key rotates.
 */
export { CURRENT_KEY_VERSION };

/** Test seam. Clears the parsed key so a cold process can be simulated. */
export function resetVaultKeyCache() {
  cachedKey = undefined;
}
