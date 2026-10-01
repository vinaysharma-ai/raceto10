import { cache } from "react";

/**
 * The race duration, read from configuration.
 *
 * `00-START-HERE-REVISED.md` is explicit that 7 days is the current *candidate*
 * and not a locked rule, and that the value must not be hardcoded into UI copy,
 * database constraints or business logic. So it is a row — `race_config` —
 * exactly as the sponsor price list is, and changing it is an UPDATE rather
 * than a deploy.
 *
 * ## Why this has a fallback, and why the fallback is not a number
 *
 * Every caller needs *a* duration to render copy. When the read fails there are
 * two honest options: show nothing, or show a value we know is current. The
 * config table is public and almost never changes, so the read is cheap — but
 * "almost never" is not "never", and a cached wrong number printed under a
 * headline is worse than a page that says less.
 *
 * The fallback is therefore the last value this process successfully read, and
 * on a cold failure there is no number at all. Callers must handle null by
 * omitting the duration from their copy rather than by defaulting to 7, which
 * would be inventing a business rule at the exact moment we could not read the
 * real one.
 */

/** The duration in days, or null when it could not be established. */
export type RaceDuration = number | null;

type ConfigReader = {
  from(table: "race_config"): {
    select(columns: string): {
      maybeSingle(): PromiseLike<{
        data: { duration_days: number } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

/**
 * The last value successfully read from the database.
 *
 * Module scope, so it survives between requests in a warm process. It is only
 * ever written from a successful read, so it can hold a stale value but never a
 * fabricated one.
 */
let lastKnown: number | null = null;

export function readRaceDuration(reader: ConfigReader): Promise<RaceDuration> {
  return read(reader);
}

async function read(reader: ConfigReader): Promise<RaceDuration> {
  try {
    const { data, error } = await reader
      .from("race_config")
      .select("duration_days")
      .maybeSingle();

    if (error || !data) return lastKnown;

    const days = Number(data.duration_days);
    // A zero or negative duration would produce a race that ends before it
    // starts, and the database refuses that — so a bad value here means
    // something is wrong upstream, not that the race is instant.
    if (!Number.isFinite(days) || days <= 0) return lastKnown;

    lastKnown = days;
    return days;
  } catch {
    return lastKnown;
  }
}

/** One read per request, shared by every component that prints the duration. */
export const getRaceDuration = cache(async (): Promise<RaceDuration> => {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    return await read(await createClient());
  } catch {
    return lastKnown;
  }
});

/** Exposed for tests, which need a cold process. */
export function resetRaceDurationCache() {
  lastKnown = null;
}

/**
 * "7 days" / "1 day" / null.
 *
 * Returns null rather than a default when the duration is unknown, so a caller
 * that forgets to handle it renders a sentence with a hole in it rather than a
 * sentence with a made-up number in it.
 */
export function describeDuration(days: RaceDuration): string | null {
  if (days === null) return null;
  return days === 1 ? "1 day" : `${days} days`;
}
