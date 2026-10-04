import { WorldGlobe } from "./world-globe";

import { env } from "@/lib/env";
import { getRaceBoard } from "@/lib/queries/race-board";
import { activityLines, globeDots } from "@/lib/race/board";

/**
 * The globe section — the centre of the landing page.
 *
 * It reads the same two queries the leaderboard does, so the dots, the feed and
 * the board below can never disagree about who is racing. There is no separate
 * "globe data" that could drift from the real thing.
 *
 * ## The map renders whether or not the read succeeded
 *
 * Hiding the whole section on a database hiccup would take the page's
 * centrepiece down with it. The coastline claims nothing on its own — there are
 * no dots and no count. What has to stay honest is the *sentence*, so an
 * unreadable race and an empty one say different things rather than both
 * rendering as a silent map.
 */
export async function RaceGlobe() {
  const result = await getRaceBoard();

  if (!result.ok && process.env.NODE_ENV !== "production") {
    console.warn(`[race-globe] no data rendered: ${result.reason}`);
  }

  const racers = result.ok ? result.board.racers : [];
  const feed = result.ok ? activityLines(result.board.activity, new Date(), 8) : [];

  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-12">
      <WorldGlobe
        dots={globeDots(racers)}
        feed={feed}
        live={result.ok}
        token={env.NEXT_PUBLIC_MAPBOX_TOKEN}
      />
    </section>
  );
}
