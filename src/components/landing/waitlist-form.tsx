"use client";

import { useActionState } from "react";

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
 * to connect a payment provider yet. The body says plainly that nothing is sent
 * yet, because nothing in V1 sends mail — the success state has always been
 * careful not to promise a message, and the introduction now matches it.
 */

const INITIAL: WaitlistState = { status: "idle" };

/** Display labels for the `customer_band` values. */
const BANDS = [
  { value: "0", label: "None yet" },
  { value: "1-5", label: "1 to 5" },
  { value: "6+", label: "6 or more" },
];

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, INITIAL);

  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-12">
      <div className="rounded-card border border-border bg-surface p-6">
        {state.status === "ok" ? (
          <p className="text-small text-text">You&apos;re on the list.</p>
        ) : (
          <form action={formAction} className="relative">
            <h2 className="text-medium">Not ready to race yet?</h2>
            <p className="mt-2 max-w-lg text-small text-text-muted prose">
              Leave your email and we&apos;ll be able to reach you. Nothing is
              sent yet — there is no newsletter, and you will not get mail from
              this.
            </p>

            <div className="mt-6 flex flex-col gap-4">
              <div>
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
                  className="mt-2 max-w-sm"
                />
              </div>

              <fieldset>
                <legend className="text-small text-text-muted">
                  How many paying customers do you have right now?
                </legend>

                <div className="mt-3 flex flex-wrap gap-2">
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

            <div className="mt-6">
              <Button type="submit" disabled={pending}>
                Join the waitlist
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
