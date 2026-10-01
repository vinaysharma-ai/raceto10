import "server-only";

import type { TablesUpdate } from "@/lib/supabase/database.types";
import { profileFromUser, type AuthUserLike, type ProfileDraft } from "./identity";

/**
 * Loading and creating the profile row behind an authenticated user.
 *
 * ## The one rule
 *
 * Every statement here is keyed on `auth.users.id`, and none of them ever looks
 * a row up by email. That is the whole of `02` §6's "never merge accounts based
 * only on an untrusted client-submitted email": a profile is identified by the
 * id Supabase authenticated, and by nothing a provider put in a token.
 *
 * ## Service role, deliberately
 *
 * `anon` holds nothing on `profiles`. `authenticated` holds a SELECT and an
 * UPDATE limited to four columns, behind a policy requiring `id = auth.uid()`
 * (`20260928120300`) — enough to read and correct their own row, and not enough
 * to create one for an arbitrary id.
 *
 * Creating the row is what needs the service role: it happens in the callback,
 * before any policy could authorise it. Every later write goes through the
 * founder's own session instead, so the ownership check is PostgreSQL's rather
 * than a `where` clause written by hand. `src/app/actions/profile.ts` is that
 * path.
 */

export type ProfileRow = {
  id: string;
  name: string | null;
  email: string | null;
  x_handle: string | null;
  avatar_url: string | null;
};

async function admin() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

/**
 * Creates the profile if it is absent, and fills blanks if it is not.
 *
 * ## Why this is not an upsert
 *
 * An upsert would overwrite on every sign-in, so a founder who corrected their
 * name would watch it revert the next time they logged in. The rule instead is
 * *fill, never overwrite*: a field the founder has set is theirs, and a field
 * that is still null is one we can populate from the provider.
 *
 * `ignoreDuplicates` on the insert is what makes a repeat sign-in a no-op
 * rather than a conflict, so this is safe to call on every callback.
 */
export async function ensureProfile(user: {
  id: string;
} & AuthUserLike): Promise<{ ok: true; draft: ProfileDraft } | { ok: false; message: string }> {
  const draft = profileFromUser(user);
  const db = await admin();

  // 1. Create, but never clobber. Keyed on the authenticated id.
  const { error: insertError } = await db.from("profiles").upsert(
    {
      id: user.id,
      name: draft.name,
      email: draft.email,
      x_handle: draft.xHandle,
      avatar_url: draft.avatarUrl,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );

  if (insertError) {
    console.error("[auth] creating the profile failed", insertError.message);
    return { ok: false, message: "We could not finish setting up your account." };
  }

  // 2. Fill only the blanks.
  const { data: existing, error: readError } = await db
    .from("profiles")
    .select("id, name, email, x_handle, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (readError || !existing) {
    console.error("[auth] reading the profile back failed", readError?.message);
    return { ok: false, message: "We could not finish setting up your account." };
  }

  // Typed from the generated schema rather than `Record<string, string>`. The
  // loose type accepted any column name at all, so a rename in a migration
  // would have compiled and then written nothing.
  const fill: TablesUpdate<"profiles"> = {};
  if (!existing.name && draft.name) fill.name = draft.name;
  if (!existing.email && draft.email) fill.email = draft.email;
  if (!existing.x_handle && draft.xHandle) fill.x_handle = draft.xHandle;
  if (!existing.avatar_url && draft.avatarUrl) fill.avatar_url = draft.avatarUrl;

  if (Object.keys(fill).length > 0) {
    const { error: fillError } = await db.from("profiles").update(fill).eq("id", user.id);
    if (fillError) {
      // Not fatal. The profile exists and the missing fields can be supplied
      // from the join form; failing the whole sign-in over a display name
      // would be a worse outcome than a blank one.
      console.error("[auth] filling profile blanks failed", fillError.message);
    }
  }

  return { ok: true, draft };
}

/** The signed-in founder's profile, or null. Never throws. */
export async function getCurrentProfile(): Promise<ProfileRow | null> {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = await supabase
      .from("profiles")
      .select("id, name, email, x_handle, avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    return data ?? null;
  } catch {
    return null;
  }
}

/** The signed-in auth user, or null. Never throws. */
export async function getCurrentUser() {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ?? null;
  } catch {
    return null;
  }
}
