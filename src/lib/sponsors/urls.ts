/**
 * Sponsor-supplied URLs, guarded.
 *
 * Both `sponsor_link` and `sponsor_logo_url` are written by sponsors and
 * rendered on public pages, so both are untrusted input. They need different
 * guards, and the difference is the point:
 *
 * - the **link** may point anywhere, but only at `http(s)` — otherwise a
 *   `javascript:` value executes in our origin for every visitor who clicks.
 * - the **logo** may only point at our own storage host — otherwise every
 *   visitor's browser fetches a third party on every page view.
 *
 * Pure, dependency-free, and importable from both server and client.
 */

/**
 * Returns the URL only if it is an absolute `http(s)` URL — otherwise null.
 *
 * Parsing with the WHATWG URL parser rather than pattern-matching is the point:
 * it normalises case and strips tabs and newlines before resolving the scheme,
 * so `JaVaScRiPt:` and `java\tscript:` collapse to the same rejected result.
 */
export function safeExternalUrl(raw: string | null): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    // No base: a relative or protocol-relative value throws, and is rejected.
    parsed = new URL(raw);
  } catch {
    return null;
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed.toString()
    : null;
}

/**
 * A logo URL, restricted to our own storage host — otherwise null.
 *
 * Narrower than `safeExternalUrl` on purpose. A logo pointing anywhere on the
 * internet makes every visitor's browser request that host on every page view:
 * a visitor-IP leak, and a tracking pixel wearing a sponsor's name.
 *
 * Fails closed: with no host configured, nothing renders.
 */
export function safeStorageUrl(
  raw: string | null,
  allowedHost: string | null,
): string | null {
  if (!raw || !allowedHost) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // https only, and an exact hostname match — no subdomain wildcards, since a
  // wildcard is exactly how lookalike bypasses get in.
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== allowedHost) return null;

  return parsed.toString();
}
