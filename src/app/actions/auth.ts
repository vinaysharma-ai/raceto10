"use server";

import { redirect } from "next/navigation";

/**
 * Ending a session.
 *
 * ## Where signing in went
 *
 * Sign-in no longer starts here. It starts in the browser, in
 * `src/components/auth/sign-in.tsx`, for two reasons: the PKCE code verifier
 * belongs to the browser that will present it, and a server action that
 * redirects to an external URL leaves the document it was called from in place
 * — which is what left both buttons disabled on `Redirecting...` with no way
 * back. The rate limit that used to live here is now
 * `POST /api/auth/start-check`, asked before the browser leaves.
 *
 * `/auth/callback` still finishes the job on the server, unchanged.
 *
 * What is left is the half that genuinely belongs on a server: ending a session
 * writes cookies, and only a server action can do that.
 */
export async function signOut(): Promise<void> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
