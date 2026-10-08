"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { env } from "@/lib/env";
import type { ProviderAvailability, SignInProvider } from "@/lib/auth/providers";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * The two ways in.
 *
 * ## Rendered from the project's own settings
 *
 * A provider is disabled only when the project's settings say explicitly that
 * it is off. A missing key, an unreadable response or a timed-out request is
 * not a promise that the provider is broken, so none of them disables a
 * button — a wrong "available" costs one sentence, and a wrong "unavailable" is
 * a dead end nobody can argue with.
 *
 * Both buttons carry the provider name in `aria-label` because the visible
 * label is replaced by the unavailable notice, and two identical disabled
 * buttons tell assistive tech nothing.
 *
 * ## Why the browser starts the sign-in
 *
 * This used to post to a server action that called `signInWithOAuth` on the
 * server and then `redirect()`ed to the URL it returned. Two things were wrong
 * with that.
 *
 * The redirect left the same document in place. A failed start redirected to
 * `/join?error=…` — the page already on screen — so React reconciled this
 * component rather than replacing it, the pending flag survived, and both
 * buttons stayed disabled forever. That is the "stuck on Redirecting..." that
 * this rewrite exists to remove.
 *
 * And the PKCE code verifier belongs to the browser that will present it. Start
 * the flow here and the verifier is written to a cookie in the same context the
 * provider will return to. `/auth/callback` is unchanged and still does the
 * exchange.
 *
 * ## What replaced the server action
 *
 * The rate limit moved to `POST /api/auth/start-check`, because a limit inside
 * an action that redirects away cannot report anything to the page it left.
 * It is asked first, it answers `{limited:true}` or nothing else, and anything
 * else — a timeout, a 500, a body we do not recognise — is treated as
 * permission. A limiter that refuses real founders when its own counter is
 * unreachable is a worse outage than the one it prevents.
 *
 * ## Why the pending state has to be able to end
 *
 * Every exit is covered: a start that fails resets the buttons with a sentence,
 * a start that has not finished in eight seconds resets them with a different
 * sentence, and a document restored from the back/forward cache resets them
 * without one. A sign-in that really is in flight is unaffected — the browser
 * leaves for the provider and this component unmounts.
 *
 * ## No provider logos
 *
 * They would be the only images on the site, they carry trademark conditions,
 * and the labels already say which is which.
 */

const UNAVAILABLE = "Unavailable right now";
const FAILED = "Couldn't start sign-in. Try again.";
const SLOW = "Sign-in is taking longer than expected. Try again.";
const LIMITED =
  "That is a lot of sign-in attempts from this address. Wait a little while and try again.";

/** How long the limit check may take before it is treated as permission. */
const CHECK_TIMEOUT_MS = 3000;

/** How long `Redirecting...` may stand before it is admitted to be wrong. */
const SLOW_AFTER_MS = 8000;

const CHECK_URL = "/api/auth/start-check";

export function SignInButtons({
  next = "/join",
  available,
}: {
  next?: string;
  available: ProviderAvailability;
}) {
  const [chosen, setChosen] = useState<SignInProvider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Which attempt is current.
   *
   * `chosen` cannot do this job: an attempt in flight holds the value it closed
   * over, so it would happily finish and navigate the page *after* the pending
   * state was taken back — by the eight-second reset, by a restored document,
   * or by a second press. Bumping this on every reset and every new attempt
   * makes a late arrival see that it is no longer the one being waited for, and
   * leave the page alone.
   */
  const attempt = useRef(0);

  const reset = useCallback((message: string | null) => {
    attempt.current += 1;
    setChosen(null);
    setNotice(message);
  }, []);

  // `persisted` is the browser saying it handed back a cached document rather
  // than loading the page, so nothing is in flight and nothing should look like
  // it is. This goes through `reset` rather than clearing the flag directly:
  // the document came back because the founder stopped waiting, and an attempt
  // still in flight would otherwise navigate the page out from under them the
  // moment it finished.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reset(null);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [reset]);

  // The last exit. If the browser has neither left nor complained in eight
  // seconds, the honest label is no longer "Redirecting..." and the honest
  // state is a button that can be pressed again.
  useEffect(() => {
    if (chosen === null) return;
    const timer = setTimeout(() => reset(SLOW), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [chosen, reset]);

  const start = useCallback(
    async (provider: SignInProvider) => {
      if (chosen !== null) return;

      const mine = (attempt.current += 1);
      setChosen(provider);
      setNotice(null);

      try {
        const response = await fetch(CHECK_URL, {
          method: "POST",
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });

        if (response.ok) {
          const body: unknown = await response.json();
          if ((body as { limited?: unknown } | null)?.limited === true) {
            reset(LIMITED);
            return;
          }
        }
      } catch {
        // Unreachable is not a refusal. Fall through and start the sign-in.
      }

      // The check took long enough that the founder has been given the page
      // back. Whatever this attempt was going to do, it is not what is being
      // waited for any more.
      if (attempt.current !== mine) return;

      const redirectTo = new URL("/auth/callback", env.NEXT_PUBLIC_APP_URL);
      redirectTo.searchParams.set("next", next);

      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: redirectTo.toString(),
          // Return the URL instead of navigating, so the failure branch below
          // is reachable at all. Left on, a provider that could not be reached
          // would leave this page with no way to say so.
          skipBrowserRedirect: true,
        },
      });

      if (error || !data?.url) {
        reset(FAILED);
        return;
      }

      if (attempt.current !== mine) return;

      // The provider leaves this document; the pending state goes with it.
      window.location.assign(data.url);
    },
    [chosen, next, reset],
  );

  const label = (provider: SignInProvider, name: string, usable: boolean) => {
    if (chosen === provider) return "Redirecting...";
    if (!usable) return UNAVAILABLE;
    return name;
  };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="button"
          className="w-full sm:w-auto"
          disabled={chosen !== null || !available.google}
          aria-label={
            available.google
              ? "Continue with Google"
              : "Continue with Google, unavailable right now"
          }
          onClick={() => void start("google")}
        >
          {label("google", "Continue with Google", available.google)}
        </Button>

        <Button
          type="button"
          variant="secondary"
          className="w-full sm:w-auto"
          disabled={chosen !== null || !available.x}
          aria-label={
            available.x ? "Continue with X" : "Continue with X, unavailable right now"
          }
          onClick={() => void start("x")}
        >
          {label("x", "Continue with X", available.x)}
        </Button>
      </div>

      {/* `role="status"` so the sentence is announced rather than only shown:
          the person who needs it is the one who just pressed a button and got
          nothing. */}
      {notice ? (
        <p role="status" className="mt-3 text-small text-text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
