import { NextResponse, type NextRequest } from "next/server";

import { postToResend, sendStartEmail } from "@/lib/email/start-email.ts";
import { env } from "@/lib/env";
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
 * is where the founder agreed to race in public. The batch passes `true` â€” not
 * as a bypass, but because the agreement was recorded at registration and this
 * endpoint has no business asking a second time. A racer who never consented has
 * no `public_consent_at`, and `beginActivation` writes that timestamp from the
 * value the profile step stored.
 */

export const dynamic = "force-dynamic";

/**
 * Sends the start email, or reports why it did not.
 *
 * Returns a category and never throws, because the caller has already started a
 * race and nothing here is allowed to change that. `email_sent_at` is written
 * only on success, so a skipped or failed attempt is retried by the next batch
 * run â€” which is only true because the run that skipped it left the column
 * alone.
 *
 * A racer who was already emailed is not emailed again. That is what stops a
 * batch re-run from sending the same founder the same message every time the
 * owner runs it.
 */
async function tryStartEmail(
  store: ReturnType<typeof activationStore>,
  racerId: string,
): Promise<"sent" | "skipped" | "failed" | "already"> {
  try {
    const context = await store.loadEmailContext(racerId);
    if (!context) return "failed";

    // Already sent on an earlier run. Not an error and not a skip.
    if (context.emailSentAt) return "already";

    const outcome = await sendStartEmail(
      { post: postToResend, env: process.env },
      {
        to: context.email,
        productName: context.productName,
        daysLeft: context.raceEndAt ? daysUntil(context.raceEndAt, new Date()) : null,
        publicUrl: context.publicSlug
          ? new URL(`/r/${context.publicSlug}`, env.NEXT_PUBLIC_APP_URL).toString()
          : null,
      },
    );

    if (outcome.status === "sent") {
      await store.markEmailSent(racerId, new Date());
      return "sent";
    }

    if (outcome.status === "failed") {
      // The category only. Resend's body echoes the recipient address.
      console.error("[email] start email failed", { code: outcome.reason });
    }

    return outcome.status;
  } catch {
    console.error("[email] start email threw", { code: "storage_error" });
    return "failed";
  }
}

/** Whole days remaining, floored. */
function daysUntil(end: Date, now: Date): number {
  return Math.max(0, Math.floor((end.getTime() - now.getTime()) / 86_400_000));
}

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
    let emailed = 0;
    let emailSkipped = 0;
    let emailFailed = 0;

    for (const racerId of ids) {
      try {
        // Scoped to this racer: the batch has no session, and a store that
        // resolved the racer from one would activate whoever happened to be
        // signed in â€” or nobody.
        const store = activationStore(racerId);

        const outcome = await activateRacer(
          store,
          // A factory, so every credential resolution is still scoped to the
          // racer it belongs to.
          stripeRestrictedProvider({ racerId }),
          true,
        );

        if (outcome.ok) {
          activated += 1;

          // --- The start email, after the clock is running ----------------
          //
          // Deliberately after, and deliberately unable to affect the outcome.
          // `beginActivation` has already committed; an email that fails must
          // not turn a started race into a reported failure.
          const email = await tryStartEmail(store, racerId);
          if (email === "sent") emailed += 1;
          else if (email === "skipped") emailSkipped += 1;
          else if (email === "failed") emailFailed += 1;
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

    return NextResponse.json({
      activated,
      skipped,
      emailed,
      emailSkipped,
      emailFailed,
    });
  } catch {
    console.error("[admin] activation batch failed", { code: "failed" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
