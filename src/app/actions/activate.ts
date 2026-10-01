"use server";

import { revalidatePath } from "next/cache";

import { activationStore } from "@/lib/queries/activation";
import { getCurrentRacerId } from "@/lib/queries/provider-connection";
import { activateRacer } from "@/lib/race/activate.ts";
import { stripeRestrictedProvider } from "@/lib/verification/stripe/restricted-client";

/**
 * Starting a racer's clock.
 *
 * ## What this action does not accept
 *
 * No baseline, no duration, no start time, no racer id. The form submits
 * nothing; the only inputs are the session and the clock. That is the whole
 * protection against a client choosing its own starting position — there is no
 * parameter for one to travel in, so the check cannot be forgotten at a call
 * site rather than being written here.
 *
 * The duration is read from `race_config` at the moment of activation, so a
 * founder who connects today and starts next week races for whatever the window
 * is *then*.
 *
 * ## Why the provider is constructed per call
 *
 * `stripeRestrictedProvider(owner)` is scoped to one racer so credential
 * resolution is ownership-checked by construction, which rules out a
 * module-level singleton.
 */

export type ActivationState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export async function activate(
  _previous: ActivationState,
  formData: FormData,
): Promise<ActivationState> {
  // The only thing this action reads from the request, and the only thing it
  // could: a founder's agreement to race in public. Everything that determines
  // the race — baseline, count, start, end, duration — is read server-side from
  // the provider and `race_config`, so there is no field here that could change
  // them. Note the checkbox is compared to the exact string a checked box
  // submits, so `undefined`, `"false"` and a missing field all mean "no".
  const consent = formData.get("consent") === "yes";

  const racerId = await getCurrentRacerId();
  if (!racerId) {
    return {
      status: "error",
      message: "Finish setting up your profile before starting your race.",
    };
  }

  const outcome = await activateRacer(
    activationStore(),
    stripeRestrictedProvider({ racerId }),
    consent,
    new Date(),
  );

  if (!outcome.ok) {
    return { status: "error", message: outcome.message };
  }

  revalidatePath("/join");
  revalidatePath("/leaderboard");
  revalidatePath("/");

  if (outcome.alreadyActive) {
    return { status: "ok", message: "Your race is already running." };
  }

  // The window is the racer's own, derived from their activation — not a shared
  // batch boundary. Stated in the copy because that is the product's promise.
  const days = outcome.durationDays;
  return {
    status: "ok",
    message: `Your clock has started. You have ${days} day${days === 1 ? "" : "s"} to reach 10 customers.`,
  };
}
