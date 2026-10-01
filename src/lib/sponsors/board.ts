// Explicit `.ts` extension, as everywhere else in this repo: Node's native
// type-stripping (which runs the tests) does not resolve extensionless relative
// imports, and `allowImportingTsExtensions` is set for exactly this reason.
import { safeExternalUrl, safeStorageUrl } from "./urls.ts";

/**
 * The sponsor board's shapes and its rendering rules.
 *
 * Pure and dependency-free — no database client, no `react.cache`. The reading
 * half lives in `src/lib/queries/sponsor-slots.ts`, which imports from here.
 * The split exists because the `/sponsor` grid is a client component and cannot
 * pull the server module into its bundle.
 *
 * ## Positions and bookings are different things
 *
 * A position is one of ten, permanently. It carries no price, no holder and no
 * status. What occupies it is a *sponsorship* — a booked term with a start and
 * an end. `sponsor_slot` holds the first; `sponsorship` holds the second.
 *
 * **A position is free when no confirmed sponsorship covers the current
 * instant.** That is a query, not a column. Nothing has to expire for a
 * sponsorship to end, and a cron job that never ran leaves the display correct
 * rather than stale.
 */

export type SlotPlacement = "sidebar-left" | "sidebar-right" | "bar-top" | "bar-bottom";

/** One row of the price list. Prices are data; this is the only shape they take. */
export type TermPrice = {
  term_days: number;
  price_cents: number;
};

/** A confirmed, currently-in-window booking. Comes from `sponsorship_live`. */
export type LiveSponsorship = {
  id: string;
  slot_id: string;
  slot_number: number;
  sponsor_name: string;
  sponsor_description: string;
  sponsor_logo_url: string | null;
  sponsor_link: string;
  ends_at: string;
};

export type SlotState = {
  slot_number: number;
  placement: SlotPlacement;
  /** Null means free. Absence is the state — there is no "open" row. */
  occupiedBy: LiveSponsorship | null;
};

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** `500` -> `$5`, and `1250` -> `$12.50`. Whole dollars stay whole. */
export function formatPriceCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "$0";
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * "14 Oct", or "4 Jan 2027" once the year differs — a date a buyer reading the
 * `/sponsor` grid can act on. Never the literal string "Invalid Date": an
 * unparseable value returns empty, and callers render nothing rather than
 * something wrong.
 */
export function formatEndDate(iso: string, now: Date = new Date()): string {
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return "";

  const sameYear = end.getFullYear() === now.getFullYear();
  return end.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The cheapest term — the honest reading of "from". Null when unpriceable. */
export function cheapestPriceCents(pricing: TermPrice[]): number | null {
  const priced = pricing
    .map((price) => price.price_cents)
    .filter((cents) => Number.isFinite(cents) && cents > 0);

  return priced.length ? Math.min(...priced) : null;
}

export type SlotView =
  | { kind: "open"; label: string }
  | {
      kind: "sponsored";
      /**
       * `Sponsored · until 4 Jan 2027` — the confirmed wording from
       * `IMPLEMENTATION-PLAN.md` §24 finding 26.
       *
       * Not rendered on the card: DESIGN-SYSTEM.md sizes a sold slot at logo,
       * name and one line, and an 88px card has no room for a fourth. The
       * `/sponsor` grid renders it instead, which is where a buyer is choosing
       * between positions and "until when" is what they need.
       */
      label: string;
      name: string;
      description: string;
      logoUrl: string | null;
      href: string | null;
      endsAt: string;
    };

/**
 * What a position shows.
 *
 * An unoccupied position shows the real starting price, read from the price
 * list. An occupied one shows its real sponsor and when the term ends. There is
 * no third rendering in which a position is dressed up to look occupied, and no
 * number here is invented.
 *
 * `href` and `logoUrl` are returned already sanitised. Callers must render
 * those, never a raw `sponsor_link` or `sponsor_logo_url`.
 */
export function describeSlot(
  slot: SlotState,
  pricing: TermPrice[],
  options: { logoHost?: string | null; now?: Date } = {},
): SlotView {
  const now = options.now ?? new Date();

  if (slot.occupiedBy) {
    const s = slot.occupiedBy;
    // `ends_at` is `not null` in the schema, so an unparseable value means
    // something upstream is broken. Say less rather than render a dangling
    // "until " or the literal string "Invalid Date".
    const ends = formatEndDate(s.ends_at, now);
    return {
      kind: "sponsored",
      label: ends ? `Sponsored · until ${ends}` : "Sponsored",
      name: s.sponsor_name,
      description: s.sponsor_description,
      logoUrl: safeStorageUrl(s.sponsor_logo_url, options.logoHost ?? null),
      href: safeExternalUrl(s.sponsor_link),
      endsAt: s.ends_at,
    };
  }

  const cheapest = cheapestPriceCents(pricing);

  return {
    kind: "open",
    label: cheapest === null ? "Open" : `Open · from ${formatPriceCents(cheapest)}`,
  };
}

// `slotsForRail` and `slotsForBar` lived here. They split the ten positions
// across two desktop rails and two mobile bars, and both the helpers and the
// rails themselves are gone: the landing page now shows five positions in one
// quiet row, and `/sponsor` shows the full board as a grid.
//
// `placement` stays on `SlotState` even though nothing lays out by it any more.
// It is a real, seeded column describing where a position sits, and dropping it
// from the read would make the type stop describing the table — but note that
// no component currently reads it, so a change to it would now have no visible
// effect.
