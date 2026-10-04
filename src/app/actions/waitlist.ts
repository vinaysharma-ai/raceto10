"use server";

import { addWaitlistSignup } from "@/lib/queries/waitlist";
import { HONEYPOT_FIELD, waitlistSchema } from "@/lib/validation/waitlist";

/**
 * The landing page's only write.
 *
 * Note what is *not* here: the browser never touches `waitlist_signup` itself.
 * `anon` holds no grant on that table, so a direct client insert is impossible
 * by construction rather than by policy — which is what stops the publishable
 * key from becoming an open spam endpoint.
 *
 * A `"use server"` module may only export async functions, so no constants live
 * here; the initial form state is defined alongside the component that uses it.
 */

export type WaitlistState =
  | { status: "idle" }
  | { status: "ok" }
  /**
   * Already on the list. Its own state so the form can say so plainly.
   *
   * SECURITY: this state exists only because the address was submitted, and it
   * reveals that the address is stored. See the note on the return below before
   * extending it.
   */
  | { status: "duplicate" }
  | { status: "error"; message: string };

export async function joinWaitlist(
  _previous: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  // Honeypot. Accept silently rather than rejecting — telling a bot it was
  // caught only teaches whoever wrote it to stop filling this field in.
  const trap = formData.get(HONEYPOT_FIELD);
  if (typeof trap === "string" && trap.length > 0) {
    return { status: "ok" };
  }

  const parsed = waitlistSchema.safeParse({
    email: formData.get("email"),
    customersNow: formData.get("customersNow"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };
  }

  const result = await addWaitlistSignup(parsed.data);

  if (!result.ok) return { status: "error", message: result.message };

  // A repeat submission is reported as a repeat rather than folded into the
  // success state, because the form has to answer a returning visitor
  // truthfully: "you are already on the list" and "you are on the list" are the
  // same fact, but only one of them tells them not to wonder whether it worked.
  //
  // The cost is real and is not papered over here. This makes an unauthenticated
  // form submission answer "is this address on the list?" with a yes or a no,
  // which `addWaitlistSignup` used to collapse deliberately. **Nothing in this
  // path throttles it** — the per-IP limiter is planned for the safety pass and
  // does not exist yet, so there is currently no bound on how many addresses can
  // be tested. What keeps the exposure small is only that waitlist membership is
  // not a secret worth harvesting, and that no other data is reachable from it.
  // If that stops being true, this is the line that has to change.
  return result.duplicate ? { status: "duplicate" } : { status: "ok" };
}
