// Relative with an explicit extension: Node's native type-stripping, which
// runs the tests, does not resolve the `@/` alias.
import { normaliseXHandle } from "../validation/racer.ts";

/**
 * Turning an authenticated Supabase user into the fields a profile needs.
 *
 * Pure, and deliberately so: this is where the rule that stops one founder
 * taking over another's account is expressed, and a rule that lives inside a
 * route handler is a rule nobody tests.
 *
 * ## The rule
 *
 * **A profile is identified by the authenticated user's id, and by nothing
 * else.** This module never receives an id and never looks one up — it only
 * derives *fields*. The caller keys the write on `auth.users.id`, which
 * Supabase established.
 *
 * `02` §6 is explicit: "Never merge accounts based only on an untrusted
 * client-submitted email." So the email here is never a lookup key and never a
 * merge key. Two providers returning the same address produce two separate
 * accounts until somebody deliberately links them, because an email that
 * arrives inside a token payload is a claim, not a proof of ownership.
 */

export type Identity = {
  provider?: string | null;
  identity_data?: Record<string, unknown> | null;
};

export type AuthUserLike = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: Identity[] | null;
};

export type ProfileDraft = {
  name: string | null;
  email: string | null;
  xHandle: string | null;
  avatarUrl: string | null;
};

/** First non-empty string among the candidates, trimmed. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * The provider id Supabase uses for X.
 *
 * It was `twitter` — the legacy OAuth 1.0a provider, which Supabase's current
 * X support replaces. The old id is gone rather than kept as an alias: nothing
 * has ever linked through it in this project, and accepting both would mean
 * treating an identity from a provider we no longer offer as a verified X
 * account.
 */
export const X_PROVIDER_ID = "x";

/** The metadata keys X has used for the username, in the order they are tried. */
const HANDLE_KEYS = ["user_name", "preferred_username", "screen_name"] as const;

/**
 * The handle X reports for the account.
 *
 * X's OAuth 2.0 identity payload has carried the username under several names
 * over time. All three are tried so a rename upstream does not silently produce
 * profiles with no handle.
 *
 * Normalised through the same validator the join form uses, so a handle that
 * arrives from X is held to exactly the character set a typed one was.
 *
 * ## The dev-only key log
 *
 * Which key is present is the one thing that cannot be deduced when this stops
 * working, and it is also the one thing that is safe to print — the *names* are
 * ours to know, the *values* are a person's account. So only the names are
 * logged, only outside production, and only when no handle was found.
 */
function handleFromIdentity(identity: Identity): string | null {
  const data = identity.identity_data ?? {};
  const raw = firstString(...HANDLE_KEYS.map((key) => data[key]));

  if (raw) return normaliseXHandle(raw);

  if (process.env.NODE_ENV !== "production") {
    // Key names only. Logging `data` here would put a founder's account
    // metadata, including whatever address the provider sent, into a log line.
    console.warn("[auth] no X handle in identity metadata", {
      provider: identity.provider,
      keysPresent: Object.keys(data).sort(),
      keysTried: [...HANDLE_KEYS],
    });
  }

  return null;
}

/**
 * The best available public identity for a user.
 *
 * ## Why the email only comes from `user.email`
 *
 * Supabase sets `user.email` from the provider it trusts, and marks it
 * confirmed. An address sitting inside `identity_data` is whatever the provider
 * put in a token — it may be absent (X often omits it), and it is not the field
 * Supabase itself treats as the account's address.
 *
 * Taking it only from `user.email` gives a clean, testable rule: when the
 * provider did not supply a verified address, this returns null and the UI asks
 * the founder for one. That is exactly what `01` §7 requires ("If X does not
 * provide an email, ask for one manually") and it means we never quietly store
 * an unverified address as though it were confirmed.
 *
 * ## Why the X handle is taken from any identity
 *
 * Unlike the email, a handle is not a credential — it is a public name, and it
 * is the same name X shows the world. Reading it from whichever identity
 * carries one is safe, and it means a founder who linked X keeps their handle
 * even when they most recently signed in with Google.
 */
