/**
 * Where a request came from, as far as the platform can honestly say.
 *
 * ## What this is
 *
 * Vercel's edge adds `x-vercel-ip-*` headers to every request it serves. They
 * describe the *connection*: an approximate city and country centroid resolved
 * from the client IP. That is the same class of data, at the same granularity,
 * as the rows in the `visit` table — and it is what the globe plots.
 *
 * ## What this is not
 *
 * It is not the racer's address, and it is not something the racer typed. A
 * founder in Lisbon who signs up while on a VPN in Frankfurt gets a Frankfurt
 * dot. The globe is a picture of where connections come from, and the copy
 * around it must not claim more than that.
 *
 * ## Why everything is nullable
 *
 * Outside Vercel's edge — local development, a self-hosted deploy, a request
 * the edge could not resolve — none of these headers exist. There is then no
 * location, and the honest representation of "no location" is `null`.
 *
 * The failure this guards against is subtle: a racer with no coordinates must
 * have **no dot**, never a dot at (0, 0). Null island in the Gulf of Guinea is
 * the classic symptom of treating a missing coordinate as zero, and it would be
 * a fabricated location on a map whose whole purpose is being real.
 *
 * Pure and dependency-free, so it can be tested without a request.
 */

export type RequestGeo = {
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
};

const NOWHERE: RequestGeo = {
  city: null,
  country: null,
  latitude: null,
  longitude: null,
};

/** Non-empty, trimmed, or null. An empty header is absent, not a blank value. */
function text(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A finite number inside `min..max`, or null. Rejects `""`, `"abc"`, `"NaN"`. */
function bounded(value: string | null, min: number, max: number): number | null {
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;

  return parsed;
}

/**
 * Vercel percent-encodes the city (`New%20York`). Decoding can throw on a
 * malformed escape, and a city name is never worth a 500 — so it degrades to
 * the raw value rather than failing the signup.
 */
function decodeCity(value: string | null): string | null {
  if (!value) return null;
  try {
    return text(decodeURIComponent(value));
  } catch {
    return text(value);
  }
}

export function readRequestGeo(headers: Headers): RequestGeo {
  const latitude = bounded(headers.get("x-vercel-ip-latitude"), -90, 90);
  const longitude = bounded(headers.get("x-vercel-ip-longitude"), -180, 180);

  // Half a coordinate is not a location. The database has a matching check
  // constraint, so dropping both here keeps the two in agreement rather than
  // letting the insert fail.
  if (latitude === null || longitude === null) {
    return { ...NOWHERE, city: decodeCity(headers.get("x-vercel-ip-city")), country: text(headers.get("x-vercel-ip-country")) };
  }

  return {
    city: decodeCity(headers.get("x-vercel-ip-city")),
    country: text(headers.get("x-vercel-ip-country")),
    latitude,
    longitude,
  };
}

/** True when there is enough here to place a dot on the globe. */
export function isPlottable(geo: {
  latitude: number | null;
  longitude: number | null;
}): boolean {
  return geo.latitude !== null && geo.longitude !== null;
}
