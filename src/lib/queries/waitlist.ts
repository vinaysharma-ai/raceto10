import { createAdminClient } from "@/lib/supabase/admin";
import type { WaitlistInput } from "@/lib/validation/waitlist";

/**
 * The waitlist write.
 *
 * Requires the service role, because `anon` holds no grant on
 * `waitlist_signup` at all — a browser-writable waitlist is an open spam
 * endpoint, and the migration revokes the privilege rather than relying on a
 * policy someone might later relax.
 *
 * The read side lives in `founder-count.ts`, deliberately separate so it can be
 * tested without the service key in the import graph.
 */

export type SignupResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; message: string };

const UNAVAILABLE = "We couldn't save that just now. Try again in a moment.";

export async function addWaitlistSignup(input: WaitlistInput): Promise<SignupResult> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("waitlist_signup")
      .insert({ email: input.email, customers_now: input.customersNow });

    if (!error) return { ok: true };

    // 23505 is a unique violation on the email. Reported as success on purpose:
    // from the person's side they are on the list either way, and a distinct
    // "you already signed up" response would confirm to anyone who guesses an
    // address that we hold it.
    if (error.code === "23505") return { ok: true, duplicate: true };

    return { ok: false, message: UNAVAILABLE };
  } catch {
    // Reached when the service key is missing, the database is unreachable, or
    // the migration has not been applied. The visitor gets a plain message; the
    // detail is not theirs to see.
    return { ok: false, message: UNAVAILABLE };
  }
}
