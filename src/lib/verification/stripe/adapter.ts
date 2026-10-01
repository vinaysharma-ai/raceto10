import type {
  BeginConnectionResult,
  ExternalCustomer,
  ProviderCapabilities,
  ProviderConnection,
  ProviderEvent,
  ProviderPayment,
  ReadWindow,
  VerificationProvider,
} from "../types.ts";

/**
 * The Stripe adapter — racer verification over Stripe Connect.
 *
 * Direction: the racer grants us **read-only** access. No money moves. That is
 * the opposite of the sponsor flow, which is a plain Checkout on our own
 * account, and the two must never share code or credentials.
 *
 * ## Why this depends on a port rather than on the Stripe SDK
 *
 * `StripePort` below is the entire Stripe surface this adapter uses. Two
 * reasons it is a hand-written interface rather than `Pick<Stripe, ...>`:
 *
 *   1. It documents exactly what we depend on, so an SDK upgrade cannot quietly
 *      widen our exposure.
 *   2. It makes the adapter testable without network access or API keys — the
 *      contract suite runs against this with a fake port, exercising every line
 *      of real logic except the HTTP call itself.
 *
 * The return shape of `oauth.token` is also deliberately *narrower* than
 * Stripe's. See the note on `completeConnection`.
 */

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type StripePort = {
  oauth: {
    token(params: {
      grant_type: "authorization_code";
      code: string;
    }): Promise<{
      // Optional, mirroring Stripe's own declaration exactly. Not defensiveness
      // on our part: the SDK is telling us the id can genuinely be absent, so
      // `completeConnection` has to check rather than assert.
      stripe_user_id?: string;
      scope?: string;
      livemode?: boolean;
      // `access_token` is intentionally NOT modelled. It is the connected
      // account's own API key, we never need it, and leaving it out of the type
      // means no future edit can casually start persisting it.
    }>;
    deauthorize(params: {
      client_id: string;
      stripe_user_id: string;
    }): Promise<{ stripe_user_id?: string }>;
  };
  accounts: {
    retrieve(id: string): Promise<{
      id: string;
      email?: string | null;
      business_profile?: { name?: string | null } | null;
      settings?: { dashboard?: { display_name?: string | null } | null } | null;
    }>;
  };
  customers: {
    list(
      params: { limit?: number; created?: { lt?: number } },
      options: { stripeAccount: string },
    ): AsyncIterable<{
      id: string;
      created: number;
      email?: string | null;
      /**
       * `unknown`, not `boolean`, because Stripe types this as `deleted?: void`
       * — a trick it uses so `Customer` and `DeletedCustomer` are separable at
       * the type level. We only ever truthy-check it.
       */
      deleted?: unknown;
    }>;
  };
  charges: {
    list(
      params: { limit?: number; created?: { gte?: number; lt?: number } },
      options: { stripeAccount: string },
    ): AsyncIterable<{
      id: string;
      created: number;
      amount: number;
      currency: string;
      paid: boolean;
      status: string;
      customer?: string | { id: string } | null;
      invoice?: string | { id: string } | null;
    }>;
  };
  webhooks: {
    constructEvent(
      payload: string,
      signature: string,
      secret: string,
    ): { id: string; type: string; account?: string };
  };
};

export type StripeAdapterConfig = {
  /** STRIPE_CONNECT_CLIENT_ID — identifies our platform to Stripe. */
  clientId: string;
  /** STRIPE_CONNECT_WEBHOOK_SECRET — the Connect endpoint's own secret. */
  webhookSecret: string;
  /** Where Stripe sends the browser back to. Must match the dashboard exactly. */
  redirectUri: string;
  /** Overridable so tests need no network and no real client id. */
  authorizeBaseUrl?: string;
};

const DEFAULT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";

