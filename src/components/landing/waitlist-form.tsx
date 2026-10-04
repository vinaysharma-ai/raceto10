"use client";

import { useActionState, useEffect, useState } from "react";

import { joinWaitlist, type WaitlistState } from "@/app/actions/waitlist";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HONEYPOT_FIELD } from "@/lib/validation/waitlist";

/**
 * Waitlist capture — email plus the one qualifying question.
 *
 * ## The heading had to change, and why
 *
 * It used to read "Get told when races open". Races are open: `/join` takes a
 * founder through Stripe and starts their clock today. A heading promising
 * notification of something that has already happened is exactly the kind of
 * small falsehood this product cannot afford, and it was the last piece of
 * pre-launch copy left on a page that is now post-launch.
 *
 * What is left is honest: this is for someone who is interested and not ready
 * to connect a payment provider yet, and the one message it promises is a single
 * note when the next race opens.
 *
 * ## The ten second deadline
 *
 * A server action that never answers leaves the button disabled and the page
 * looking frozen, which reads as "it worked" to nobody. After ten seconds the
 * form says it does not know whether the address was saved, because it does
 * not — claiming either outcome would be a guess. If the action does answer
 * afterwards, its own state replaces the message.
 */

const INITIAL: WaitlistState = { status: "idle" };

/** How long a submission may run before the form stops pretending to know. */
const TIMEOUT_MS = 10_000;

/** Display labels for the `customer_band` values. */
const BANDS = [
  { value: "0", label: "None yet" },
  { value: "1-5", label: "1 to 5" },
  { value: "6+", label: "6 or more" },
];

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, INITIAL);
  const [timedOut, setTimedOut] = useState(false);

  // Only ever sets state from the timer, and only while a submission is in
  // flight. The flag is cleared when the next one starts rather than from the
  // effect, so there is no render where a stale timeout is on screen.
  useEffect(() => {
    if (!pending) return;

    const timer = setTimeout(() => setTimedOut(true), TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const done = state.status === "ok" || state.status === "duplicate";

  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-12">
      <div className="rounded-card border border-border bg-surface p-6">
        {done ? (
          <p className="text-small text-text" role="status">
            {state.status === "duplicate"
              ? "You're already on the list."
              : "You're on the list."}
          </p>
        ) : (
          <form
            action={formAction}
            className="relative"
            onSubmit={() => setTimedOut(false)}
          >
            <h2 className="text-medium">Not ready to race yet?</h2>
            <p className="mt-2 max-w-lg text-small text-text-muted prose">
              Leave your email and we&apos;ll write once, when the next race
              opens. No newsletter.
            </p>

            <div className="mt-6 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="email" className="text-small text-text-muted">
                  Email
                </label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="max-w-sm"
                />
              </div>

              <fieldset>
                <legend className="text-small text-text-muted">
                  How many paying customers do you have right now?
                </legend>

                <div className="mt-2 flex flex-wrap gap-2">
                  {BANDS.map((band) => (
                    <label key={band.value} className="cursor-pointer">
                      <input
                        type="radio"
                        name="customersNow"
                        value={band.value}
                        required
                        className="peer sr-only"
                      />
                      {/* Checked is a fill and a text change; focus is a border
                          change. With no accent colour left, "selected" has to
                          be carried by contrast rather than by hue. */}
                      <span className="inline-flex h-9 items-center rounded-pill border border-border px-4 text-small text-text-muted transition-colors peer-checked:bg-text peer-checked:text-bg peer-focus-visible:border-text">
                        {band.label}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            {state.status === "error" ? (
              <p className="mt-4 text-small text-text" role="alert">
                {state.message}
              </p>
            ) : null}

            {timedOut && pending ? (
              <p className="mt-4 text-small text-text" role="alert">
                This is taking longer than it should, and we don&apos;t know yet
                whether your email was saved. Try again in a moment.
              </p>
            ) : null}

            <div className="mt-6">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Join the waitlist"}
              </Button>
            </div>

            {/* Honeypot: off-screen, never focusable, invisible to a human. */}
            <div
              className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
              aria-hidden="true"
            >
              <label htmlFor={HONEYPOT_FIELD}>Company</label>
              <input
                id={HONEYPOT_FIELD}
                name={HONEYPOT_FIELD}
                type="text"
                tabIndex={-1}
                autoComplete="off"
              />
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
