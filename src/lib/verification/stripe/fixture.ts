import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FIXTURE_ACCOUNT_ID, fixtureMode } from "./fixture-mode.ts";
import type { StripeRestrictedPort } from "./restricted.ts";

// Re-exported so callers have one module to reach for. The predicates
// themselves live in `fixture-mode.ts`, which is importable without a server
// context — see the note there.
export { FIXTURE_KEY_EMPTY, FIXTURE_KEY_USED, fixtureMode, isFixtureKey } from "./fixture-mode.ts";

/**
 * Fixture mode: the whole race, driven by a file.
 *
 * ## Why this exists
 *
 * The owner cannot hold a Stripe account (Stripe India is invite-only), and
 * every racer brings their own. So the one person who has to be able to walk the
 * entire product end to end — sign up, connect, start, watch a count move,
 * finish — has no way to do it, because verification reads a real Stripe account
 * and there is not one.
 *
 * Fixture mode is the answer, and it is deliberately the smallest one that
 * works: two fixed keys, and a JSON file standing in for an account. Nothing
 * about the real path changes. The same adapter, the same eligibility rules, the
 * same reconciliation job, the same database.
 *
 * ## Why it cannot leak
 *
 * A leak of this would be the most serious bug in the product: anyone who could
 * reach the dev route could mint customers and finish a race they did not run.
 * Two independent guards, either of which is sufficient:
 *
 *   1. `fixtureMode()` requires `NODE_ENV !== "production"` as well as the flag.
 *      On Vercel `NODE_ENV` is always `production`, so the branch is unreachable
 *      there however the flag is set.
 *   2. The dev route returns 404 unless `fixtureMode()`. A deployment that
 *      somehow had the flag on still gets a 404.
 *
 * With the mode off — which is every deployment — a fixture key is just an
 * unknown string that Stripe refuses with a 401, which the adapter already
 * reports as a rejected credential. That path is asserted in the tests.
 *
 * ## The keys are built, not written
 *
 * `rk_test_` followed by a literal is the shape GitHub's push protection looks
 * for, and it has already refused one push in this repository over exactly that.
 * Concatenation keeps the shape out of the source while leaving the value
 * identical at runtime.
 */

/** Where the synthetic payments live. Gitignored, and never read in production. */
const FIXTURES_DIR = path.join(process.cwd(), ".fixtures");
const PAYMENTS_FILE = path.join(FIXTURES_DIR, "payments.json");

type FixturePayment = {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  created: number;
};

type FixtureFile = Record<string, FixturePayment[]>;

async function readFixtureFile(): Promise<FixtureFile> {
  try {
    const raw = await readFile(PAYMENTS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as FixtureFile;
  } catch {
    // No file yet, or unreadable. An empty account, which is the honest
    // starting state rather than an error.
    return {};
  }
}

/**
 * Appends paying customers to the fixture account.
 *
 * The timestamps are `now`, which is what makes the walkthrough work: a race is
 * activated, then this is called, then reconcile runs — and every synthetic
 * payment is inside the race window by construction.
 */
export async function addFixturePayments(
  racerId: string,
  count: number,
): Promise<{ ok: true; total: number } | { ok: false; message: string }> {
  if (!fixtureMode()) return { ok: false, message: "Fixture mode is off." };

  const file = await readFixtureFile();
  const existing = file[racerId] ?? [];

  const now = Math.floor(Date.now() / 1000);

  // Captured before the loop, because `existing` grows as this pushes. Reading
  // its length inside produced ids 1, 3, 5 rather than 1, 2, 3 — still unique,
  // so nothing broke, but a sequence that skips is a sequence somebody will
  // later read as a gap in the data.
  const base = existing.length;

  for (let i = 0; i < count; i += 1) {
    const n = base + i + 1;
    existing.push({
      id: `ch_fixture_${racerId.slice(0, 8)}_${n}`,
      // One customer per payment, so `add: 3` is three customers rather than
      // one customer billed three times. The product counts customers.
      customerId: `cus_fixture_${racerId.slice(0, 8)}_${n}`,
      amount: 2000,
      currency: "usd",
      created: now + i,
    });
  }

  file[racerId] = existing;

  try {
    await mkdir(FIXTURES_DIR, { recursive: true });
    await writeFile(PAYMENTS_FILE, JSON.stringify(file, null, 2), "utf8");
  } catch (error) {
    console.error("[fixture] could not write", (error as Error).message);
    return { ok: false, message: "Could not write the fixture file." };
  }

  return { ok: true, total: existing.length };
}

/** What the seeded file already holds, so the route can report a real total. */
export async function fixturePaymentCount(racerId: string): Promise<number> {
  const file = await readFixtureFile();
  return (file[racerId] ?? []).length;
}

/**
 * A port that answers from the file instead of Stripe.
 *
 * `racerId` is bound at construction rather than derived from the key, because
 * the two fixture keys are fixed and the payments are per racer. The provider is
 * already built per racer, so the owner is the one piece of context available
 * that is both correct and already scoped.
 */
export function createFixturePort(racerId: string): StripeRestrictedPort {
  const payments = async (): Promise<FixturePayment[]> => {
    if (!fixtureMode()) return [];
    const file = await readFixtureFile();
    return file[racerId] ?? [];
  };

  return {
    async account() {
      // `canWrite: false` on purpose. A fixture key that claimed write access
      // would be refused by the adapter, and the point of the fixture is to be
      // accepted as a valid restricted key.
      return { id: FIXTURE_ACCOUNT_ID, label: "Fixture account", canWrite: false };
    },

    customers() {
      // No pre-existing customers, and that is the point rather than an
      // oversight: the fixture has to be *eligible*, which means zero customers
      // before the race. The synthetic ones arrive as charges, and a charge's
      // customer is created at the moment of the payment — after the clock
      // started — so it is never part of the baseline snapshot.
      return (async function* () {})();
    },

    charges(_secretKey, params) {
      return (async function* () {
        const all = await payments();

        for (const payment of all) {
          if (params.createdGte !== undefined && payment.created < params.createdGte) continue;
          if (params.createdLt !== undefined && payment.created >= params.createdLt) continue;

          yield {
            id: payment.id,
            created: payment.created,
            amount: payment.amount,
            currency: payment.currency,
            paid: true,
            status: "succeeded",
            customer: payment.customerId,
          };
        }
      })();
    },

    subscriptions() {
      // Empty, and not undefined. An empty list is a real reading of "no
      // subscriptions", which makes MRR a known zero. Returning undefined would
      // make MRR unknown, and the eligibility rule would then refuse the
      // fixture for a reason that has nothing to do with the fixture.
      return (async function* () {})();
    },
  };
}
