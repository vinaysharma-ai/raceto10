import { SponsorSlotCard } from "./sponsor-slot-card";

import type { SlotState, TermPrice } from "@/lib/sponsors/board";

/**
 * The ten positions, as a grid, on `/sponsor`.
 *
 * A server component with no state, because there is nothing to interact with
 * yet — clicking a slot goes to `/sponsor`, which is where you already are, so
 * the cards here are informational rather than controls. The previous version
 * was a client component that opened a term-and-pay modal; that modal is gone
 * until there is a payment provider to put behind it.
 *
 * The cards are the same `SponsorSlotCard` the landing page renders — same
 * fixed size, same labels — so a position cannot look like one thing here and
 * another thing on the landing page.
 */
export function SponsorGrid({
  slots,
  pricing,
}: {
  slots: SlotState[];
  pricing: TermPrice[];
}) {
  return (
    <ul className="flex flex-wrap gap-3">
      {slots.map((slot) => (
        <li key={slot.slot_number} className="flex flex-col gap-1.5">
          {/* Position numbers are only useful here — on the landing page strip
              they would be noise on a 76px card. */}
          <span className="text-small text-text-muted">
            Position {slot.slot_number}
          </span>
          <SponsorSlotCard slot={slot} pricing={pricing} />
        </li>
      ))}
    </ul>
  );
}
