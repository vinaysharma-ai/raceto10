import { ImageResponse } from "next/og";

import { BrandCard, OG_CONTENT_TYPE, OG_SIZE, RacerCard } from "@/components/brand/og-card";
import { getPublicRacer } from "@/lib/queries/race-board";
import { RACE_TARGET, finishedLabel, progressOf, type PublicRacer } from "@/lib/race/board";

/**
 * One racer's link card.
 *
 * ## It reads the same view the page does
 *
 * `public_racers` is the boundary, so this cannot show a product name, a handle
 * or a count that `/r/[handle]` would refuse to. There is no second query and
 * no second definition of what is public.
 *
 * ## An unknown handle is not an error
 *
 * A link to a racer who has since withdrawn, or to a slug that never existed,
 * has to unfurl into *something*. Failing here would give the scraper a broken
 * image on a link somebody already pasted. So the fallback is the brand card,
 * which is true about the site and says nothing about the racer.
 *
 * ## Why the status line is spelled out rather than derived from the status
 *
 * "expired" is a database word. "ran out of time at 6 of 10" is what happened,
 * and it is the sentence that makes the card worth looking at — a card that
 * says only "expired" tells a reader nothing they could not guess.
 */

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "A race on raceto10";

/** Cached for five minutes. A count that moves that often needs no fresher card. */
export const revalidate = 300;

/** The prominent line, and whether it is the green "finished" treatment. */
function statusOf(racer: PublicRacer): { status: string; done: boolean } {
  if (racer.status === "finished") {
    // Every finished racer has ten customers, so the time is the only thing
    // that tells two of them apart.
    return { status: finishedLabel(racer) ?? "finished", done: true };
  }

  if (racer.status === "racing") return { status: "racing", done: false };

  if (racer.status === "expired") {
    return {
      status: `ran out of time at ${progressOf(racer)} of ${RACE_TARGET}`,
      done: false,
    };
  }

  // Registered, ready, ineligible, withdrawn, disqualified. Real states of a
  // real row, none of them a race, and none of them worth inventing a verb for.
  return { status: "not racing", done: false };
}

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const racer = await getPublicRacer(handle);

  if (!racer) return new ImageResponse(<BrandCard />, { ...OG_SIZE });

  const { status, done } = statusOf(racer);

  return new ImageResponse(
    <RacerCard
      // The handle only where X proved it; `public_racers` takes it from the
      // profile, and the one writer is the callback reading an X identity.
      who={racer.x_handle ? `@${racer.x_handle}` : (racer.founder_name ?? racer.public_slug)}
      product={racer.product_name}
      count={progressOf(racer)}
      status={status}
      done={done}
    />,
    { ...OG_SIZE },
  );
}
