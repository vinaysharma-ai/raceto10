import { ImageResponse } from "next/og";

import { BrandCard, OG_CONTENT_TYPE, OG_SIZE } from "@/components/brand/og-card";
import { HEADLINE } from "@/lib/headline";

/**
 * The card every link to this site unfurls into.
 *
 * Static: no parameters, no reader, no clock. It is the same image for the home
 * page, the leaderboard and anything else that does not set its own, and it is
 * generated once at build time rather than per request.
 *
 * `/r/[handle]` sets its own; `src/app/r/[handle]/opengraph-image.tsx` falls
 * back to this one whenever that racer is unknown, so a link to a page that
 * turned out to 404 still unfurls into the product rather than into nothing.
 */

export const alt = HEADLINE;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return new ImageResponse(<BrandCard />, { ...OG_SIZE });
}