export function profileFromUser(user: AuthUserLike): ProfileDraft {
  const identities = user.identities ?? [];
  const metadata = user.user_metadata ?? {};

  let xHandle: string | null = null;
  let avatarUrl: string | null = null;
  let name: string | null = null;

  // The X identity wins for the handle regardless of order, so a Google sign-in
  // after a linked X sign-in does not lose it.
  //
  // Only an X identity sets this. The handle is shown on the board and linked to
  // x.com, so a handle nobody proved they own would let one founder post as
  // another. A Google-only account has no handle here, and the board shows its
  // display name instead.
  for (const identity of identities) {
    if (!xHandle && identity.provider === X_PROVIDER_ID) {
      xHandle = handleFromIdentity(identity);
    }
  }

  for (const identity of identities) {
    const data = identity.identity_data ?? {};
    if (!name) name = firstString(data.full_name, data.name);
    if (!avatarUrl) avatarUrl = firstString(data.avatar_url, data.picture);
  }

  return {
    name: name ?? firstString(metadata.full_name, metadata.name),
    // `user.email` only. See above.
    email: firstString(user.email),
    xHandle,
    avatarUrl: avatarUrl ?? firstString(metadata.avatar_url, metadata.picture),
  };
}

/**
 * Whether a signed-in founder still has to supply an address.
 *
 * This used to also require an X handle, on the reasoning that a founder with
 * no handle has no public identity. That reasoning was wrong in one specific
 * way: it made an X account mandatory to enter a product that offers Google as
 * an equal way in, and it read a handle the founder had not proved they owned as
 * an identity. The board shows the display name when there is no handle, so the
 * only thing genuinely missing without one is an address to write to.
 *
 * The rest of the profile step — the product name and the consent — is not
 * derived from a provider at all, so it is not something this can report on; the
 * racer row's absence is what says that step is unfinished.
 */
export function missingProfileFields(draft: ProfileDraft): Array<"email"> {
  return draft.email ? [] : ["email"];
}

/**
 * Where to send someone after the callback.
 *
 * Only a same-site path is accepted. An OAuth callback that redirects to
 * whatever `next` says is an open redirect — a way to bounce a freshly
 * authenticated founder to an attacker's page with our domain in the referrer.
 * A leading `//` is rejected too, because `//evil.example.com` is a valid
 * protocol-relative URL and looks like a path.
 */
export function safeRedirectPath(candidate: string | null, fallback = "/join"): string {
  if (!candidate) return fallback;

  // Control characters first, and this is not belt-and-braces.
  //
  // The WHATWG URL parser removes every ASCII tab and newline from its input
  // *before* it parses. So `/\t/evil.com` is not a path beginning with a slash
  // and a tab — by the time anything acts on it, it is `//evil.com`, which is
  // protocol-relative and resolves to another origin entirely.
  //
  // A prefix check on the raw string cannot see that, because the raw string
  // and the string that gets navigated to are different strings. Anything that
  // inspects a URL without parsing it is inspecting the wrong value.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;

  // Parsed with the same implementation that will perform the redirect, against
  // a sentinel origin, and then the origin is compared. String matching is
  // replaced by the parser's own notion of where this URL points — which
  // handles the backslash trick (`/\evil.com`), the tab trick above, and
  // whatever the next one turns out to be.
  const sentinel = "https://same-site.invalid";

  let parsed: URL;
  try {
    parsed = new URL(candidate, sentinel);
  } catch {
    return fallback;
  }

  if (parsed.origin !== sentinel) return fallback;
  if (!parsed.pathname.startsWith("/")) return fallback;

  // Rebuilt from the parsed parts rather than returned as given, so what the
  // caller receives is exactly what was validated.
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
