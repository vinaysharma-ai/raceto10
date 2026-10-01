import type { Metadata } from "next";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { SponsorGrid } from "@/components/sponsors/sponsor-grid";
import { NotOpenYet } from "@/components/ui/not-open-yet";
import { getSponsorBoard } from "@/lib/queries/sponsor-slots";
import { cheapestPriceCents, formatPriceCents } from "@/lib/sponsors/board";
import { SPONSOR_TERMS, describeTerm } from "@/lib/sponsors/limits";

/**
 * `/sponsor` — the ten positions.
 *
 * ## Not open yet, and it says so the same way `/join` does
 *
 * Sponsorship has no payment provider. The schema, the price list and the
 * exclusion constraint that makes double-selling impossible are all built and
 * tested, but nothing can take money, so the page shows the same
 * `NotOpenYet` panel `/join` uses rather than a buy button that fails.
 *
 * That is the whole reason the panel is a shared component: two places where
 * the product says "not yet" should not drift into saying it differently.
 *
 * ## What is still real on this page
 *
 * The positions, which ones are taken, and what each term costs. All of it read
 * from the database. What is absent is the ability to buy one, and the page
 * does not pretend otherwise.
 */

export const metadata: Metadata = {
  title: "Sponsor RaceTo10",
  description:
    "Ten sponsor positions on the RaceTo10 site. Fixed prices, no bidding, terms of 1, 3 or 7 days.",
};

export default async function SponsorPage() {
  const board = await getSponsorBoard();
  const pricing = board.ok ? board.pricing : [];
  const cheapest = cheapestPriceCents(pricing);

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-medium">Sponsor RaceTo10</h1>

        <p className="mt-3 max-w-2xl text-small text-text-muted prose">
          Ten positions on this site. A fixed price per term, no bidding and no
          auction — if it is free, it is yours.
          {cheapest === null
            ? null
            : ` Terms run ${SPONSOR_TERMS.map(describeTerm).join(", ")}, from ${formatPriceCents(cheapest)}.`}
        </p>

        <div className="mt-8">
          {board.ok ? (
            <SponsorGrid slots={board.slots} pricing={board.pricing} />
          ) : (
            // An empty grid and an unreadable grid look identical, and only one
            // of them means "everything is free". Say which.
            //
            // The reassurance stops here rather than repeating: the panel below
            // already says nothing has been charged, and saying it twice in a
            // row reads as protesting.
            <p className="text-small text-text" role="alert">
              The positions could not be loaded just now.
            </p>
          )}
        </div>

        <div className="mt-12">
          <NotOpenYet title="Sponsorship isn't open yet">
            <p>
              We haven&apos;t switched on payments for sponsor positions, so
              there is no way to take one today.
            </p>
            <p>
              The positions above are real — the ones marked open are open — but
              nothing has been charged to anyone and nothing is reserved.
            </p>
            {/* No "leave your email and we'll tell you". Nothing in V1 sends
                mail, and the home page's list says so in as many words — so
                pointing here from there would be routing people to a promise
                this page cannot keep. */}
            <p>Positions will go on sale here once payments are switched on.</p>
          </NotOpenYet>
        </div>
      </main>

      <Footer />
    </>
  );
}
