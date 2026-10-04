/**
 * Public configuration — safe to ship in the browser bundle.
 *
 * Every `NEXT_PUBLIC_` value is inlined by the bundler at build time, so each
 * one must be read as a literal property. `process.env[name]` is not
 * substituted, and would arrive as `undefined` in the client.
 *
 * This is validated at module load, deliberately: these values are needed by
 * essentially every render, so a missing one should stop the build rather than
 * surface later as a broken page or a confusing runtime error.
 *
 * No dependency is used here, and that is on purpose — this module is reachable
 * from the client bundle, and a validation library would be shipped to the
 * browser to check three strings.
 */

export type PublicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  NEXT_PUBLIC_APP_URL: string;
  /**
   * The Mapbox public token, or null.
   *
   * Optional, and the only value here that is. Everything above is required
   * because the product cannot render without it; this one is required only to
   * draw the map, and a missing token renders an honest "the map is
   * unavailable" panel rather than a broken canvas.
   *
   * That distinction matters for anyone cloning this repository: Mapbox is a
   * real signup with a real account behind it, and making it a hard boot
   * failure would mean the rest of the site — the race, the leaderboard, the
   * join flow — could not be built or run at all without one.
   */
  NEXT_PUBLIC_MAPBOX_TOKEN: string | null;
  /**
   * Where a visitor writes to, or null.
   *
   * Optional for the same reason the Mapbox token is: the product is complete
   * without it. It exists so that a page which has no action to offer can still
   * offer a way to be told when one arrives, and a page that has no such address
   * simply does not show the line.
   */
  NEXT_PUBLIC_CONTACT_EMAIL: string | null;
};

const problems: string[] = [];

/** Collects every problem rather than throwing on the first, so one run tells you all of them. */
function absoluteUrl(name: keyof PublicEnv, value: string | undefined): string {
  if (!value) {
    problems.push(`${name}: missing`);
    return "";
  }
  try {
    new URL(value);
    return value;
  } catch {
    problems.push(`${name}: must be an absolute URL, e.g. https://example.com`);
    return "";
  }
}

function present(name: keyof PublicEnv, value: string | undefined): string {
  if (!value) {
    problems.push(`${name}: missing`);
    return "";
  }
  return value;
}

/**
 * Trimmed to null when absent or blank, and never added to `problems`.
 *
 * A whitespace-only value is treated as absent rather than as a token, because
 * a half-filled `.env.local` is the most likely way this goes wrong and an
 * empty string reaching Mapbox produces an opaque 401 rather than a clear
 * "no token" branch.
 */
function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const env: PublicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: absoluteUrl(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: present(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  NEXT_PUBLIC_APP_URL: absoluteUrl(
    "NEXT_PUBLIC_APP_URL",
    process.env.NEXT_PUBLIC_APP_URL,
  ),
  NEXT_PUBLIC_MAPBOX_TOKEN: optional(process.env.NEXT_PUBLIC_MAPBOX_TOKEN),
  NEXT_PUBLIC_CONTACT_EMAIL: optional(process.env.NEXT_PUBLIC_CONTACT_EMAIL),
};

if (problems.length > 0) {
  throw new Error(
    `Invalid public environment configuration:\n  ${problems.join("\n  ")}\n\n` +
      `Set these in .env.local for local development, and in the Vercel project settings for deploys.`,
  );
}

export { env };
