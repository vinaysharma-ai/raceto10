"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { JOIN_CLOSED_REFUSAL, joinOpen } from "@/lib/join/gate.ts";
import { consume, describeLimit } from "@/lib/queries/rate-limit";
import { connectionStore, getCurrentRacerId } from "@/lib/queries/provider-connection";
import { stripeKeySchema } from "@/lib/validation/provider";
import { connectProviderAccount, disconnectProviderAccount } from "@/lib/verification/connect.ts";
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

/**
 * Disconnecting, from the ready state.
 *
 * Deliberately not gated on `JOIN_OPEN`. The switch closes new connections; it
 * has nothing to say about a founder removing one, and a switch that also
 * trapped people in a connection they wanted to undo would be the wrong shape
 * of switch.
 *
 * A Server Action with no arguments and no form fields, so there is nothing for
 * a caller to name. Which connection to remove is resolved from the session.
 */
export async function disconnectStripe(): Promise<void> {
  const outcome = await disconnectProviderAccount(connectionStore(), "stripe");

  if (!outcome.ok) {
    // `no_connection` and `no_racer` both mean the state the caller wanted is
    // already the state they are in, so the page they land on is correct and
    // there is nothing to say. `already_racing` cannot be reached from a button
    // that is only rendered before activation.
    console.error("[provider] disconnect did not complete", { reason: outcome.reason });
  }

  revalidatePath("/join");
  redirect("/join");
}

export async function connectStripe(
  _previous: ProviderState,
  formData: FormData,
): Promise<ProviderState> {
  // --- The launch switch ---------------------------------------------------
  //
  // First, before validation, before the rate limit, before anything reads the
  // submitted key at all. The page hides the form when this is closed, so
  // reaching here means either a stale tab or a hand-made request — and in both
  // cases the key must not be parsed, not counted, not sent to Stripe and not
  // sealed. The value is never touched.
  if (!joinOpen()) {
    return { status: "error", message: JOIN_CLOSED_REFUSAL };
  }

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

  // --- The rate limit ------------------------------------------------------
  //
  // Counted here rather than earlier because the subject is the racer, and
  // earlier rather than later because every attempt past this point makes us
  // call Stripe with a key somebody else chose. That is the only step in this
  // product where a loop costs a third party real money.
  //
  // Fails closed. A limiter that opens when its own storage is broken is not a
  // limiter, and the operation behind it is a network call to Stripe. The cost
  // of refusing during an outage is that somebody retries; the cost of the
  // other direction is unbounded.
  const limit = await consume("stripeKeyVerify", racerId, { failClosed: true });
  if (!limit.allowed) {
    return { status: "error", message: describeLimit(limit.retryAfterMs) };
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
