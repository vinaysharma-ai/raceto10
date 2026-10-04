import "server-only";

import { sealForConnection } from "@/lib/vault/server";

import { CredentialError, type CredentialFailure } from "./stripe/restricted.ts";

/**
 * Connecting a racer's Stripe account.
 *
 * ## What this writes, and to which table
 *
 * Two tables, deliberately separate (`02` §89, §11):
 *
 *   * `provider_connections` — non-secret metadata: which provider, which
 *     account, whether it is healthy. Readable by the app.
 *   * `provider_credentials` — the sealed key alone. Never read by anything
 *     except an outbound provider call.
 *
 * The split is what makes the connection list safe to render: a row of
 * `provider_connections` can be shown to its owner without any path existing
 * from it to the key.
 *
 * ## Ownership
 *
 * Every function here takes the racer id resolved from the *session*, never from
 * a request body. The caller (`src/app/actions/provider.ts`) resolves it with
 * `getCurrentRacer()`, which reads the authenticated user and walks to their
 * racer row. A founder therefore cannot name another founder's racer id, because
 * no code path accepts one.
 *
 * That is the check that matters, and it is enforced twice over: here by
 * construction, and in the database by RLS on both tables.
 *
 * ## The one-account-one-race rule
 *
 * `provider_connections` carries `unique (provider, external_account_ref)`. If a
 * racer tries to connect an account another racer already used, the insert is
 * refused by the database rather than by a check written here — so the rule
 * holds even if this file is wrong.
 */

export type ConnectOutcome =
  | {
      ok: true;
      connectionId: string;
      accountId: string;
      accountLabel: string | null;
      /** True when an existing connection was replaced rather than created. */
      replaced: boolean;
    }
  | { ok: false; reason: ConnectFailure; message: string };

export type ConnectFailure =
  | CredentialFailure
  | "account_in_use"
  | "no_racer"
  | "storage_error";

/**
 * The sentence a racer reads, keyed on the category.
 *
 * `02` §257 forbids surfacing raw provider text. Stripe's own message can echo
 * the submitted key in some 401s, and its request id helps nobody pasting a key.
 * So the adapter returns a category and the copy lives here, where it is written
 * for a person.
 */
export function describeConnectFailure(reason: ConnectFailure): string {
  switch (reason) {
    case "rejected":
      return "Stripe didn't accept that key. Check you copied the whole key, and that it hasn't been revoked.";
    case "insufficient_permission":
      return "That key is valid but can't read what we need. Give it Read access to Customers, Charges and Subscriptions, then paste it again.";
    case "not_read_only":
      return "That key can write to your Stripe account. RaceTo10 only ever needs read access: create a restricted key with read permissions and no write access.";
    case "account_in_use":
      return "That Stripe account is already connected to another race. One account can only back one entry.";
    case "unavailable":
      return "We couldn't reach Stripe just now. Nothing was saved. Try again in a moment.";
    case "no_racer":
      return "Finish setting up your profile before connecting a payment provider.";
    case "storage_error":
      return "We couldn't save that just now. Try again in a moment.";
  }
}

/**
 * Turns an adapter failure into a caller-facing outcome.
 *
 * Exported so the action and the tests agree on the mapping rather than each
 * writing their own.
 */
export function failureOutcome(reason: ConnectFailure): ConnectOutcome {
  return { ok: false, reason, message: describeConnectFailure(reason) };
}

/** Maps a thrown adapter error to a category. Anything unrecognised is storage. */
export function classify(error: unknown): ConnectFailure {
  if (error instanceof CredentialError) return error.reason;
  return "storage_error";
}

// ---------------------------------------------------------------------------
// The vault reference
// ---------------------------------------------------------------------------

/**
 * The reference stored on the connection and used as the vault's associated
 * data.
 *
 * It is the connection's own id, which is what binds a sealed key to one row:
 * a ciphertext copied onto a different connection does not open. See
 * `src/lib/vault/crypto.ts`.
 */
export function credentialRefFor(connectionId: string): string {
  return connectionId;
}

/**
 * Seals a key for storage.
 *
 * The plaintext is a parameter and the return value goes straight to the
 * database. It is deliberately not returned to any caller, not put on an
 * outcome object, and not logged — including on the failure paths, where it
 * would be easiest to include "the key we tried" in a diagnostic.
 */
export function sealCredential(apiKey: string, connectionId: string) {
  return sealForConnection(apiKey, credentialRefFor(connectionId));
}
