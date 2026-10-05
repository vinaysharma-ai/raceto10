/**
 * The public race: its shapes, and how they are read out loud.
 *
 * Pure and dependency-free, so the globe — a client component — can import it
 * without pulling a database client into the browser bundle. Reading lives in
 * `src/lib/queries/race-board.ts`.
 *
 * Every shape here maps to a column on a public view, and the views are the
 * security boundary. Nothing in this file may reference a private column,
 * because a private column cannot arrive: `public_racers` does not select it.
 *
 * ## The identifier is `public_slug`
 *
 * The internal `racer.id` is deliberately absent from every public projection.
 * A primary key in a public payload is a stable reference that outlives its
 * usefulness and cannot be revoked; the slug is unique, is what URLs use, and
 * is the only handle any surface here needs.
 */

export type RacerStatus =
  | "registered"
  | "ready"
  | "racing"
  | "finished"
  | "expired"
  | "ineligible"
  | "verification_failed"
  | "withdrawn"
  | "disqualified";

/** A row of `public_racers`. */
export type PublicRacer = {
  public_slug: string;
  founder_name: string | null;
  x_handle: string | null;
  product_name: string | null;
  status: RacerStatus;
  current_customer_count: number;
  activated_at: string | null;
  race_end_at: string | null;
  reached_ten_at: string | null;
  created_at: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type RaceEventType =
  | "joined"
  | "activated"
  | "customer_milestone"
  | "finished";

/** A row of `public_race_events`. Carries no provider payload and no id. */
export type ActivityRow = {
  event_type: RaceEventType;
  milestone_customer_count: number | null;
  occurred_at: string;
  public_slug: string;
  founder_name: string | null;
  x_handle: string | null;
  product_name: string | null;
  city: string | null;
  country: string | null;
};

export const RACE_TARGET = 10;

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/**
 * `PT` -> `Portugal`, using the platform's own region table.
 *
 * `Intl.DisplayNames` ships with Node and every current browser, so vendoring a
 * 250-entry country map would be a dependency bought for nothing. Anything the
 * runtime cannot resolve is echoed rather than guessed at.
 */
const UNKNOWN_REGION = "Unknown Region";

export function countryName(code: string | null): string | null {
  if (!code) return null;
  // Region codes are two letters. Anything else is echoed rather than looked
  // up, so the lookup can never return a sentinel for input it was never
  // meant to take.
  if (!/^[A-Za-z]{2}$/.test(code)) return code;

  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    const name = display.of(code.toUpperCase());
    if (!name || name === code.toUpperCase() || name === UNKNOWN_REGION) return code;
    return name;
  } catch {
    return code;
  }
}

/** "Lisbon, Portugal" / "Portugal" / null. Null when nothing is known. */
export function placeLabel(place: {
  city: string | null;
  country: string | null;
}): string | null {
  const country = countryName(place.country);
  if (place.city && country) return `${place.city}, ${country}`;
  return place.city ?? country ?? null;
}

export type GlobeDot = {
  slug: string;
  coordinates: [number, number];
  label: string;
  handle: string;
};

/**
 * The racers the globe can actually plot.
 *
 * A racer with no coordinates is not plotted at all. There is deliberately no
 * fallback coordinate, no jittered position near a country, and no clustering
 * of unknowns into one place — each of those would be a dot at a location
 * nobody signed up from.
 *
 * Only racers in a race are plotted. Someone who registered but never became
 * active has no race to show.
 */
export function globeDots(racers: PublicRacer[]): GlobeDot[] {
  return racers
    .filter(
      (racer) =>
        racer.latitude !== null &&
        racer.longitude !== null &&
        isOnTheBoard(racer.status),
    )
    .map((racer) => ({
      slug: racer.public_slug,
      // GeoJSON order: longitude first. Reversing these is the classic bug and
      // would put every European founder in the Indian Ocean.
      coordinates: [racer.longitude as number, racer.latitude as number] as [
        number,
        number,
      ],
      label: placeLabel(racer) ?? (racer.x_handle ? `@${racer.x_handle}` : "racer"),
      handle: racer.x_handle ? `@${racer.x_handle}` : racer.public_slug,
    }));
}

/**
 * Whether a racer belongs on the board.
 *
 * `expired` is here deliberately. A board that quietly drops the founders who
 * ran out of time is not a record of anything — it is a list of winners, which
 * anybody can produce and which tells a reader nothing about whether the race
 * was hard.
 */
