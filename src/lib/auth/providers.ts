import "server-only";

/**
 * Which sign-in providers this Supabase project actually has switched on.
 *
 * ## Why the app asks rather than assumes
 *
 * Supabase answers a request for a provider that is not enabled with an error
 * payload. A founder who clicks a button that could never work is being told
 * something untrue about the product, so the buttons are rendered from the
 * project's own settings rather than from a list written here. When the owner
 * enables X in the dashboard, the button starts working with no deploy.
 *
 * ## The shape
 *
 * `GET {SUPABASE_URL}/auth/v1/settings` is a public endpoint: the publishable
 * key goes in the `apikey` header, and the response carries an `external` map of
 * provider id to boolean. Nothing secret is read and nothing is written.
 *
 * ## Why a failed read means "yes"
 *
 * If the settings call times out or returns something unrecognised, every
 * provider is reported as available. That is deliberate, and it is the failure
 * direction this codebase takes everywhere else too: the check exists to
 * *improve* the message, not to gate the feature. Reporting "unavailable" on a
 * transient network blip would block sign-in entirely and blame the provider for
 * our own failure to make one HTTP request. Fail-open here costs, at worst, the
 * old behaviour: the founder clicks, the exchange fails, and the callback says
 * so in a sentence.
 */

export const SIGN_IN_PROVIDERS = ["google", "x"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export type ProviderAvailability = Record<SignInProvider, boolean>;

const SETTINGS_TIMEOUT_MS = 3000;
const REVALIDATE_SECONDS = 60;

const ASSUME_AVAILABLE: ProviderAvailability = { google: true, x: true };

export async function enabledProviders(): Promise<ProviderAvailability> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) return ASSUME_AVAILABLE;

  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      // The dashboard setting changes maybe once in the project's life, so a
      // minute of staleness costs nothing and keeps this off the render path.
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });

    if (!response.ok) return ASSUME_AVAILABLE;

    const body: unknown = await response.json();
    const external = (body as { external?: unknown } | null)?.external;

    if (!external || typeof external !== "object") return ASSUME_AVAILABLE;

    const map = external as Record<string, unknown>;

    return {
      // Strictly `=== true`. A missing key, a string, or anything else is not a
      // promise that the provider works.
      google: map.google === true,
      x: map.x === true,
    };
  } catch {
    return ASSUME_AVAILABLE;
  }
}
