"use client";

import { useActionState } from "react";

import { activate, type ActivationState } from "@/app/actions/activate";
import { Button } from "@/components/ui/button";

/**
 * Starting the clock.
 *
 * ## Why the button is the whole component
 *
 * The server action takes no input — no baseline, no duration, no start time.
 * This form therefore submits nothing, and that is the point: there is no field
 * a founder could edit to change what gets recorded, because the only things
 * that matter are read from their Stripe account and `race_config` at the
 * moment they press it.
 *
 * ## Why the copy is this deliberate
 *
 * The product's promise is that the count is real and the clock is public. A
 * founder should not discover afterwards that the timer started earlier, or
 * that the number they started from was not zero. So the panel states plainly,
 * before the button: what will be verified, what will be recorded, and that the
 * moment is now. Nothing here is reassurance — it is the actual behaviour.
 */

const INITIAL: ActivationState = { status: "idle" };

export function ActivateForm({ durationLabel }: { durationLabel: string | null }) {
  const [state, formAction, pending] = useActionState(activate, INITIAL);

  if (state.status === "ok") {
    // The page revalidates and re-renders into the racing state, so this is
    // only visible for the instant before that lands.
    return (
      <p className="text-small text-text" role="status">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-medium">Start your race</h2>

      <p className="mt-3 max-w-lg text-small text-text prose">
        When you press this, your clock starts. It does not start before, and it
        cannot be started twice.
      </p>

      <ul className="mt-4 flex flex-col gap-2 text-small text-text-muted prose">
        <li>
          We re-read your Stripe account and verify you still have{" "}
          <span className="text-text">0 paying customers and $0 MRR</span>. If
          anything has changed, nothing starts.
        </li>
        <li>
          Your starting count is recorded as{" "}
          <span className="text-text">0</span> — the number we just verified.
          Nothing you gained before this moment is held against you.
        </li>
        <li>
          {durationLabel ? (
            <>
              You then have <span className="text-text">{durationLabel}</span> to
              reach 10 customers.
            </>
          ) : (
            <>You then have the configured race window to reach 10 customers.</>
          )}
        </li>
      </ul>

      {/*
        Required, and labelled with the actual list rather than "I agree to the
        terms". This is the consent that `public_consent_at` records, and every
        public view filters on it — so what the founder is agreeing to should be
        the literal contents of their public row, not a link to a policy.
      */}
      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="consent"
          value="yes"
          required
          className="mt-0.5 h-4 w-4 shrink-0 accent-text"
        />
        <span className="text-small text-text-muted prose">
          Race in public. The board will show my name, X handle, product name,
          approximate location and verified customer count. My email and my
          Stripe details are never shown.
        </span>
      </label>

      {state.status === "error" ? (
        <p className="mt-4 text-small text-text" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className="mt-6">
        <Button type="submit" disabled={pending}>
          {pending ? "Verifying and starting…" : "Start my race"}
        </Button>
      </div>
    </form>
  );
}
