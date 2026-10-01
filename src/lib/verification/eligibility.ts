/**
 * The entry gate: 0 paying customers and $0 MRR.
 *
 * Pure. The counting happens elsewhere; this decides what the counts mean, so
 * the rule can be tested against every shape of input without a database or a
 * provider.
 *
 * ## Why "unknown MRR" is not "zero MRR"
 *
 * A Stripe key can be restricted away from subscriptions while still reading
 * customers and charges. MRR is derived from subscriptions, so such a key cannot
 * report it at all.
 *
 * Treating that as zero would let a racer with a hundred subscribers and no
 * one-off charges pass the gate — the exact person the gate exists to stop.
 * Refusing instead is the conservative direction, and it is honest: we say we
 * could not check rather than claiming they qualify.
 */

/** Customers that existed before the race window. The baseline count. */
export type EligibilityFacts = {
  /** How many paying customers the account already had. */
  existingCustomers: number;
  /**
   * Monthly recurring revenue in minor units. `null` means it could not be
   * determined — which is not the same as zero.
   */
  mrrMinor: number | null;
};

export type IneligibleReason =
  | "has_customers"
  | "has_mrr"
  | "mrr_unknown";

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason };

/**
 * Decides entry.
 *
 * Order matters for the message the racer reads, not for the outcome: someone
 * with customers *and* MRR is told they have customers, because that is the
 * fact they can act on. Both are disqualifying either way.
 */
export function checkEligibility(facts: EligibilityFacts): Eligibility {
  if (facts.existingCustomers > 0) {
    return { eligible: false, reason: "has_customers" };
  }

  if (facts.mrrMinor === null) {
    // Checked after customers so that a racer who plainly fails on the count
    // is not told about a permission problem with their key.
    return { eligible: false, reason: "mrr_unknown" };
  }

  if (facts.mrrMinor > 0) {
    return { eligible: false, reason: "has_mrr" };
  }

  return { eligible: true };
}

/**
 * The sentence a racer reads.
 *
 * Written here rather than in the component so that every surface — the join
 * page, an email, the eventual dashboard — says the same thing about the same
 * refusal. A gate whose explanation varies by where you read it is a gate people
 * reasonably distrust.
 */
export function describeIneligibility(reason: IneligibleReason): string {
  switch (reason) {
    case "has_customers":
      return "This account already has paying customers, so it can't enter. RaceTo10 is for products starting from zero.";
    case "has_mrr":
      return "This account already has recurring revenue, so it can't enter. RaceTo10 is for products starting from zero.";
    case "mrr_unknown":
      return "We couldn't read your subscription data, so we can't confirm you're starting from $0 MRR. Add Subscriptions → Read to your restricted key and try again.";
  }
}
