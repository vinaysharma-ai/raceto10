import { NextResponse } from "next/server";

import { getRaceBoard } from "@/lib/queries/race-board";
import { racersOnTheBoard, searchRacers } from "@/lib/race/board";

/**
 * The hero search box's one read.
 *
 * ## Why this reads the board rather than the search view
 *
 * `public_search` exists and `searchPublicRacers` already queries it, but it
 * cannot answer the question the box has to answer when it finds nothing: is
 * that because nobody matched, or because nobody is racing yet? Those are
 * different sentences and only one of them is true. Reading the board once
 * answers both — the same list the leaderboard ranks, filtered by the same pure
 * function the leaderboard uses, so the two surfaces cannot disagree.
 *
 * The filter is applied in process, not in SQL, because the board is already
 * small enough to hold and `searchRacers` is the exact predicate the
 * leaderboard renders with. Phase 7 moves this onto the `public_search` view
 * with a `limit 8`; until then one cached read is the honest, smallest thing.
 *
 * ## It never returns an error body
 *
 * A failed read is `ok: false`, and the box turns that into a sentence a person
 * can read. Nothing here echoes a PostgREST message, and nothing throws.
 */

export const dynamic = "force-dynamic";

/** How many matches the dropdown shows before it stops being a dropdown. */
const LIMIT = 8;

export type SearchResponse = {
  results: {
    public_slug: string;
    founder_name: string | null;
    x_handle: string | null;
    product_name: string | null;
  }[];
  /** Racers actually in a race. Zero means "nobody has started", not "no match". */
  racing: number;
  /** The read failed. Distinct from an empty result. */
  unavailable?: true;
};

export async function GET(request: Request): Promise<NextResponse<SearchResponse>> {
  const query = new URL(request.url).searchParams.get("q") ?? "";

  // The box only asks once there are two characters, but a hand-made request
  // can arrive with anything. Below the threshold there is nothing to answer.
  if (query.trim().length < 2) {
    return NextResponse.json({ results: [], racing: 0 });
  }

  const board = await getRaceBoard();

  if (!board.ok) {
    return NextResponse.json({ results: [], racing: 0, unavailable: true });
  }

  const racing = racersOnTheBoard(board.board.racers);

  return NextResponse.json({
    results: searchRacers(racing, query)
      .slice(0, LIMIT)
      .map((racer) => ({
        public_slug: racer.public_slug,
        founder_name: racer.founder_name,
        x_handle: racer.x_handle,
        product_name: racer.product_name,
      })),
    racing: racing.length,
  });
}
