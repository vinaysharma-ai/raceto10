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
 * The handle X reports for the account.
 *
 * X's OAuth 2.0 identity payload has carried the username under several names
 * over time — `user_name` and `preferred_username` both appear, and older
 * payloads used `screen_name`. All three are checked so a rename upstream does
 * not silently produce profiles with no handle.
 *
 * Normalised through the same validator the join form used, so a handle that
 * arrives from X is held to exactly the character set a typed one was.
 */
function handleFromIdentity(identity: Identity): string | null {
  const data = identity.identity_data ?? {};
  const raw = firstString(data.user_name, data.preferred_username, data.screen_name);
  return raw ? normaliseXHandle(raw) : null;
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
  for (const identity of identities) {
    if (!xHandle && identity.provider === "twitter") {
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
 * Whether a signed-in founder still has to supply something before they can
 * enter the race.
 *
 * Only the two fields the product cannot work without: an address to reach them
 * at, and the handle that identifies them on the board. The name is nice to
 * have and is displayed, but a founder with no name is a cosmetic problem; one
 * with no handle has no public identity at all.
 */
export function missingProfileFields(draft: ProfileDraft): Array<"email" | "xHandle"> {
  const missing: Array<"email" | "xHandle"> = [];
  if (!draft.email) missing.push("email");
  if (!draft.xHandle) missing.push("xHandle");
  return missing;
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
