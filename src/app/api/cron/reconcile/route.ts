import { NextResponse, type NextRequest } from "next/server";

import { cronEnv } from "@/lib/env.server";
import { reconciliationStore } from "@/lib/queries/reconciliation";
import { reconcileActiveRacers } from "@/lib/race/reconcile.ts";
import { stripeRestrictedProvider } from "@/lib/verification/stripe/restricted-client";
import { secretsMatch } from "@/lib/vault/crypto.ts";

/**
 * The reconciliation poll.
 *
 * `00` §50: restricted Stripe keys cannot deliver webhooks, so verification
 * polls. This is the poll.
 *
 * ## Why it lives under `/api`
 *
 * `proxy.ts` excludes `api/` from its matcher, which matters here for a reason
 * that has nothing to do with sessions: the proxy causes Next.js to buffer the
 * whole request body in memory, capped at 10 MB, and past the cap it
 * **silently truncates**. A scheduled job has no body to truncate, but keeping
 * every machine-facing endpoint in one excluded place is what stops the next
 * one from being added elsewhere by accident.
 *
 * ## Why it takes no racer
 *
 * It reconciles every active racer. There is no id in the request, so there is
 * nothing for a caller to point at a specific person, and no way to use the
 * endpoint to probe who exists.
 *
 * ## The one thing it must not do
 *
 * Trust the caller. The secret is compared in constant time — a plain `===`
 * short-circuits on the first differing byte, which is a slow but real way to
 * recover a secret one character at a time.
 */

export const dynamic = "force-dynamic";

/** Bound on a single invocation, so a slow provider cannot hang the schedule. */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  let secret: string;
  try {
    secret = cronEnv().CRON_SECRET;
  } catch {
    // Misconfiguration, not an unauthorised caller. Reported as unavailable
    // rather than 401 so the cause is not mistaken for a bad credential.
    console.error("[cron] CRON_SECRET is not configured");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!presented || !secretsMatch(presented, secret)) {
    // No detail. A rejected caller learns only that it was rejected.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // A factory, so every credential resolution is still scoped to the racer it
    // belongs to. Building one unowned provider instead would be the obvious
    // shortcut and would silently resolve nothing — the ownership filter would
    // compare against an empty id and match no row.
    const summary = await reconcileActiveRacers(
      reconciliationStore(),
      (racerId) => stripeRestrictedProvider({ racerId }),
      new Date(),
    );

    // Counts only. Never a credential, never a provider response, never a
    // racer's email — this endpoint's output is a log line.
    return NextResponse.json({
      considered: summary.considered,
      reconciled: summary.reconciled,
      advanced: summary.advanced,
      finished: summary.finished.length,
      failures: summary.failures.length,
    });
  } catch {
    // Category only. The error's text can be a provider's, and a provider's
    // message can quote a credential back.
    console.error("[cron] reconcile failed", { code: "failed" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