function isOnTheBoard(status: RacerStatus): boolean {
  return status === "racing" || status === "finished" || status === "expired";
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * Racers who are actually in a race.
 *
 * `registered` and `ready` are pre-race states: verified, waiting, clock not
 * started. They are not on the board because there is nothing to rank yet — and
 * mixing them in would put a founder on the leaderboard before their race
 * began.
 */
export function racersOnTheBoard(racers: PublicRacer[]): PublicRacer[] {
  return racers.filter((racer) => isOnTheBoard(racer.status));
}

/** Verified, eligible, waiting for their clock. `01` §6 wants these separate. */
export function racersWaiting(racers: PublicRacer[]): PublicRacer[] {
  return racers.filter((racer) => racer.status === "ready");
}

/**
 * Ranked: most customers first, and among equals whoever started earlier.
 *
 * The tie-break is not cosmetic. Two racers both on 4 customers are not equal
 * in the story of the race — one got there first — and falling back to
 * insertion order would make the board's order depend on the database's mood.
 */
/**
 * Ranked: the winners first, then the running, then those who ran out of time.
 *
 * ## Why a finished race sorts by *time* and not by count
 *
 * Every finished racer has ten customers, so count cannot order them — it is the
 * same number for all of them and would leave the winner decided by whatever
 * order the database happened to return. The only thing that distinguishes two
 * racers who both reached ten is how long it took, and that is what a reader
 * wants to compare anyway.
 *
 * That is also why they sit above the runners rather than being mixed in: a race
 * that is over is not competing with one that is still going, and a board that
 * interleaved them would show a racer on 4 customers above one who finished.
 */
export function rankRacers(racers: PublicRacer[]): PublicRacer[] {
  return [...racers].sort((a, b) => {
    const band = bandOf(a) - bandOf(b);
    if (band !== 0) return band;

    // Winners: fastest first.
    if (a.status === "finished" && b.status === "finished") {
      const aTook = finishedInMs(a) ?? Number.POSITIVE_INFINITY;
      const bTook = finishedInMs(b) ?? Number.POSITIVE_INFINITY;
      if (aTook !== bTook) return aTook - bTook;
      return a.public_slug.localeCompare(b.public_slug);
    }

    // Racing: most customers first, then whoever started earlier.
    if (b.current_customer_count !== a.current_customer_count) {
      return b.current_customer_count - a.current_customer_count;
    }

    const aStart = a.activated_at ? Date.parse(a.activated_at) : Number.POSITIVE_INFINITY;
    const bStart = b.activated_at ? Date.parse(b.activated_at) : Number.POSITIVE_INFINITY;
    if (aStart !== bStart) return aStart - bStart;

    // Last resort, so the order is at least stable across identical requests.
    return a.public_slug.localeCompare(b.public_slug);
  });
}

/** 0 finished, 1 racing, 2 expired. Anything else sorts last. */
function bandOf(racer: PublicRacer): number {
  if (racer.status === "finished") return 0;
  if (racer.status === "racing") return 1;
  if (racer.status === "expired") return 2;
  return 3;
}

/**
 * How long a finished race took, in milliseconds, or null.
 *
 * Measured between activation and `reached_ten_at` — which is the tenth
 * customer's first payment, not the moment a poll noticed. Computing it from the
 * poll instead would make every race's time depend on when the reconciler
 * happened to run, and two racers who finished minutes apart could appear hours
 * apart.
 */
export function finishedInMs(
  racer: Pick<PublicRacer, "activated_at" | "reached_ten_at">,
): number | null {
  if (!racer.activated_at || !racer.reached_ten_at) return null;

  const from = Date.parse(racer.activated_at);
  const to = Date.parse(racer.reached_ten_at);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  return Math.max(0, to - from);
}

/**
 * "3d 2h" / "4h 12m" / "12m".
 *
 * Two units at most, and never seconds. A race is days long, and "3d 2h 14m 9s"
 * claims a precision that the thing being measured does not have — the finish
 * instant is when a payment landed, not when we looked.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "finished in 3d 2h", or null when the duration is not knowable. */
export function finishedLabel(
  racer: Pick<PublicRacer, "status" | "activated_at" | "reached_ten_at">,
): string | null {
  if (racer.status !== "finished") return null;
  const took = finishedInMs(racer);
  return took === null ? null : `finished in ${formatDuration(took)}`;
}

/**
 * 0–10, clamped.
 *
 * Never negative, and never above the target. `02` §10 requires the downward
 * correction of a count to be explicit rather than silently producing negative
 * progress, and the clamp here is the last line of that: even if a verified
 * count somehow fell below the baseline, a spectator sees 0 rather than "-2".
 */
export function progressOf(racer: Pick<PublicRacer, "current_customer_count">): number {
  const count = Number(racer.current_customer_count);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(count, RACE_TARGET);
}

/** "4 of 10 customers", phrased once so the board and the feed agree. */
export function progressLabel(racer: PublicRacer): string {
  return `${progressOf(racer)} of ${RACE_TARGET} customers`;
}

/**
 * How long is left, in whole days and hours — or null when there is no race.
 *
 * Null, not zero. A racer who has not started has no time remaining, and
 * "0 days left" reads as a race that just ended.
 */
export function timeRemaining(
  racer: Pick<PublicRacer, "race_end_at">,
  now: Date = new Date(),
): { days: number; hours: number; ended: boolean } | null {
  if (!racer.race_end_at) return null;

  const end = Date.parse(racer.race_end_at);
  if (Number.isNaN(end)) return null;

  const ms = end - now.getTime();
  if (ms <= 0) return { days: 0, hours: 0, ended: true };

  const hours = Math.floor(ms / 3_600_000);
  return { days: Math.floor(hours / 24), hours: hours % 24, ended: false };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The shape `public_search` returns: deliberately narrower than a racer. */
export type SearchResult = {
  public_slug: string;
  founder_name: string | null;
  x_handle: string | null;
  product_name: string | null;
};

/** The X profile URL for a handle. `x.com/ada`. */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${encodeURIComponent(handle)}`;
}

/**
 * Filters by a free-text query across founder name, X handle and product.
 *
 * Case-insensitive substring, deliberately not fuzzy. A founder searching for
 * "ada" wants everyone whose handle or product contains those letters, in a
 * predictable order; fuzzy matching on a board this small mostly produces
 * confident nonsense.
 *
 * An empty query returns the board untouched — a search box that has been
 * clicked into and left alone must not filter anything out.
 */
export function searchRacers<T extends SearchResult>(racers: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return racers;

  return racers.filter((racer) => {
    const fields = [racer.founder_name, racer.x_handle, racer.product_name];
    return fields.some((field) => field?.toLowerCase().includes(needle));
  });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago".
 *
 * Coarse on purpose. A feed line reading "47 seconds ago" claims a precision
 * the reader cannot use, and it goes stale on a page nobody reloads. Empty
 * string when the timestamp is unusable, so the caller renders nothing rather
 * than "Invalid Date".
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One line of the feed, from real event data.
 *
 * `customer_milestone` carries the number, which is the only interesting thing
 * that happens in a race and the reason the feed is worth reading.
 */
export function describeActivity(row: ActivityRow): {
  who: string;
  what: string;
  where: string | null;
} {
  const where = placeLabel(row);
  const who = row.x_handle ? `@${row.x_handle}` : (row.founder_name ?? row.public_slug);

  if (row.event_type === "customer_milestone" && row.milestone_customer_count !== null) {
    return { who, what: `hit customer #${row.milestone_customer_count}`, where };
  }

  if (row.event_type === "finished") {
    return { who, what: `reached ${RACE_TARGET} customers`, where };
  }

  if (row.event_type === "activated") {
    return { who, what: "started racing", where };
  }

  return { who, what: "joined", where };
}

/** One rendered line of the feed that floats over the map. */
export type ActivityLine = {
  key: string;
  who: string;
  what: string;
  when: string;
};

/**
 * The feed, ready to render.
 *
 * The key is built from the fields rather than taken from an id, because the
 * public view does not expose one — an internal uuid in a public payload is a
 * stable reference nobody needs. Slug, event and instant identify a row
 * uniquely: a racer cannot do the same thing twice in the same microsecond.
 *
 * `now` is passed in rather than read here so every relative timestamp on one
 * render is measured against the same instant, otherwise two rows a millisecond
 * apart can disagree about whether something was "12m" or "13m".
 */
export function activityLines(
  rows: ActivityRow[],
  now: Date,
  limit: number,
): ActivityLine[] {
  return recentActivity(rows, limit).map((row) => {
    const line = describeActivity(row);
    return {
      key: `${row.public_slug}-${row.event_type}-${row.occurred_at}`,
      who: line.who,
      what: line.what,
      when: timeAgo(row.occurred_at, now),
    };
  });
}

/** Newest first, and never more than the caller asked for. */
export function recentActivity(rows: ActivityRow[], limit: number): ActivityRow[] {
  return [...rows]
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    .slice(0, Math.max(0, limit));
}
