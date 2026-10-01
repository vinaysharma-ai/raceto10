import { cache } from "react";

import type { ActivityRow, PublicRacer, SearchResult } from "@/lib/race/board";

/**
 * Reading the public race.
 *
 * Everything pure lives in `src/lib/race/board.ts`; this module holds the reads
 * and the port they go through. It imports `react.cache` and the server
 * Supabase client, so it must not reach the browser bundle.
 *
 * Every query here hits a public *view*, never a table. `public_racers` and
 * `public_race_events` are owner's-rights views whose column lists are the
 * security boundary — they cannot return an email, a baseline, or a provider
 * reference, because those columns are not in them.
 */

export type RaceBoard = {
  racers: PublicRacer[];
  activity: ActivityRow[];
};

export type RaceBoardResult =
  | { ok: true; board: RaceBoard }
  /** The race could not be read. Distinct from "nobody has signed up". */
  | { ok: false; reason: string };

type Rows = { data: Record<string, unknown>[] | null; error: { message: string } | null };

/**
 * What this module needs from storage, named as the reads it performs rather
 * than as a mirror of the client's fluent builder. A port that says "give me
 * the racers, give me the last N events" is smaller and harder to misuse.
 */
export type RaceBoardReader = {
  listRacers(): PromiseLike<Rows>;
  listActivity(limit: number): PromiseLike<Rows>;
  search(query: string): PromiseLike<Rows>;
};

/** How many feed rows the landing page shows. The list is a window, not an archive. */
export const ACTIVITY_LIMIT = 12;

export async function readRaceBoard(
  reader: RaceBoardReader,
  limit: number = ACTIVITY_LIMIT,
): Promise<RaceBoardResult> {
  try {
    const [racers, activity] = await Promise.all([
      reader.listRacers(),
      reader.listActivity(limit),
    ]);

    const firstError = racers.error ?? activity.error;
    if (firstError) return { ok: false, reason: firstError.message };
    if (!racers.data || !activity.data) {
      return { ok: false, reason: "the race board returned no rows" };
    }

    return {
      ok: true,
      board: {
        racers: racers.data as unknown as PublicRacer[],
        activity: activity.data as unknown as ActivityRow[],
      },
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export type SearchResultPage =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: string };

/**
 * Searches the public projection.
 *
 * `public_search` rather than `public_racers`, and the difference is the point:
 * the search view carries no location and no customer count, so an arbitrary
 * substring query cannot be used to profile the board without loading it.
 *
 * The needle is escaped before it reaches the filter. A `%` or `_` typed into a
 * search box is a literal character to the person typing it, and passing it
 * through unescaped would make it a wildcard — turning a search for "100%" into
 * a match against everything.
 */
export async function readSearch(
  reader: RaceBoardReader,
  query: string,
): Promise<SearchResultPage> {
  try {
    const trimmed = query.trim();
    if (!trimmed) return { ok: true, results: [] };

    const { data, error } = await reader.search(trimmed);
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: "the search returned no rows" };

    return { ok: true, results: data as unknown as SearchResult[] };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Turns a typed search into a substring safe to embed in a PostgREST filter.
 *
 * ## Two grammars, and only one of them was being escaped
 *
 * The obvious half is LIKE: `%` and `_` are wildcards, and `\` escapes them. A
 * search for `100%` passed through raw matches everything.
 *
 * The half that is easy to miss is PostgREST's own filter grammar. The `.or()`
 * call takes a single string in which `,` separates conditions, `.` separates
 * column from operator from value, and `(`/`)` group. So a search for
 * `ada,product_name.not.is.null` does not search for that text — it appends a
 * condition to the query.
 *
 * ## Why this is one function rather than two
 *
 * `escapeLike` used to exist on its own, and the caller applied only it. A
 * helper that does half a job is worse than none, because reading the call site
 * suggests the input is handled. This does both, so there is no partial version
 * to reach for.
 *
 * ## Why strip rather than reject
 *
 * The characters that matter to the filter grammar are not ones anybody types
 * into a search box hoping to match them literally. Dropping them costs a
 * search for "Ledger.ly" nothing — it still matches "Ledgerly" — while
 * rejecting the query would turn a harmless keystroke into an error.
 *
 * The length cap is applied first so the escaping cannot be truncated
 * mid-sequence, and it bounds the work an arbitrary query can ask for.
 */
export function buildSearchPattern(raw: string): string {
  return raw
    .trim()
    .slice(0, 64)
    // LIKE: the escape character itself, then the two wildcards.
    .replace(/[\\%_]/g, (char) => `\\${char}`)
    // PostgREST filter grammar: condition separator, column/operator
    // separator, grouping, quoting, and the `*` some operators use.
    .replace(/[,.():*"']/g, "");
}

/**
 * The Supabase-backed reader.
 *
 * Imported lazily so that loading this module — which the tests do — does not
 * drag in `next/headers` or the Supabase client.
 */
async function supabaseRaceBoardReader(): Promise<RaceBoardReader> {
  const { createClient } = await import("@/lib/supabase/server");
  const db = await createClient();

  return {
    listRacers: () =>
      db
        .from("public_racers")
        .select(
          "public_slug, founder_name, x_handle, product_name, status, current_customer_count, activated_at, race_end_at, reached_ten_at, created_at, city, country, latitude, longitude",
        )
        .order("created_at", { ascending: false }),

    listActivity: (limit) =>
      db
        .from("public_race_events")
        .select(
          "event_type, milestone_customer_count, occurred_at, public_slug, founder_name, x_handle, product_name, city, country",
        )
        .order("occurred_at", { ascending: false })
        .limit(limit),

    search: (query) => {
      // Built once so all three conditions carry the same, fully neutralised
      // pattern. No raw user text reaches the filter grammar.
      const pattern = buildSearchPattern(query);

      return db
        .from("public_search")
        .select("public_slug, founder_name, x_handle, product_name")
        .or(
          [
            `founder_name.ilike.%${pattern}%`,
            `x_handle.ilike.%${pattern}%`,
            `product_name.ilike.%${pattern}%`,
          ].join(","),
        )
        .limit(50);
    },
  };
}

/** One read per request, shared by the globe, the feed and the leaderboard. */
export const getRaceBoard = cache(async (): Promise<RaceBoardResult> => {
  try {
    return await readRaceBoard(await supabaseRaceBoardReader());
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
});

/** One search per request. Not cached — every query is a different question. */
export async function searchPublicRacers(query: string): Promise<SearchResultPage> {
  try {
    return await readSearch(await supabaseRaceBoardReader(), query);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
