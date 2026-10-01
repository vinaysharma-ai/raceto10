/**
 * The verification provider contract — SYSTEM-ARCHITECTURE.md §14.
 *
 * Racer verification is a capability, not a Stripe feature. Stripe is one way to
 * provide it; Lemon Squeezy is another, and they are not equivalent. This file
 * is the boundary. Everything below it is provider-shaped; everything above it
 * consumes `ProviderPayment` and `ExternalCustomer` and never learns which
 * provider it is talking to.
 *
 * ## The rule this contract exists to enforce
 *
 * Nothing in `engine/` may import from `stripe/` or `lemonsqueezy/`, or branch
 * on a provider id. If the engine needs something this interface cannot express,
 * the interface is extended — the engine does not reach around it. There is a
 * test that enforces this mechanically.
 *
 * ## Note on typing style
 *
 * Unions and `as const` objects, deliberately not TypeScript `enum`s. These
 * files are executed directly by Node's built-in test runner, which strips types
 * but cannot transform enums. Keeping to erasable syntax means the contract
 * suite runs with zero build step and zero test dependencies.
 */

export type ProviderId = "stripe" | "lemonsqueezy";

/** A customer on the connected account, reduced to what counting needs. */
export type ExternalCustomer = {
  /**
   * The provider's own customer identifier. Opaque: stored and compared, never
   * parsed, and never assumed to have the same shape across providers.
   */
  externalId: string;
  /** When the customer first existed. This is what makes a baseline a baseline. */
  createdAt: Date;
  email?: string;
};

/**
 * Monthly recurring revenue, or an honest account of why it is unknown.
 *
 * ## Why this is not `number`
 *
 * `0` and "we cannot tell" are different answers, and eligibility turns on the
 * difference. A restricted key can be scoped away from subscriptions while
 * still reading customers and charges; MRR is derived from subscriptions, so
 * such a key cannot report it. Returning `0` there would let someone with a
 * hundred subscribers pass a gate that exists to stop exactly them.
 *
 * The union forces every caller to handle the unknown case rather than
 * defaulting it to zero somewhere a reviewer will not look.
 */
export type MrrReading =
  | { known: true; mrrMinor: number; currency: string }
  /** `unsupported` means the credential cannot see subscriptions at all. */
  | { known: false; reason: "unsupported" | "unavailable" };

/** The only shape the race engine ever consumes. */
export type ProviderPayment = {
  externalCustomerId: string;
  externalPaymentId: string;
  /** When the payment succeeded. Compared against the race window. */
  paidAt: Date;
  /** Minor units — cents. Never a float. */
  amountMinor: number;
  currency: string;
  kind: "one_time" | "subscription";
};

/**
 * An established connection. Carries a credential *reference*, never a value —
 * a raw credential must not be able to travel through this layer at all.
 */
export type ProviderConnection = {
  provider: ProviderId;
  /** Stripe's connected account id, Lemon Squeezy's store id, etc. */
  accountId: string;
  /** Human-readable label for confirmation UI, if the provider offers one. */
  accountLabel?: string;
  /** An id into Vault. Never the credential itself. */
  credentialRef?: string;
  /** Set when the provider's credential expires and needs replacing. */
  expiresAt?: Date;
};

/**
 * What a provider can actually do. Declared as data so the UI and the
 * reconciliation job branch on capabilities rather than on a provider id, and
 * so the differences between providers are visible instead of remembered.
 *
 * These are the differences that make Lemon Squeezy unable to be presented as a
 * like-for-like alternative to Stripe Connect. The contract test suite asserts
 * that every adapter's declarations are internally consistent, because a
 * capability descriptor that lies is worse than none.
 */
export type ProviderCapabilities = {
  /** Does the merchant authorize us, or just hand over a credential? */
  connectionMethod: "oauth" | "credential_paste";
  /** Is there a provider-mediated consent screen? */
  consentScreen: boolean;
  /**
   * What the credential we end up holding can do. `read_only` is only
   * achievable through a consent flow — you cannot scope down a pasted key.
   */
  credentialScope: "read_only" | "full_access";
  /** Does the credential expire, requiring the merchant to reconnect? */
  credentialExpires: boolean;
  /** Can we rotate it without the merchant? */
  credentialRotatable: boolean;
  /** Who registers the webhook endpoint. `merchant` means events may never arrive. */
  webhookRegistration: "platform" | "merchant";
  /** Can the provider filter "created after T" server-side, or must we page? */
  serverSideDateFilter: boolean;
  /** Is it documented whether a credential is scoped to one account? */
  accountScoping: "documented" | "unclear";
};

