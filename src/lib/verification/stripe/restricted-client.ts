import "server-only";

import { openForConnection } from "@/lib/vault/server";

import type { VerificationProvider } from "../types.ts";
import { createFixturePort, fixtureMode, isFixtureKey } from "./fixture.ts";
// The real port lives in its own module so that `npm run stripe:probe` can run
// the same code the application runs, without importing this file's
// `server-only` guard or the vault.
import { buildPort } from "./port.ts";
import {
  createStripeRestrictedKeyAdapter,
  type StripeRestrictedPort,
} from "./restricted.ts";

/**
 * Production wiring for the restricted-key adapter — the only file in this path
 * that touches the Stripe SDK or the vault.
 *
 * Keeping it separate is what lets the adapter's test suite run against a fake
 * port: no SDK, no network, no keys, and every line of real logic exercised.
 *
 * ## One client per credential, and why that is the safe direction
 *
 * The Connect adapter builds one client from the platform key and passes
 * `stripeAccount` per request. A restricted key has no platform key to build
 * from — the credential IS the client — so each call constructs a client from
 * the resolved key.
 *
 * Those clients are never cached. A per-credential cache keyed on anything
 * fallible would be a way for one racer's reads to run as another's account,
 * which is the single worst failure this module could have. Constructing a
 * client is cheap; a cross-account read is not recoverable.
 */

/**
 * The port this process will actually use.
 *
 * ## Fixture mode is chosen here, once
 *
 * When `fixtureMode()` is false — which is every deployment, because it also
 * requires `NODE_ENV !== "production"` — this returns the real port and nothing
 * else is reachable. The fixture port is not consulted, not constructed, and a
 * fixture key goes to Stripe, which refuses it with a 401 that the adapter
 * already reports as a rejected credential.
 *
 * The check is deliberately at construction rather than inside each method. A
 * per-call branch is one that can be reached by a code path that forgot to read
 * the flag; a whole port that was never built cannot be reached at all.
 */
function portFor(racerId: string): StripeRestrictedPort {
  const real = buildPort();

  if (!fixtureMode()) return real;

  // Local development with the flag on. Fixture keys are answered from the
  // file; a real key still goes to Stripe, so the mode is additive rather than
  // blocking.
  const fixture = createFixturePort(racerId);

  const pick = (secretKey: string) => (isFixtureKey(secretKey) ? fixture : real);

  return {
    account: (secretKey) => pick(secretKey).account(secretKey),
    customers: (secretKey, params) => pick(secretKey).customers(secretKey, params),
    charges: (secretKey, params) => pick(secretKey).charges(secretKey, params),
    subscriptions: (secretKey, params) =>
      pick(secretKey).subscriptions!(secretKey, params),
  };
}

/**
 * The Stripe restricted-key provider, scoped to one racer.
 *
 * ## Why this takes an owner, and is not memoised globally
 *
 * An earlier version built one provider for the whole process and resolved a
 * credential from whatever `ref` it was handed:
 *
 * ```ts
 * resolveCredential: async (ref) => {
 *   const db = createAdminClient();            // bypasses RLS
 *   … .eq("provider_connection_id", ref)       // no ownership check
 * }
 * ```
 *
 * That is an IDOR waiting for a caller. `resolveCredential` takes an arbitrary
 * id and returns a *decrypted Stripe key*; the admin client means RLS is not
 * standing behind it. Nothing passes a user-controlled `ref` today, because the
 * connect flow is not built — which is precisely why it needed fixing now
 * rather than after something did.
 *
 * Filtering alone would not have been enough: the resolver had no notion of who
 * was asking, so there was nothing to filter *against*. Scoping the provider to
 * a racer makes the check structural — the owner is bound at construction, and
 * the query below cannot return a row belonging to anyone else.
 *
 * The cost is that this is no longer a process-wide singleton. Constructing an
 * adapter is a closure and an object literal; a per-racer instance is not worth
 * caching, and a cache keyed on the owner would be one more thing to get wrong.
 *
 * ## What the vault's binding does and does not do
 *
 * `src/lib/vault/crypto.ts` binds each ciphertext to its connection id via GCM
 * associated data. That is **integrity and correctness, not authorization**: it
 * stops a valid ciphertext being *moved* between rows, and it stops a tampered
 * one opening. It says nothing about whether the caller is entitled to the row,
 * and must never be relied on as though it did. Ownership is the `racer_id`
 * filter below, and nothing else.
 */
export function stripeRestrictedProvider(owner: { racerId: string }): VerificationProvider {
  return createStripeRestrictedKeyAdapter(portFor(owner.racerId), {
    resolveCredential: async (ref) => {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("provider_credentials")
        .select("encrypted_secret, key_version, provider_connections!inner(racer_id)")
        .eq("provider_connection_id", ref)
        // The ownership check. `!inner` turns the embedded resource into a join,
        // so a credential whose connection belongs to another racer matches no
        // row at all — resolution then throws, and the adapter reports a dead
        // credential rather than reading someone else's account.
        .eq("provider_connections.racer_id", owner.racerId)
        .maybeSingle();

      if (error || !data) {
        // Never returns an empty string: that would be sent to Stripe as a
        // credential. Throwing is what the adapter expects. Note that this
        // reports the same way for "another racer's connection" as for "no such
        // connection" — a caller cannot use it to probe which ids exist.
        throw new Error("No stored credential for that connection.");
      }

      return openForConnection(
        { ciphertext: data.encrypted_secret, keyVersion: data.key_version },
        ref,
      );
    },
  });
}
