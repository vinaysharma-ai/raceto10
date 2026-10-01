"use server";

import { revalidatePath } from "next/cache";

import { connectionStore, getCurrentRacerId } from "@/lib/queries/provider-connection";
import { stripeKeySchema } from "@/lib/validation/provider";
import { connectProviderAccount } from "@/lib/verification/connect.ts";
import { describeIneligibility } from "@/lib/verification/eligibility.ts";
import { stripeRestrictedProvider } from "@/lib/verification/stripe/restricted-client";

/**
 * Connecting a Stripe account from `/join`.
 *
 * ## The credential's whole journey
 *
 * It arrives in this function's `formData`, is parsed, and is passed to
 * `connectProviderAccount`, which hands it to the adapter for validation and
 * then to the seal. It is never assigned to a variable that outlives the call,
 * never returned, and never logged — including in the `catch` below, where
 * logging the submitted value would be the obvious mistake.
 *
 * A Server Action is the right boundary for this. The value is posted to the
 * server, never held in client state, and there is no route that could echo it
 * back — the form re-renders from the database, which holds only ciphertext.
 *
 * ## Why the provider is constructed per call
 *
 * `stripeRestrictedProvider(owner)` is scoped to one racer, so credential
 * resolution is ownership-checked by construction. That means it cannot be a
 * module-level singleton, and it is cheap enough not to need to be.
 */

export type ProviderState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export async function connectStripe(
  _previous: ProviderState,
  formData: FormData,
): Promise<ProviderState> {
  // Validated before anything else, so malformed input never reaches the
  // provider or the database.
  const parsed = stripeKeySchema.safeParse({ apiKey: formData.get("apiKey") });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check that key and try again.",
    };
  }

  const racerId = await getCurrentRacerId();
  if (!racerId) {
    return {
      status: "error",
      message: "Finish setting up your profile before connecting a payment provider.",
    };
  }

  // Note what is passed here: `racerId` from the session, and the key. No id
  // from the request is involved, so there is nothing for a caller to forge.
  const outcome = await connectProviderAccount(
    connectionStore(),
    stripeRestrictedProvider({ racerId }),
    parsed.data.apiKey,
  );

  if (!outcome.ok) {
    // The message is the adapter's category, written for a person. Nothing from
    // Stripe, and nothing derived from the submitted key, reaches the racer or
    // the log.
    return { status: "error", message: outcome.message };
  }

  revalidatePath("/join");

  const where = outcome.accountLabel ? `${outcome.accountLabel} ` : "your account ";

  // The connection is real and stored. What follows is the entry gate, which is
  // a separate question — a working key on an account that already has
  // customers is a successful connection and a refusal to race.
  switch (outcome.eligibility.status) {
    case "eligible":
      return {
        status: "ok",
        message: `Connected ${where.trim()}. You're starting from 0 customers and $0 MRR.`,
      };

    case "ineligible":
      return {
        status: "error",
        message: describeIneligibility(outcome.eligibility.reason),
      };

    case "unknown":
      // Not a refusal — we could not read enough to decide. Saying "you have
      // customers" here would be a claim we cannot support.
      return { status: "error", message: outcome.eligibility.reason };
  }
}
