"use client";

import { useState } from "react";

import { signIn } from "@/app/actions/auth";
import type { ProviderAvailability } from "@/lib/auth/providers";
import { Button } from "@/components/ui/button";

/**
 * The two ways in.
 *
 * ## Rendered from the project's own settings
 *
 * A provider the Supabase project has not switched on cannot complete a
 * sign-in, so its button is rendered disabled rather than left to fail. The
 * label says what is true: this is unavailable right now, not broken, and not
 * something the founder did.
 *
 * Both buttons carry the provider name in `aria-label` because the visible
 * label is replaced by the unavailable notice, and two identical disabled
 * buttons tell assistive tech nothing.
 *
 * ## Why this is a client component
 *
 * Sign-in leaves the page: the action asks the provider for a URL and then
 * redirects to it. That round trip takes as long as the network takes, and a
 * button that looks untouched the whole time is indistinguishable from one that
 * did nothing. A visitor who thinks a button is broken presses it again.
 *
 * So the click sets a pending state immediately: the button that was pressed
 * says `Redirecting...`, and both are disabled. Disabling the other one matters
 * as much as showing the first — starting a second sign-in while the first is
 * in flight is how someone ends up with two half-finished sessions.
 *
 * The forms are still real forms posting to a server action, so this works
 * while the JavaScript is still loading; the pending state is the only part
 * that needs it.
 *
 * No provider logos. They would be the only images on the site, they carry
 * trademark conditions, and the labels already say which is which.
 */

const UNAVAILABLE = "Unavailable right now";

export function SignInButtons({
  next = "/join",
  available,
}: {
  next?: string;
  available: ProviderAvailability;
}) {
  const [chosen, setChosen] = useState<string | null>(null);

  const label = (provider: "google" | "x", name: string, usable: boolean) => {
    if (chosen === provider) return "Redirecting...";
    if (!usable) return UNAVAILABLE;
    return name;
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <form action={signIn.bind(null, "google", next)}>
        <Button
          type="submit"
          className="w-full sm:w-auto"
          disabled={chosen !== null || !available.google}
          aria-label={
            available.google
              ? "Continue with Google"
              : "Continue with Google, unavailable right now"
          }
          onClick={() => setChosen("google")}
        >
          {label("google", "Continue with Google", available.google)}
        </Button>
      </form>

      <form action={signIn.bind(null, "x", next)}>
        <Button
          type="submit"
          variant="secondary"
          className="w-full sm:w-auto"
          disabled={chosen !== null || !available.x}
          aria-label={
            available.x ? "Continue with X" : "Continue with X, unavailable right now"
          }
          onClick={() => setChosen("x")}
        >
          {label("x", "Continue with X", available.x)}
        </Button>
      </form>
    </div>
  );
}
