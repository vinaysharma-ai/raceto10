"use server";

import { revalidatePath } from "next/cache";

import { profileSchema } from "@/lib/validation/profile";

/**
 * Finishing a profile after OAuth.
 *
 * ## Why this writes with the user's session, not the service role
 *
 * The callback uses the service role because the row does not exist yet and
 * there is no session policy that could authorise creating it. Here the
 * situation is the opposite: the row exists, and the founder is signed in.
 *
 * So this goes through the ordinary session client and lets the database decide.
 * `20260928120300` gives `authenticated` a SELECT on `profiles` and an UPDATE
 * limited to four columns, behind a policy requiring `id = auth.uid()`. That
 * means the ownership check is enforced by PostgreSQL rather than by a `where`
 * clause written here — a bug in this file cannot make one founder edit
 * another's profile, because the policy would refuse it.
 *
 * The column grant matters too. `deleted_at` and `updated_at` are outside it,
 * so a founder cannot clear a deletion flag we set, and cannot rewrite their own
 * `id` to hand the row to somebody else.
 *
 * ## Reading the result
 *
 * A denied UPDATE is not an error in PostgREST — it affects zero rows and
 * returns success. So the update selects the id back and the row count is
 * checked. No row means the write did not land, whatever the status code said.
 */

export type ProfileState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export async function completeProfile(
  _previous: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    xHandle: formData.get("xHandle"),
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };
  }

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();

    // Re-validated against the auth server rather than read from the cookie.
    // This id is what the update is scoped to, so it is worth the round trip.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { status: "error", message: "Your session expired. Sign in again." };
    }

    const { name, xHandle, email } = parsed.data;

    const { data, error } = await supabase
      .from("profiles")
      .update({
        // `name` is the only nullable one. Sending null would clear a name the
        // founder already has, so an empty field leaves the column alone.
        ...(name ? { name } : {}),
        x_handle: xHandle,
        email,
      })
      .eq("id", user.id)
      .select("id");

    if (error) {
      console.error("[profile] save failed", error.message);
      return {
        status: "error",
        message: "We couldn't save that just now. Try again in a moment.",
      };
    }

    if (!data || data.length === 0) {
      // The policy refused it, or the row is gone. Either way nothing was
      // written, and saying "saved" would be a lie the founder would discover
      // the next time they looked at the board.
      console.error("[profile] save affected no rows", { userId: user.id });
      return {
        status: "error",
        message: "We couldn't save that just now. Try again in a moment.",
      };
    }

    // The page rendered the old values; without this the founder sees their
    // submission apparently revert.
    revalidatePath("/join");

    return { status: "ok", message: "Saved." };
  } catch (error) {
    console.error("[profile] save threw", error);
    return {
      status: "error",
      message: "We couldn't save that just now. Try again in a moment.",
    };
  }
}
