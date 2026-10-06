import { NextResponse } from "next/server";

import { anyRacersOnTheBoard, searchPublicRacers } from "@/lib/queries/race-board";

/**
 * The hero search box's one read.
 *
 * ## Backed by `public_search`, not by the board
 *
 * This used to read the whole race board through `getRaceBoard` and filter it in
 * process, which worked and was the wrong shape: it moved every racer and twelve
 * activity rows across the wire to answer a question about at most eight of
 * them, and the filter lived in JavaScript rather than in the query.
 *
 * `public_search` is the view built for this. It is deliberately narrower than
 * `public_racers` — no location, no customer count, no timings — so an arbitrary
 * substring query cannot be used to profile the board without loading it. The
 * pattern is escaped for both LIKE and PostgREST's own filter grammar by
 * `buildSearchPattern`, and the view caps the result at eight.
 *
 * ## The two empty answers
 *
 * A search that finds nothing is either "no match" or "nobody has started a race
 * yet", and those are different sentences. Only the second one is worth acting
 * on, and telling somebody the first when the truth is the second sends them
 * hunting for a spelling mistake. So an empty result costs one more question —
 * whether the board has anybody on it at all — asked only in that case.
 *
 * ## It never returns an error body
 *
 * A failed read is reported as `unavailable`, and the box turns that into a
 * sentence. Nothing here echoes a PostgREST message, and nothing throws.
 */

export const dynamic = "force-dynamic";

export type SearchResponse = {
  results: {
    public_slug: string;
    founder_name: string | null;
    x_handle: string | null;
    product_name: string | null;
  }[];
  /** Whether anybody is on the board. Null when it could not be determined. */
  anyoneRacing: boolean | null;
  /** The read failed. Distinct from an empty result. */
  unavailable?: true;
};

export async function GET(request: Request): Promise<NextResponse<SearchResponse>> {
  const query = new URL(request.url).searchParams.get("q") ?? "";

  // The box only asks once there are two characters, but a hand-made request
  // can arrive with anything. Below the threshold there is nothing to answer.
  if (query.trim().length < 2) {
    return NextResponse.json({ results: [], anyoneRacing: null });
  }

  const found = await searchPublicRacers(query);

  if (!found.ok) {
    return NextResponse.json({ results: [], anyoneRacing: null, unavailable: true });
  }

  if (found.results.length > 0) {
    return NextResponse.json({ results: found.results, anyoneRacing: true });
  }

  // Nothing matched. The only question left is whether that is because nobody
  // is racing, which is a different sentence.
  return NextResponse.json({
    results: [],
    anyoneRacing: await anyRacersOnTheBoard(),
  });
}
