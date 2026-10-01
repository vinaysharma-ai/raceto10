import Link from "next/link";

import { SponsorSlotCard } from "./sponsor-slot-card";

import { getSponsorBoard } from "@/lib/queries/sponsor-slots";

/**
 * Five sponsor positions, near the bottom of the landing page.
 *
 * ## Framed as a signal, not a request
 *
 * There is no headline pitching sponsorship, no list of benefits, and no "get
 * in front of thousands of founders". A visitor should come away knowing
 * sponsorship exists here; they should not be sold to on the way to the race.
 * Five cards and a one-word label, deliberately smaller and quieter than
 * everything above it.
 *
 * ## Five, not ten
 *
 * The board has ten positions. An earlier version showed all ten as persistent
 * rails down both sides of every page, which made the sponsor inventory the
 * loudest repeating element on a site whose product is racing founders. Five
 * cards in one quiet row is enough presence to be understood; `/sponsor` still
 * shows the full board, which is where someone who wants one goes.
 */
export async function SponsorStrip() {
  const result = await getSponsorBoard();

  // Nothing rather than an apology. If the board cannot be read there is no
  // honest sponsor section to show, and an error box here would be louder than
  // the section it replaces.
  if (!result.ok) return null;

  const slots = result.slots.slice(0, 5);
  if (slots.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-12">
      <h2 className="text-small text-text-muted">Sponsors</h2>

      <ul className="mt-3 flex flex-wrap gap-3">
        {slots.map((slot) => (
          <li key={slot.slot_number}>
            <SponsorSlotCard slot={slot} pricing={result.pricing} />
          </li>
        ))}

        {/* The route into `/sponsor`, as a sixth card in the same row rather
            than a button beside the heading. It keeps the row uniform and keeps
            the ask at the weight of the thing being asked about.

            Written out rather than reusing `SponsorSlotCard` with a fabricated
            slot: passing a made-up position through a component that renders
            real positions is how a placeholder ends up on screen. */}
        <li>
          <Link
            href="/sponsor"
            className="flex h-[76px] w-[164px] shrink-0 flex-col justify-center rounded-card border border-dashed border-border px-4 text-small text-text-muted transition-colors hover:border-text hover:text-text focus-visible:border-text focus-visible:text-text focus-visible:outline-none"
          >
            All 10 positions →
          </Link>
        </li>
      </ul>
    </section>
  );
}
