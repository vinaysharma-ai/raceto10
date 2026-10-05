"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { readRequestGeo, roundCoordinate } from "@/lib/geo";
import { ensureRegisteredRacer } from "@/lib/queries/racer-registration";
import { profileSchema } from "@/lib/validation/profile";

/**
 * Finishing the profile, which is the same act as registering.
 *
 * ## Why this writes with the user's session, not the service role
 *
 * The callback uses the service role because the profile row does not exist yet
 * and there is no session policy that could authorise creating it. Here the
 * situation is the opposite: the row exists and the founder is signed in.
 *
 * So the profile write goes through the ordinary session client and lets the
 * database decide. `20260928120300` gives `authenticated` a SELECT on `profiles`
 * and an UPDATE limited to four columns, behind a policy requiring
 * `id = auth.uid()`. The ownership check is PostgreSQL's rather than a `where`
 * clause written here — a bug in this file cannot make one founder edit
 * another's profile, because the policy would refuse it.
 *
 * The racer row is a different matter: `racer` grants nothing to
 * `authenticated` at all, so creating it needs the service role, and the
 * profile id it is keyed on comes from `getUser()` rather than from the form.
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
    productName: formData.get("productName"),
    email: formData.get("email"),
    consent: formData.get("consent"),
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
    // This id is what the update is scoped to, and what the racer row is keyed
    // on, so it is worth the round trip.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { status: "error", message: "Your session expired. Sign in again." };
    }

    const { name, productName, email } = parsed.data;

    const { data, error } = await supabase
      .from("profiles")
      .update({
        // `name` is the only nullable one. Sending null would clear a name the
        // founder already has, so an empty field leaves the column alone.
        ...(name ? { name } : {}),
        email,
      })
      .eq("id", user.id)
      .select("id, x_handle, name");

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

    const saved = data[0];

    // The location is read from the request, never from the form. A field the
    // browser supplies is a claim; these headers are set by the platform. They
    // describe the connection, not the person, which is what the globe shows.
    const geo = readRequestGeo(await headers());

    const registered = await ensureRegisteredRacer({
      profileId: user.id,
      productName,
      // Reaching here means the consent checkbox passed `z.literal("yes")`.
      consentAt: new Date(),
      // The verified handle first, so two founders with the same display name
      // do not race for the same slug.
      slugSource: saved.x_handle ?? name,
      geo: {
        city: geo.city,
        country: geo.country,
        latitude: roundCoordinate(geo.latitude),
        longitude: roundCoordinate(geo.longitude),
      },
    });

    if (!registered.ok) {
      return { status: "error", message: registered.message };
    }

    // The page rendered the old values; without this the founder sees their
    // submission apparently revert and the stage never advances.
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
