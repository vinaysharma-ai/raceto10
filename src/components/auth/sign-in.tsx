"use client";

import { useState } from "react";

import { signIn } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * The two ways in.
 *
 * ## Why this is a client component now
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

type Provider = "google" | "twitter";

export function SignInButtons({ next = "/join" }: { next?: string }) {
  const [chosen, setChosen] = useState<Provider | null>(null);

  const label = (provider: Provider, text: string) =>
    chosen === provider ? "Redirecting..." : text;

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <form action={signIn.bind(null, "google", next)}>
        <Button
          type="submit"
          className="w-full sm:w-auto"
          disabled={chosen !== null}
          onClick={() => setChosen("google")}
        >
          {label("google", "Continue with Google")}
        </Button>
      </form>

      <form action={signIn.bind(null, "twitter", next)}>
        <Button
          type="submit"
          variant="secondary"
          className="w-full sm:w-auto"
          disabled={chosen !== null}
          onClick={() => setChosen("twitter")}
        >
          {label("twitter", "Continue with X")}
        </Button>
      </form>
    </div>
  );
}
