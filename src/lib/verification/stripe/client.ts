import "server-only";

import Stripe from "stripe";

import { stripeConnectEnv } from "@/lib/env.server";

import type { VerificationProvider } from "../types.ts";
import { createStripeAdapter, type StripePort } from "./adapter.ts";

/**
 * Production wiring for the Stripe adapter — the only file in the verification
 * module that touches the Stripe SDK or reads a secret.
 *
 * Keeping this separate from `adapter.ts` is what lets the contract suite run
 * against the adapter with a fake port: no SDK, no network, no keys. Everything
 * except the HTTP call itself is the real implementation.
 */

function buildPort(secretKey: string): StripePort {
  // One client, configured with the platform's key. Reads against a connected
  // account pass `stripeAccount` per request rather than using a per-account
  // client — so there is no client object that could be cached against the
  // wrong account and leak one racer's data into another's race.
  const stripe = new Stripe(secretKey);

  return {
    oauth: {
      token: (params) => stripe.oauth.token(params),
      deauthorize: (params) => stripe.oauth.deauthorize(params),
    },
    accounts: {
      retrieve: (id) => stripe.accounts.retrieve(id),
    },
    customers: {
      list: (params, options) => stripe.customers.list(params, options),
    },
    charges: {
      list: (params, options) => stripe.charges.list(params, options),
    },
    webhooks: {
      constructEvent: (payload, signature, secret) =>
        stripe.webhooks.constructEvent(payload, signature, secret),
    },
  };
}

/**
 * Whether the Connect configuration is present, without throwing.
 *
 * Used by `/join` to decide whether to show the entry form at all. The
 * alternative — rendering a form whose submit can only fail — is the kind of
 * dead end this project has been removing, and a visitor cannot act on a
 * missing environment variable anyway.
 */
export function stripeConnectConfigured(): boolean {
  try {
    stripeConnectEnv();
    return true;
  } catch {
    return false;
  }
}

let cached: VerificationProvider | null = null;

/**
 * The Stripe verification provider, built from server-only config.
 *
 * Memoised, so the SDK client and the validated env are not rebuilt per call.
 * Throws if the Connect configuration is incomplete — deliberately, and at the
 * point of use rather than at import, so the landing page and sponsor flow are
 * not blocked on payment keys they never touch.
 */
export function stripeConnectProvider(): VerificationProvider {
  if (cached) return cached;

  const config = stripeConnectEnv();

  cached = createStripeAdapter(buildPort(config.STRIPE_SECRET_KEY), {
    clientId: config.STRIPE_CONNECT_CLIENT_ID,
    webhookSecret: config.STRIPE_CONNECT_WEBHOOK_SECRET,
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/connect/stripe/callback`,
  });

  return cached;
}
