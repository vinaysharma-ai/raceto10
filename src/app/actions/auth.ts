"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { env } from "@/lib/env";
import { clientIp } from "@/lib/geo";
import { consume } from "@/lib/queries/rate-limit";

/**
 * Starting and ending a session.
 *
 * ## Where the redirect goes
 *
 * `redirectTo` is built here from configuration rather than accepted from the
 * caller. Supabase will only return to a URL on the project's allowlist, but
 * building it server-side means there is no code path in this repository that
 * forwards a user-supplied destination to the provider in the first place.
 *
 * `next` is a path, not a URL, and the callback validates it again on the way
 * back — the two checks are independent on purpose.
 */

/**
 * Supabase's provider id for X is `x`.
 *
 * It was `twitter` — the legacy OAuth 1.0a provider — and that id is what made
 * every attempt to sign in with X land on `Unsupported provider: provider is not
 * enabled`. The OAuth 2.0 provider the dashboard exposes is a different one, and
 * this is its id.
 */
export type SignInProvider = "google" | "x";

const CALLBACK_PATH = "/auth/callback";

function callbackUrl(next: string): string {
  const url = new URL(CALLBACK_PATH, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("next", next);
  return url.toString();
}

/**
 * Begins an OAuth sign-in.
 *
 * ## Linking, when there is already a session
 *
 * If somebody is signed in and picks the *other* provider, this links the
 * identity to their existing account rather than starting a second one.
 * `linkIdentity` requires a live session — which is exactly the property that
 * makes it safe: a founder can only ever attach a provider to the account they
 * are already authenticated as, never to an account they merely claim.
 *
 * Supabase requires "Enable Manual Linking" in the project's auth settings for
 * this to work. Without it the call fails and the founder sees an error rather
 * than a silent no-op.
 */
export async function signIn(provider: SignInProvider, next = "/join"): Promise<void> {
  // --- The rate limit ------------------------------------------------------
  //
  // Per IP, because this runs before there is a session to key on. Twenty an
  // hour, which is far above what a person does and far below what a script
  // driving the provider needs.
  //
  // Fails OPEN, unlike key verification. The operation behind this is a redirect
  // to a provider, not a call to somebody else's paid API, and a database
  // problem should not be the reason nobody can sign in — which would be a
  // worse outage than the one the limit exists to prevent.
  //
  // Refused by redirecting to a fixed reason, which `/join` maps to a sentence.
  // The wait is not carried in the URL: the parameter would be server text
  // reflected into a page, and a fixed sentence is honest without being a
  // channel. `PROBLEMS.too_many` is the wording.
  const limit = await consume("signinStart", clientIp(await headers()), {
    failClosed: false,
  });

  if (!limit.allowed) {
    redirect("/join?error=too_many");
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data, error } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: callbackUrl(next) },
    });

    if (error) {
      // Most often: the identity is already linked, or manual linking is off.
      // Either way the founder is told rather than left on an unchanged page.
      console.error("[auth] linking a provider failed", error.message);
      redirect("/join?error=link_failed");
    }
    if (data?.url) redirect(data.url);
    redirect("/join");
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: callbackUrl(next) },
  });

  if (error || !data.url) {
    // The provider being switched off in the dashboard lands here too. The
    // join page already renders the buttons from the project's own settings, so
    // this is the case where that read was stale or unavailable — and it is
    // still a sentence rather than a JSON body.
    console.error("[auth] sign-in could not start", error?.message);
    redirect("/join?error=signin_failed");
  }

  // Last statement, outside any `try`. `redirect()` works by throwing, so a
  // surrounding catch would turn a successful start into an error message.
  redirect(data.url);
}

/** Ends the session and returns to the board. */
export async function signOut(): Promise<void> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
