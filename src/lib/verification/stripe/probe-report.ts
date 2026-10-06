/**
 * The parts of `npm run stripe:probe` worth testing.
 *
 * The script itself is I/O — read stdin, build a client, call Stripe, print.
 * What can go wrong in a way that matters is the deciding: which keys are
 * refused and why, and what is safe to print. Both live here, pure, so a test
 * can exercise every branch without a network or a key.
 *
 * ## Never the payload
 *
 * The rule this file exists to enforce: when a Stripe response cannot be read,
 * say *which field* was missing or the wrong type. Never echo the response.
 * A charge object carries the customer's id, an amount, a description that
 * often contains a person's name, and sometimes a receipt address. It is
 * somebody else's data, and a probe run is not a reason to move it into a
 * terminal.
 */

/**
 * Why a key may not be probed, or null.
 *
 * ## Test mode only
 *
 * This refuses `rk_live_` outright. The probe is a diagnostic that prints a
 * count of paying customers from a real account — run against a live key it
 * would print a real founder's business to whoever is at the terminal. Test mode
 * exists precisely so this can be exercised without that, and the same rule the
 * product already applies to itself ("reject `rk_test_` in production") points
 * the other way here.
 *
 * `sk_` and `pk_` are refused by name rather than as malformed, because the
 * person who pasted one needs to know what they actually handed over — a
 * full-access key, or a publishable one — not that it failed a pattern.
 *
 * The order matters. `rk_live_` is checked before the general restricted-key
 * test, so a live restricted key gets the message about live mode rather than
 * passing as "restricted".
 */
export function probeRefusal(secretKey: string): string | null {
  const key = secretKey.trim();

  if (!key) return "No key was read. Paste a restricted test key and press Ctrl+Z then Enter.";

  if (key.startsWith("pk_")) {
    return "That is a publishable key. It cannot read anything, and it is not secret — it ships in every browser. Use a restricted test key.";
  }

  if (key.startsWith("sk_")) {
    return "That is a full-access secret key. It can move money and read every customer. The probe only ever needs a restricted key, and it refuses this one.";
  }

  if (key.startsWith("rk_live_")) {
    return "That is a live restricted key. This probe is test mode only, because it prints a real account's customer count to your terminal. Use an rk_test_ key.";
  }

  if (!key.startsWith("rk_test_")) {
    // Anything else. Not named specifically because there is nothing specific to
    // say: it is not a key shape this product recognises at all.
    return "That is not a restricted test key. Restricted test keys start with rk_test_.";
  }

  return null;
}

/**
 * The first line of an input stream, trimmed, or the empty string.
 *
 * ## Why this is here and not in the script
 *
 * Reading stdin is the one piece of the probe that cannot be exercised by
 * running it: the script is a process, and a test that spawned one would be
 * testing Node's readline rather than this decision. Taking the stream as an
 * argument makes the decision — take one line, trim it, treat "no line at all"
 * as empty rather than as a crash — ordinary code with an ordinary test.
 *
 * The empty case is the one that matters. Pressing Ctrl+Z and Enter on Windows,
 * or Ctrl+D on a POSIX shell, closes stdin without a newline; a naive
 * implementation returns undefined and the refusal reads "undefined is not a
 * restricted test key", which is both wrong and confusing.
 */
export async function firstLine(lines: AsyncIterable<string>): Promise<string> {
  for await (const line of lines) return line.trim();
  return "";
}

/**
 * The masked account reference.
 *
 * Stripe account ids are `acct_` plus a random body. The prefix identifies the
 * kind of thing it is, and the last four are enough to tell two of your own
 * accounts apart. The middle is the part that is a stable identifier for a real
 * business, and there is no reason to print it.
 */
export function maskAccountId(id: string): string {
  if (id.length <= 12) return `${id}…`;
  return `${id.slice(0, 7)}…${id.slice(-4)}`;
}

/**
 * Where a malformed object went wrong.
 *
 * Returns a sentence naming the field and the type that was expected — and
 * nothing else. Called with the value that failed; the caller never passes the
 * surrounding object, so there is no path by which a payload reaches the output.
 */
export function describeShape(what: string, value: unknown, expected: string): string {
  if (value === undefined || value === null) {
    return `${what} is missing (expected ${expected}).`;
  }
  const actual = Array.isArray(value) ? "array" : typeof value;
  return `${what} is ${actual} (expected ${expected}).`;
}

export type ProbeCounts = {
  keyMode: "test";
  account: string;
  eligible: boolean;
  reason: string | null;
  payingCustomers: number;
  chargesConsidered: number;
  refundedExcluded: number;
  withoutCustomer: number;
};

/**
 * The report, as lines.
 *
 * Counts and one masked reference. No customer id, no charge id, no amount, no
 * currency, no description — the probe answers "would this account qualify and
 * roughly what is in it", and every one of those other fields belongs to
 * somebody.
 */
export function probeLines(counts: ProbeCounts): string[] {
  return [
    `key mode            test`,
    `account             ${counts.account}`,
    `eligible            ${counts.eligible ? "yes" : "no"}`,
    ...(counts.reason ? [`reason              ${counts.reason}`] : []),
    `paying customers    ${counts.payingCustomers}`,
    `charges considered  ${counts.chargesConsidered}`,
    `refunded, excluded  ${counts.refundedExcluded}`,
    `no customer id      ${counts.withoutCustomer}`,
  ];
}