/**
 * How a connection starts. Two genuinely different acts: being redirected to a
 * consent screen, versus being asked to paste a credential that grants far more.
 * They must not share a UI treatment, so they must not share a return type.
 */
export type BeginConnectionResult =
  | { kind: "redirect"; url: string }
  | { kind: "credential"; instructions: string };

/** A verified inbound webhook. `raw` is provider-shaped and stays below the boundary. */
export type ProviderEvent = {
  id: string;
  type: string;
  /** The connected account this event belongs to, when the provider supplies it. */
  accountId: string | null;
  raw: unknown;
};

export type ReadWindow = {
  since: Date;
  until: Date;
};

export interface VerificationProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  // --- connection ---------------------------------------------------------

  /**
   * Starts a connection for a pending racer. For OAuth this returns a URL to
   * redirect to; for a credential provider it returns instructions instead.
   * The caller must not assume which.
   *
   * `state` is passed in rather than generated here, and that is deliberate:
   * the token has to be persisted against the racer row *before* the browser
   * leaves for the provider, because it is the only thing that will let the
   * callback identify which racer is returning. An adapter that minted its own
   * state would have nowhere to store it, and the CSRF guard would be
   * unenforceable. Generation and single-use enforcement are the caller's job;
   * the adapter only has to carry it faithfully.
   */
  beginConnection(input: {
    racerId: string;
    state: string;
  }): Promise<BeginConnectionResult>;

  /**
   * Completes a connection. `params` is whatever the flow produced — an OAuth
   * callback query, or a submitted credential. Provider-shaped by necessity;
   * the result is not.
   */
  completeConnection(
    params: Readonly<Record<string, string>>,
  ): Promise<ProviderConnection>;

  /** Health check. Used before reconciliation, and to detect a dead credential. */
  validateConnection(
    connection: ProviderConnection,
  ): Promise<{ ok: boolean; accountLabel?: string }>;

  /** Best-effort. Some providers have no revoke, and that is a capability fact. */
  revokeConnection(connection: ProviderConnection): Promise<void>;

  // --- reading ------------------------------------------------------------

  /**
   * Customers that existed **strictly before** `until` — the baseline snapshot.
   *
   * Strictly, not inclusively. `until` is `race_start_at`, and a customer created
   * at exactly that instant is a *new* customer, not an existing one. A provider
   * that returns `created == until` as baseline would quietly rob a racer of a
   * genuine customer, so the boundary is exclusive on purpose.
   *
   * Newest-first, so an implementation with no server-side date filter can stop
   * paging as soon as it passes `until` — or, failing that, at least bounds its
   * work to the store's size rather than its lifetime.
   *
   * AsyncIterable rather than Iterable: every real provider paginates over the
   * network, and a sync signature would force a full materialisation before the
   * caller could do anything.
   */
  listCustomers(
    connection: ProviderConnection,
    until: Date,
  ): AsyncIterable<ExternalCustomer>;

  /** Payments inside the window, for reconciliation. Same paging shape. */
  listPayments(
    connection: ProviderConnection,
    window: ReadWindow,
  ): AsyncIterable<ProviderPayment>;

  /**
   * Optional capability: recurring revenue, for the entry gate.
   *
   * Declared optional rather than required because not every credential can
   * answer it — see `MrrReading`. A provider that cannot must leave this
   * undefined rather than implement it as zero, which is the whole reason the
   * return type is a union.
   *
   * A caller must treat an absent method as `{ known: false, reason:
   * "unsupported" }` and never as zero.
   */
  readMonthlyRecurringRevenue?(
    connection: ProviderConnection,
  ): Promise<MrrReading>;

  // --- events (optional capability) ---------------------------------------

  /**
   * Verifies an inbound webhook. Returns null when the signature does not
   * verify — never a partially-trusted event.
   *
   * The body must be the raw bytes as received. Re-serialising before verifying
   * is the classic way to break this.
   */
  verifyWebhook(rawBody: string, headers: Headers): Promise<ProviderEvent | null>;
}
