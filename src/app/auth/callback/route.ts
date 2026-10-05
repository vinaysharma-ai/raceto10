import { NextResponse, type NextRequest } from "next/server";

import { ensureProfile } from "@/lib/auth/profile";
import { safeRedirectPath } from "@/lib/auth/identity";

/**
 * Where Google and X send the browser back to.
 *
 * ## The order
 *
 * 1. Exchange the authorization code for a session. Supabase does the token
 *    work; we never see a provider token.
 * 2. Ask Supabase who the user is. `getUser()` re-validates against the auth
 *    server rather than trusting the cookie — which matters here, because the
 *    id from this call is what every later write is keyed on.
 * 3. Create or fill the profile, keyed strictly on that id.
 * 4. Redirect to a same-site path only.
 *
 * ## Why the redirect target is validated
 *
 * `next` arrives in the query string. A callback that forwards wherever it says
 * is an open redirect — a way to land a freshly authenticated founder on
 * somebody else's page with our domain as the referrer. `safeRedirectPath`
 * accepts a same-site path and nothing else.
 *
 * This route is NOT excluded from `proxy.ts` — it is served at `/auth/callback`
 * and the matcher only excludes `api/` and static assets. That is fine: the
 * proxy's refresh finds no session before the exchange and does nothing, and
 * this is a GET with no body, so the 10 MB buffer that file exists to avoid is
 * not in play. An earlier comment here claimed the route sat under `/api`.
 */

export const dynamic = "force-dynamic";

function backToJoin(request: NextRequest, reason: string) {
  const url = new URL("/join", request.nextUrl.origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The provider reports a refusal here — a founder clicking "cancel" on the
  // consent screen. A decision, not a failure, and it gets its own sentence
  // because "you cancelled" and "it did not work" call for different next
  // steps: one is fine to walk away from, the other is worth retrying.
  if (params.get("error")) {
    return backToJoin(
      request,
      params.get("error") === "access_denied" ? "declined" : "signin_failed",
    );
  }

  const code = params.get("code");
  if (!code) return backToJoin(request, "signin_failed");

  const next = safeRedirectPath(params.get("next"));

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth] code exchange failed", error.message);
      return backToJoin(request, "signin_failed");
    }

    // Re-validated against the auth server, not read from the cookie. This id
    // is the only thing the profile write is keyed on, so it is worth the
    // round trip.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return backToJoin(request, "signin_failed");

    const ensured = await ensureProfile(user);
    if (!ensured.ok) return backToJoin(request, "signin_failed");

    return NextResponse.redirect(new URL(next, request.nextUrl.origin));
  } catch (error) {
    console.error("[auth] callback failed", error);
    return backToJoin(request, "signin_failed");
  }
}
