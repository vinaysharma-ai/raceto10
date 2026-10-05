import { NextResponse, type NextRequest } from "next/server";

import { cronEnv } from "@/lib/env.server";
import { activationStore, readyRacerIds } from "@/lib/queries/activation";
import { activateRacer } from "@/lib/race/activate.ts";
import { stripeRestrictedProvider } from "@/lib/verification/stripe/restricted-client";
import { secretsMatch } from "@/lib/vault/crypto.ts";

/**
 * Starting everybody who is waiting.
 *
 * ## Why this is a batch and not a button
 *
 * Activation is the moment a race becomes public and a clock starts, and the
 * product treats that as one instant the owner chose rather than whenever the
 * first founder happened to press something. So the switch lives here, behind
 * the cron secret, and the self-start control in the UI is off unless
 * `ALLOW_SELF_START` is exactly `true`.
 *
 * ## The secret
 *
 * Compared in constant time. A plain `===` short-circuits on the first differing
 * byte, which is a slow but real way to recover a secret one character at a
 * time. A missing secret is reported as 503 rather than 401, so a
 * misconfiguration is never mistaken for a rejected caller.
 *
 * ## Failure is per racer
 *
 * One founder's dead key must not stop everybody else's clock. Each is activated
 * in its own right and the outcome is summarised; a racer who could not be
 * started is named in `skipped` with the reason, never silently dropped. A
 * second run is safe: `beginActivation` is a compare-and-set, so a racer who
 * started on the first run is not started again.
 *
 * ## Consent is checked, and is not a form field here
 *
 * `activateRacer` takes the consent flag as an argument because the profile step
 * is where the founder agreed to race in public. The batch passes `true` — not
 * as a bypass, but because the agreement was recorded at registration and this
 * endpoint has no business asking a second time. A racer who never consented has
 * no `public_consent_at`, and `beginActivation` writes that timestamp from the
 * value the profile step stored.
 */

export const dynamic = "force-dynamic";

/** Bound on a single invocation, so a slow provider cannot hang the batch. */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let secret: string;
  try {
    secret = cronEnv().CRON_SECRET;
  } catch {
    console.error("[admin] CRON_SECRET is not configured");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!presented || !secretsMatch(presented, secret)) {
    // No detail. A rejected caller learns only that it was rejected.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const ids = await readyRacerIds();

    const skipped: { id: string; reason: string }[] = [];
    let activated = 0;

    for (const racerId of ids) {
      try {
        const outcome = await activateRacer(
          // Scoped to this racer: the batch has no session, and a store that
          // resolved the racer from one would activate whoever happened to be
          // signed in — or nobody.
          activationStore(racerId),
          // A factory, so every credential resolution is still scoped to the
          // racer it belongs to.
          stripeRestrictedProvider({ racerId }),
          true,
        );

        if (outcome.ok) {
          activated += 1;
        } else {
          // Named, not counted. An owner running this needs to know which
          // founder is stuck and why, and the reason is already a category
          // rather than a provider's text.
          skipped.push({ id: racerId, reason: outcome.reason });
        }
      } catch {
        // One racer's failure is not the batch's failure. The id is included
        // because it is an internal uuid the owner already holds, and without
        // it there is nothing to investigate.
        skipped.push({ id: racerId, reason: "storage_error" });
      }
    }

    // The email is Phase 8 and nothing sends yet, so nothing can have failed.
    // The field is here because the shape is the contract the owner's script
    // reads, and it is honest at zero: zero attempts, zero failures.
    return NextResponse.json({ activated, skipped, emailFailed: 0 });
  } catch {
    console.error("[admin] activation batch failed", { code: "failed" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
