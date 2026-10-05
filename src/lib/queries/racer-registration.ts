import "server-only";

import type { TablesUpdate } from "@/lib/supabase/database.types";

/**
 * Creating the racer row, at the moment the profile is finished.
 *
 * ## Why this exists at all
 *
 * It did not, and that was the hole in the middle of the product. Every other
 * piece was built: activation has a compare-and-set, reconciliation has a
 * fleet job, the vault seals keys. But nothing ever inserted a `racer` row, so
 * `getCurrentRacerId()` returned null for everyone, connecting a provider
 * refused with `no_racer`, and `/join` stopped at "connect your Stripe account"
 * forever. The `registered` status was in the enum with nothing to produce it.
 *
 * ## Why registration, not activation
 *
 * The product name is collected on the profile step, so there has to be a row to
 * hold it before the clock starts. `registered` is exactly that state: this
 * founder exists, has agreed to the public terms, and has not begun. Activation
 * later moves `ready` to `racing`; nothing here touches the clock.
 *
 * ## Consent is recorded here, not at the start button
 *
 * The checkbox is on the profile step, and it covers the public row. Writing
 * `public_consent_at` at the moment the founder ticks it means the consent
 * timestamp and the data it authorises arrive together. A consent recorded
 * later, at activation, would sit after the location was already stored.
 */

export type RegistrationGeo = {
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type RegistrationInput = {
  profileId: string;
  productName: string;
  /** The instant the founder ticked the consent box. */
  consentAt: Date;
  /** Preferred slug source: the verified X handle, else the display name. */
  slugSource: string | null;
  /**
   * Only written when consent was given. The caller passes null otherwise, and
   * the columns are left alone rather than cleared.
   */
  geo: RegistrationGeo | null;
};

export type RegistrationResult =
  | { ok: true; racerId: string; created: boolean }
  | { ok: false; message: string };

/** The shape the `racer_public_slug_shape` constraint requires. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const SLUG_MAX = 32;

/**
 * A candidate slug, or the empty string when nothing usable is left.
 *
 * Lowercased, everything outside the constraint's character set collapsed to a
 * hyphen, and trimmed of leading and trailing hyphens so a handle like `__ada__`
 * does not produce a slug that fails the shape check.
 */
function slugify(source: string): string {
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);

  // The constraint needs at least two characters, and the first must not be a
  // hyphen. Anything shorter is discarded rather than padded, so no two
  // founders can collide on a slug that means nothing.
  return SLUG_SHAPE.test(base) ? base : "";
}

/**
 * Finds a slug nobody holds.
 *
 * Bounded, then random. A sequential suffix would let anyone enumerate how many
 * founders share a handle, and it would also mean the fifth "ada" waits on four
 * lookups. After a handful of attempts the suffix is random and the loop ends.
 */
async function freeSlug(
  db: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  source: string | null,
): Promise<string> {
  const base = (source ? slugify(source) : "") || "racer";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!SLUG_SHAPE.test(candidate)) continue;

    const { data } = await db
      .from("racer")
      .select("id")
      .eq("public_slug", candidate)
      .maybeSingle();

    if (!data) return candidate;
  }

  // Collision on a handful of near-identical handles. Random rather than
  // sequential so the tail stays unguessable.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${base.slice(0, SLUG_MAX - 5)}-${suffix}`;
    if (!SLUG_SHAPE.test(candidate)) continue;

    const { data } = await db
      .from("racer")
      .select("id")
      .eq("public_slug", candidate)
      .maybeSingle();

    if (!data) return candidate;
  }

  return "";
}

export async function ensureRegisteredRacer(
  input: RegistrationInput,
): Promise<RegistrationResult> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const db = createAdminClient();

  const { data: existing, error: readError } = await db
    .from("racer")
    .select("id")
    .eq("profile_id", input.profileId)
    .maybeSingle();

  if (readError) {
    console.error("[registration] reading the racer failed", readError.message);
    return { ok: false, message: "We couldn't save that just now. Try again in a moment." };
  }

  // Geo is only attached when the caller confirmed consent. A null here means
  // the columns are not in the patch at all, so a later save without consent
  // cannot blank a location that was already agreed to.
  const consentPatch = input.geo
    ? {
        city: input.geo.city,
        country: input.geo.country,
        latitude: input.geo.latitude,
        longitude: input.geo.longitude,
        public_consent_at: input.consentAt.toISOString(),
      }
    : { public_consent_at: input.consentAt.toISOString() };

  if (existing) {
    const patch: TablesUpdate<"racer"> = {
      product_name: input.productName,
      ...consentPatch,
    };

    const { error } = await db.from("racer").update(patch).eq("id", existing.id);
    if (error) {
      console.error("[registration] updating the racer failed", error.message);
      return { ok: false, message: "We couldn't save that just now. Try again in a moment." };
    }

    return { ok: true, racerId: existing.id, created: false };
  }

  const slug = await freeSlug(db, input.slugSource);
  if (!slug) {
    console.error("[registration] no free slug", { slugSource: input.slugSource });
    return { ok: false, message: "We couldn't save that just now. Try again in a moment." };
  }

  const { data: created, error: insertError } = await db
    .from("racer")
    .insert({
      profile_id: input.profileId,
      status: "registered",
      product_name: input.productName,
      public_slug: slug,
      ...consentPatch,
    })
    .select("id")
    .single();

  if (insertError || !created) {
    // The unique constraint on `profile_id` is the one worth recognising: two
    // submissions arriving together both find no row and both insert, and the
    // loser should end up with the winner's row rather than an error.
    if (insertError?.code === "23505") {
      const { data: winner } = await db
        .from("racer")
        .select("id")
        .eq("profile_id", input.profileId)
        .maybeSingle();

      if (winner) return { ok: true, racerId: winner.id, created: false };
    }

    console.error("[registration] creating the racer failed", insertError?.message);
    return { ok: false, message: "We couldn't save that just now. Try again in a moment." };
  }

  return { ok: true, racerId: created.id, created: true };
}
