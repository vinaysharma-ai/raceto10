// Reads a Stripe restricted TEST key from stdin and reports what the real
// verification path would make of that account.
//
//   npm run stripe:probe
//
// ## Read-only, in the strong sense
//
// It writes nothing to the database, stores no credential, and seals nothing.
// The key lives in this process's memory for the length of the run, is never
// written to disk, never passed as an argument — where it would land in shell
// history and in the process list — and never echoed. It is read from stdin, and
// stdin alone.
//
// ## The real adapter, not a copy
//
// It builds the same port the application builds (`buildPort`) and runs it
// through the same adapter (`createStripeRestrictedKeyAdapter`). The prefix
// rules, the refund exclusion, the customer-identity rule, the MRR maths and the
// pagination guards are therefore the ones that actually run in production. A
// probe that reimplemented any of that would only prove the reimplementation
// works.
//
// ## What it prints
//
// Counts, one masked account reference, and whether the account would qualify.
// Never a customer id, a charge id, an amount or a description: this is somebody
// else's business. When a response cannot be read, the field and the expected
// type are named — the payload never is.

import { createInterface } from "node:readline";

import { checkEligibility } from "../src/lib/verification/eligibility.ts";
import { buildPort } from "../src/lib/verification/stripe/port.ts";
import {
  describeShape,
  firstLine,
  maskAccountId,
  probeLines,
  probeRefusal,
} from "../src/lib/verification/stripe/probe-report.ts";
import { createStripeRestrictedKeyAdapter } from "../src/lib/verification/stripe/restricted.ts";

/**
 * One line from stdin.
 *
 * Node cannot reliably suppress console echo on Windows, so this does not claim
 * to: the line is read, used, and never printed. Never printing is the guarantee
 * that holds everywhere, and hidden input would be a bonus that works on some
 * terminals.
 */
async function readKey(): Promise<string> {
  process.stderr.write("Paste a restricted TEST key (rk_test_...), then press Enter:\n");

  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    // One line, and stop reading. `firstLine` is in `probe-report.ts` so the
    // empty-stdin case has a test rather than a hope.
    return await firstLine(rl);
  } finally {
    rl.close();
  }
}

async function main() {
  const key = await readKey();

  const refusal = probeRefusal(key);
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const port = buildPort();

  const adapter = createStripeRestrictedKeyAdapter(port, {
    // The key is already in this process and there is nothing sealed to look up.
    // The adapter takes a *reference* so the application path cannot hand it a
    // value by accident; this is the one caller with nothing to resolve.
    resolveCredential: async () => key,
  });

  // --- The account ---------------------------------------------------------
  let account;
  try {
    account = await adapter.completeConnection({ apiKey: key });
  } catch (error) {
    // The adapter reduces provider failures to categories before they reach
    // here, so this is a category — never Stripe's own text, which quotes the
    // key back at you.
    const reason =
      error && typeof error === "object" && "reason" in error
        ? String((error as { reason: unknown }).reason)
        : "unavailable";
    console.error(`Stripe refused the key: ${reason}.`);
    process.exitCode = 1;
    return;
  }

  if (typeof account.accountId !== "string" || account.accountId.length === 0) {
    console.error(describeShape("the account id", account.accountId, "a string"));
    process.exitCode = 1;
    return;
  }

  // The adapter identifies the connection by reference; there is no stored row
  // here, so the reference is a literal this run made up.
  const connection = {
    provider: adapter.id,
    accountId: account.accountId,
    credentialRef: "probe",
  };

  // --- The product's own count ---------------------------------------------
  //
  // Read through the adapter, so "paying customer" means what it means in the
  // product: succeeded, paid, above zero, not fully refunded, distinct by
  // customer. This is the number the gate would use.
  const customers = new Set<string>();
  let considered = 0;

  try {
    for await (const payment of adapter.listPayments(connection, {
      since: new Date(0),
      until: new Date(),
    })) {
      considered += 1;
      customers.add(payment.externalCustomerId);
    }
  } catch {
    console.error("Could not read charges. The key may lack Read on Charges.");
    process.exitCode = 1;
    return;
  }

  // --- What the filter dropped ---------------------------------------------
  //
  // Measured from the port, because the adapter does not report its own
  // exclusions and should not grow a diagnostics channel so that this script can
  // ask. These two are descriptions of what was skipped, not the rule that
  // decided it — that stays in one place.
  const dropped = await countDropped(port, key);

  // --- MRR -----------------------------------------------------------------
  let mrrMinor: number | null = null;
  if (adapter.readMonthlyRecurringRevenue) {
    try {
      const mrr = await adapter.readMonthlyRecurringRevenue(connection);
      mrrMinor = mrr.known ? mrr.mrrMinor : null;
    } catch {
      // Left null, which eligibility treats as "unknown" rather than as zero.
      // The distinction is the whole reason `MrrReading` has a `known` flag.
      mrrMinor = null;
    }
  }

  const verdict = checkEligibility({
    existingCustomers: customers.size,
    mrrMinor,
  });

  for (const line of probeLines({
    keyMode: "test",
    account: maskAccountId(account.accountId),
    eligible: verdict.eligible,
    reason: verdict.eligible ? null : verdict.reason,
    payingCustomers: customers.size,
    chargesConsidered: considered,
    refundedExcluded: dropped.refunded,
    withoutCustomer: dropped.noCustomer,
  })) {
    console.log(line);
  }
}

/**
 * How many charges were refunded, and how many had no customer.
 *
 * Reads the raw list rather than the adapter's, because the adapter's job is to
 * return what counts and a filtered list cannot describe what it removed.
 */
async function countDropped(
  port: ReturnType<typeof buildPort>,
  secretKey: string,
): Promise<{ refunded: number; noCustomer: number }> {
  let refunded = 0;
  let noCustomer = 0;

  try {
    for await (const charge of port.charges(secretKey, {})) {
      if (charge.refunded === true) refunded += 1;
      if (charge.customer === null || charge.customer === undefined) noCustomer += 1;
    }
  } catch {
    // Zero, not a failure. The main count already succeeded, and a diagnostics
    // pass that could not run must not invalidate it.
    return { refunded: 0, noCustomer: 0 };
  }

  return { refunded, noCustomer };
}

await main();
