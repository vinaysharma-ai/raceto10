import type { ProviderConnection, VerificationProvider } from "./types.ts";

/**
 * Reading an account's current position, for the entry gate.
 *
 * ## This is a gate check, not a baseline
 *
 * The two look similar and are not the same thing. `source: "activation"` in
 * `verification_snapshots` is where the *accurate* baseline is captured, from
 * `listCustomers(connection, raceStartAt)`. This module runs at registration,
 * when there is no race window yet, and answers one question: **has this account
 * already started?**
 *
 * That makes short-circuiting correct here, and it is why `truncated` is
 * reported rather than hidden. The first paying customer settles the gate, so
 * the scan stops — and the count is then a floor, not a total. Storing a floor
 * in a column named `customer_count` would be misleading if anything later read
 * it as a metric, so the flag travels with it and the caller records what it
 * actually means.
 *
 * ## Why paying customers, not customer records
 *
 * A Stripe `Customer` is created by a free signup or an abandoned checkout as
 * readily as by a purchase, so counting records would refuse people who have
 * genuinely never been paid. The race itself counts customers from successful
 * payments, and the gate uses the same rule so that "0 customers" means one
 * thing across the product.
 */

/** Distinct paying customers found, and whether the scan stopped early. */
export type CustomerProbe = {
  count: number;
  /** True when the scan stopped at the first hit — `count` is a floor. */
  truncated: boolean;
};

export type EligibilityFactsRead = {
  payingCustomers: CustomerProbe;
  /** `null` when it could not be determined. Never defaulted to zero. */
  mrrMinor: number | null;
  currency: string | null;
  /** Set when the MRR read failed, for the snapshot's `error_code`. */
  mrrUnavailable: "unsupported" | "unavailable" | null;
};

/**
 * Counts distinct paying customers, stopping at the first.
 *
 * A window from the epoch: everything the account has ever taken. For an
 * account starting from zero this pages the whole (empty) charge history once;
 * for any account with a successful payment it stops inside the first page.
 */
export async function probePayingCustomers(
  provider: VerificationProvider,
  connection: ProviderConnection,
  now: Date,
): Promise<CustomerProbe> {
  const seen = new Set<string>();

  const page = provider.listPayments(connection, {
    since: new Date(0),
    until: now,
  });

  for await (const payment of page) {
    seen.add(payment.externalCustomerId);

    // The gate only asks "any?". Stopping here keeps an established account
    // from paging its entire charge history to learn something the first row
    // already proved.
    return { count: seen.size, truncated: true };
  }

  return { count: seen.size, truncated: false };
}

/**
 * Reads everything the gate needs, never throwing.
 *
 * A provider that cannot report MRR leaves the method undefined; that is
 * `unsupported`, which eligibility refuses on. The alternative — treating an
 * unanswerable question as zero — is the failure this whole path exists to
 * avoid.
 */
export async function readEligibilityFacts(
  provider: VerificationProvider,
  connection: ProviderConnection,
  now: Date = new Date(),
): Promise<EligibilityFactsRead> {
  const customers = await probePayingCustomers(provider, connection, now);

  if (!provider.readMonthlyRecurringRevenue) {
    return {
      payingCustomers: customers,
      mrrMinor: null,
      currency: null,
      mrrUnavailable: "unsupported",
    };
  }

  const mrr = await provider.readMonthlyRecurringRevenue(connection);

  if (!mrr.known) {
    return {
      payingCustomers: customers,
      mrrMinor: null,
      currency: null,
      mrrUnavailable: mrr.reason,
    };
  }

  return {
    payingCustomers: customers,
    mrrMinor: mrr.mrrMinor,
    currency: mrr.currency,
    mrrUnavailable: null,
  };
}
