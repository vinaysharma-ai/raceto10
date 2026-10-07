"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { signIn } from "@/app/actions/auth";
import type { ProviderAvailability, SignInProvider } from "@/lib/auth/providers";
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
 * ## Why the pending state has to be able to end
 *
 * A pending state with no exit is a dead page. Two ways this one used to get
 * there, both of which look identical to a founder:
 *
 * - The action settles without leaving. A failed start redirects to
 *   `/join?error=…`, which is a *client-side* navigation to the page already on
 *   screen, so React reconciles this component in place and keeps its state —
 *   the button stays on `Redirecting...` with both buttons disabled. `?error=`
 *   is then a sentence nobody can act on, because there is nothing to press.
 * - The document comes back from the browser's back/forward cache. A founder
 *   who approves at the provider and then presses Back gets the previous
 *   document restored exactly as it was left, pending state included.
 *
 * So the flag is cleared on both: when the action settles with this page still
 * mounted, and when the document is restored rather than freshly loaded. A
 * sign-in that really is in flight is unaffected — the browser leaves for the
 * provider and this component unmounts.
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
  const [chosen, setChosen] = useState<SignInProvider | null>(null);

  const clear = useCallback(() => setChosen(null), []);

  // `persisted` is the browser saying it handed back a cached document rather
  // than loading the page, so nothing is in flight and nothing should look like
  // it is.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clear();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [clear]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <form action={signIn.bind(null, "google", next)}>
        <SubmitButton
          provider="google"
          name="Continue with Google"
          usable={available.google}
          chosen={chosen}
          onChoose={() => setChosen("google")}
          onSettled={clear}
        />
      </form>

      <form action={signIn.bind(null, "x", next)}>
        <SubmitButton
          provider="x"
          name="Continue with X"
          variant="secondary"
          usable={available.x}
          chosen={chosen}
          onChoose={() => setChosen("x")}
          onSettled={clear}
        />
      </form>
    </div>
  );
}

/**
 * One provider's button, rendered inside its own form so `useFormStatus` reports
 * on that form's action rather than on whichever one happens to be nearest.
 *
 * `chosen` is passed down rather than owned here because pressing either button
 * has to disable both.
 */
function SubmitButton({
  provider,
  name,
  variant = "primary",
  usable,
  chosen,
  onChoose,
  onSettled,
}: {
  provider: SignInProvider;
  name: string;
  variant?: "primary" | "secondary";
  usable: boolean;
  chosen: SignInProvider | null;
  onChoose: () => void;
  onSettled: () => void;
}) {
  const { pending } = useFormStatus();
  const seenPending = useRef(false);

  useEffect(() => {
    if (pending) {
      seenPending.current = true;
      return;
    }
    // The action ran, finished, and this page is still mounted — so it settled
    // here rather than navigating to the provider. `seenPending` is what keeps
    // the first render, where the flag is already false, from clearing a
    // pending state that has only just been set.
    if (seenPending.current) {
      seenPending.current = false;
      onSettled();
    }
  }, [pending, onSettled]);

  return (
    <Button
      type="submit"
      variant={variant}
      className="w-full sm:w-auto"
      disabled={chosen !== null || !usable}
      aria-label={usable ? name : `${name}, unavailable right now`}
      onClick={onChoose}
    >
      {chosen === provider ? "Redirecting..." : usable ? name : UNAVAILABLE}
    </Button>
  );
}
