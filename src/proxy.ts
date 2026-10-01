import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`. The export is `proxy`, and
 * the runtime is Node.js — setting a `runtime` export in this file throws.
 *
 * ## The matcher is the load-bearing part
 *
 * When a proxy file exists, Next.js buffers the request body in memory so both
 * the proxy and the route handler can read it. That buffer is capped at 10 MB,
 * and past the cap it **silently truncates** — the request does not fail, the
 * body is just quietly incomplete. For a webhook that means the signature check
 * fails, and the failure presents as a Stripe or Lemon Squeezy problem rather
 * than a proxy-configuration problem.
 *
 * So every `api/` path is excluded, not only today's routes — a route added
 * later without touching this file must inherit the exclusion rather than
 * silently opt out of it. Static assets are excluded too, since there is
 * nothing for the proxy to do with them.
 *
 * `/auth/callback` is NOT excluded — the matcher excludes `api/`, and the
 * callback is served from `/auth/callback`. This file used to claim otherwise,
 * and the claim was wrong: the route is at `src/app/auth/callback/route.ts`,
 * which Next.js serves at `/auth/callback`, not under `/api`.
 *
 * Leaving it proxied is the correct behaviour and matches Supabase's own SSR
 * setup. The callback performs its own code exchange, and this proxy's
 * `getUser()` on the way in simply finds no session and does nothing. The
 * important part is that the comment now matches the matcher: if a *webhook* is
 * ever added under `/auth/` on the assumption that it inherits the body-buffer
 * exclusion above, it will not, and the signature check will fail for a reason
 * that looks nothing like the cause.
 *
 * ## What it does
 *
 * Refreshes the Supabase session cookie. `@supabase/ssr` splits the auth token
 * across cookies with a short expiry, and something has to write the refreshed
 * pair back — a Server Component cannot set cookies, so without this a founder
 * is signed out roughly every hour with no explanation.
 *
 * The pattern is Supabase's own: create a client, call `getUser()` to trigger
 * the refresh, and copy any cookies it wants to set onto the response. The
 * response object has to be the one the client writes into, or the refreshed
 * cookie is discarded — which is a failure that looks exactly like the bug this
 * code exists to prevent.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // A missing configuration is reported loudly by src/lib/env.ts on any page
  // that renders. Failing here would turn it into a blank screen instead.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser` rather than `getSession`: it re-validates against the auth server
  // and is what actually triggers the refresh. `getSession` reads the cookie
  // and would leave an expired session in place.
  try {
    await supabase.auth.getUser();
  } catch {
    // A refresh that fails is not a reason to fail the page. The visitor is
    // simply treated as signed out, which every caller already handles.
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api/|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
