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

    // Only an explicit `false` disables a button. Anything else — a missing key,
    // a string, a null — is not the project saying the provider is off, and
    // treating it as one is what broke the X button.
    //
    // `external` carries the id of the provider as Supabase's *authorize*
    // endpoint spells it, and that is the only id worth reading here. For X that
    // id is `x`; the `twitter` key in the same map belongs to the deprecated
    // OAuth 1.0a provider, which the dashboard shows disabled while the OAuth
    // 2.0 provider is on and working. Reading `twitter` would disable a button
    // for a provider that signs people in, which is the same mistake in the
    // opposite direction.
    //
    // The cost of a wrong "available" is one sentence from the callback. The
    // cost of a wrong "unavailable" is a dead end nobody can argue with.
    const off = (value: unknown) => value === false;

    return {
      google: !off(map.google),
      x: !off(map.x),
    };
  } catch {
    return ASSUME_AVAILABLE;
  }
}
