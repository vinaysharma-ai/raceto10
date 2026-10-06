import Stripe from "stripe";

import type { StripeRestrictedPort } from "./restricted.ts";

/**
 * The real Stripe port — the only place the SDK is constructed.
 *
 * ## Why this is its own module
 *
 * It used to live inside `restricted-client.ts`, which carries `server-only`
 * because it also touches the vault. That guard is right, and it has a cost: a
 * module importing `server-only` throws the moment it is loaded outside a server
 * component, so nothing else could reach this code.
 *
 * `npm run stripe:probe` needs exactly this and none of the vault. Splitting it
 * out means the probe runs the same port the application runs, rather than a
 * second implementation that could drift from it — which is the only kind of
 * probe worth having.
 *
 * ## What this file does not do
 *
 * No credential is decrypted here and none is stored. It takes a key it is
 * handed and constructs a client from it. Resolution and sealing stay in the
 * client module, on the server side of the boundary.
 */

/**
 * Whether a key is restricted.
 *
 * Stripe prefixes restricted keys `rk_` and full-access secret keys `sk_`. That
 * is the only signal available: the API does not expose a key's permission set,
 * so we cannot ask whether *this* restricted key can write — only that it is the
 * kind of key that was created restricted.
 *
 * Stated plainly because it is a real limit: a racer could create a restricted
 * key and grant it write access on some resource. We would accept it. The
 * alternative — probing for write access by attempting a write — would mean
 * performing the very mutation we are trying to prevent. Refusing anything not
 * prefixed `rk_` is the strongest check that does not itself cause harm.
 */
export function isRestrictedKey(secretKey: string): boolean {
  return secretKey.startsWith("rk_");
}

function labelFor(account: Stripe.Account): string | null {
  return (
    account.settings?.dashboard?.display_name ??
    account.business_profile?.name ??
    account.email ??
    null
  );
}

export function buildPort(): StripeRestrictedPort {
  return {
    async account(secretKey) {
      const stripe = new Stripe(secretKey);

      // `accounts.list` rather than `retrieve`, because newer API versions
      // require an id for `retrieve` — and the id is precisely what we do not
      // have yet. A key belonging to one account sees exactly that account
      // here, so the first row is the answer.
      //
      // It doubles as the validity check: a bad or revoked key fails with a 401
      // before this returns.
      const accounts = await stripe.accounts.list({ limit: 1 });
      const account = accounts.data[0];

      if (!account) {
        // A valid key that can see no account is not something we can connect.
        throw { statusCode: 403 };
      }

      return {
        id: account.id,
        label: labelFor(account),
        canWrite: !isRestrictedKey(secretKey),
      };
    },

    customers(secretKey, params) {
      const stripe = new Stripe(secretKey);

      return stripe.customers.list({
        limit: params.limit ?? 100,
        ...(params.createdLt ? { created: { lt: params.createdLt } } : {}),
      });
    },

    charges(secretKey, params) {
      const stripe = new Stripe(secretKey);

      return stripe.charges.list({
        limit: params.limit ?? 100,
        ...(params.createdGte || params.createdLt
          ? {
              created: {
                ...(params.createdGte ? { gte: params.createdGte } : {}),
                ...(params.createdLt ? { lt: params.createdLt } : {}),
              },
            }
          : {}),
      });
    },

    subscriptions(secretKey, params) {
      const stripe = new Stripe(secretKey);

      return stripe.subscriptions.list({
        limit: params.limit ?? 100,
        status: (params.status ?? "active") as Stripe.SubscriptionListParams["status"],
        // The price is needed to compute MRR, and Stripe does not include an
        // expanded price by default.
        expand: ["data.items.data.price"],
      }) as unknown as ReturnType<NonNullable<StripeRestrictedPort["subscriptions"]>>;
    },
  };
}