// Stripe timestamps are unix SECONDS. Our race boundaries are timestamps with
// millisecond precision, so every comparison is truncated to the second. The
// effect is at most a one-second window at each boundary, and it always errs
// toward NOT counting someone — the honest direction for a product whose whole
// promise is that the number is real.
const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function createStripeAdapter(
  port: StripePort,
  config: StripeAdapterConfig,
): VerificationProvider {
  const capabilities: ProviderCapabilities = {
    // Stripe Connect uses an authorization-code flow with a real consent screen.
    connectionMethod: "oauth",
    consentScreen: true,
    // `read_only` is what we request and what Standard accounts default to. It
    // is the reason this flow is safe to offer in the first place: the racer can
    // see exactly what they are granting, and revoke it.
    credentialScope: "read_only",
    // The platform holds its own token; there is no merchant credential to
    // expire, and nothing for the merchant to rotate.
    credentialExpires: false,
    credentialRotatable: false,
    // We register the Connect webhook endpoint ourselves, so events arrive
    // without the racer configuring anything.
    webhookRegistration: "platform",
    // `created` range filters are supported server-side, so the baseline does
    // not have to page a merchant's entire customer history.
    serverSideDateFilter: true,
    accountScoping: "documented",
  };

  return {
    id: "stripe",
    displayName: "Stripe",
    capabilities,

    async beginConnection({ state }): Promise<BeginConnectionResult> {
      const url = new URL(config.authorizeBaseUrl ?? DEFAULT_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      // Sent explicitly even though `read_only` is the default for Standard
      // accounts. Silently relying on a default is how you later end up
      // silently requesting write access.
      url.searchParams.set("scope", "read_only");
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      return { kind: "redirect", url: url.toString() };
    },

    async completeConnection(params): Promise<ProviderConnection> {
      const code = params.code;
      if (!code) {
        throw new Error(
          "Stripe callback carried no authorization code. The code is single-use " +
            "and expires in 5 minutes, so a racer who paused on the consent " +
            "screen must start the connection again.",
        );
      }

      const token = await port.oauth.token({
        grant_type: "authorization_code",
        code,
      });

      if (!token.stripe_user_id) {
        throw new Error("Stripe returned no connected account id for this code.");
      }

      // The response also carries the connected account's own API key. It is
      // deliberately dropped and never persisted: for a Standard account we act
      // on its behalf using OUR key plus a per-request account header, so
      // storing theirs would add a credential to protect in exchange for
      // nothing. `provider_credential_ref` therefore stays null for Stripe
      // racers (SYSTEM-ARCHITECTURE.md §2).
      return { provider: "stripe", accountId: token.stripe_user_id };
    },

    async validateConnection(connection) {
      try {
        const account = await port.accounts.retrieve(connection.accountId);
        const label =
          account.settings?.dashboard?.display_name ??
          account.business_profile?.name ??
          account.email ??
          undefined;
        return { ok: true, accountLabel: label ?? undefined };
      } catch {
        // A health check reports unhealthy; it does not throw. The caller
        // decides what a dead connection means for the race.
        return { ok: false };
      }
    },

    async revokeConnection(connection) {
      await port.oauth.deauthorize({
        client_id: config.clientId,
        stripe_user_id: connection.accountId,
      });
    },

    async *listCustomers(connection, until): AsyncIterable<ExternalCustomer> {
      const untilSeconds = toSeconds(until);

      const page = port.customers.list(
        { limit: 100, created: { lt: untilSeconds } },
        { stripeAccount: connection.accountId },
      );

      for await (const customer of page) {
        if (customer.deleted) continue;

        const createdAt = new Date(customer.created * 1000);

        // Re-checked here rather than trusted to the API's filter. The baseline
        // is the integrity anchor of the whole product, and a boundary leak of
        // one customer is a boundary leak of the premise.
        if (createdAt >= until) continue;

        yield {
          externalId: customer.id,
          createdAt,
          email: customer.email ?? undefined,
        };
      }
    },

    async *listPayments(connection, window: ReadWindow): AsyncIterable<ProviderPayment> {
      const page = port.charges.list(
        {
          limit: 100,
          created: { gte: toSeconds(window.since), lt: toSeconds(window.until) },
        },
        { stripeAccount: connection.accountId },
      );

      for await (const charge of page) {
        // "A successful, non-zero payment" — SYSTEM-ARCHITECTURE.md §4. A failed
        // or unsettled charge is not a customer, and a zero-amount charge is not
        // a payment.
        if (charge.status !== "succeeded" || !charge.paid) continue;
        if (charge.amount <= 0) continue;

        const customerId =
          typeof charge.customer === "string"
            ? charge.customer
            : (charge.customer?.id ?? null);

        // Guest checkout — a successful charge with no customer record. There is
        // no stable identity to deduplicate on, so counting it would risk
        // counting the same person repeatedly. Excluded by decision, and flagged
        // as such in SYSTEM-ARCHITECTURE.md §13.
        if (!customerId) continue;

        const paidAt = new Date(charge.created * 1000);
        if (paidAt < window.since || paidAt >= window.until) continue;

        yield {
          externalCustomerId: customerId,
          externalPaymentId: charge.id,
          paidAt,
          amountMinor: charge.amount,
          currency: charge.currency,
          kind: charge.invoice ? "subscription" : "one_time",
        };
      }
    },

    async verifyWebhook(rawBody, headers): Promise<ProviderEvent | null> {
      const signature = headers.get("stripe-signature");
      if (!signature) return null;

      try {
        // `rawBody` must be the bytes as received. Verifying a re-serialised
        // object is the classic way to make a signature check pass while
        // accepting tampered payloads — the contract suite has a test for it.
        const event = port.webhooks.constructEvent(
          rawBody,
          signature,
          config.webhookSecret,
        );

        return {
          // For Connect events this is the connected account the event belongs
          // to. The handler maps it back to a racer; the adapter does not.
          id: event.id,
          type: event.type,
          accountId: event.account ?? null,
          raw: event,
        };
      } catch {
        // Any verification failure is a null, never a partially-trusted event.
        return null;
      }
    },
  };
}
