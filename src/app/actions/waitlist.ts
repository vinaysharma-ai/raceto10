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

  return result.ok
    ? { status: "ok" }
    : { status: "error", message: result.message };
}
