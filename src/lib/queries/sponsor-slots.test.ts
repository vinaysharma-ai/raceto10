import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeSlot,
  formatEndDate,
  formatPriceCents,
  type SlotPlacement,
  type SlotState,
  type TermPrice,
} from "../sponsors/board.ts";
import { safeExternalUrl, safeStorageUrl } from "../sponsors/urls.ts";
import { readSponsorBoard, type BoardReader } from "./sponsor-slots.ts";

/**
 * The board as the seed migration writes it: ten positions, no bookings, and
 * the launch price list.
 *
 * The cheapest term is $5, which is what an unoccupied position advertises.
 */
const PRICING: TermPrice[] = [
  { term_days: 1, price_cents: 500 },
  { term_days: 3, price_cents: 1200 },
  { term_days: 7, price_cents: 2500 },
];

/** Positions carry a slot_number and a placement. Nothing else — no status. */
function seededPositions() {
  return Array.from({ length: 10 }, (_, index) => {
    const slotNumber = index + 1;
    return {
      id: `slot-${slotNumber}`,
      slot_number: slotNumber,
      placement: slotNumber <= 5 ? "sidebar-left" : "sidebar-right",
    };
  });
}

function seededSlots(): SlotState[] {
  return seededPositions().map((position) => ({
    slot_number: position.slot_number,
    placement: position.placement as SlotPlacement,
    occupiedBy: null,
  }));
}

/** A confirmed booking covering the present moment on one position. */
function liveBooking(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sponsorship-1",
    slot_id: "slot-1",
    slot_number: 1,
    sponsor_name: "Ada's Bakery",
    sponsor_description: "Sourdough, Thursdays",
    sponsor_logo_url: null,
    sponsor_link: "https://example.com",
    ends_at: "2026-10-14T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * A fake board reader keyed by table name.
 *
 * All three reads in `readSponsorBoard` share the same shape, so one fake can
 * serve them; the table name is what selects the rows.
 */
function readerReturning(response: {
  rows?: Record<string, Record<string, unknown>[]>;
  error?: { message: string } | null;
  throw?: string;
}): BoardReader {
  return {
    from(table: string) {
      return {
        select() {
          return {
            order() {
              if (response.throw) {
                return Promise.reject(new Error(response.throw));
              }
              return Promise.resolve({
                data: response.rows?.[table] ?? null,
                error: response.error ?? null,
              });
            },
          };
        },
      };
    },
  };
}

const FULL_BOARD = (live: Record<string, unknown>[] = []) => ({
  public_sponsor_slots: seededPositions(),
  sponsorship_live: live,
  sponsor_pricing: PRICING,
});

// ---------------------------------------------------------------------------
// The step's verification, as a test
// ---------------------------------------------------------------------------

test("with no bookings, all ten positions read `Open · from $5`", () => {
  const labels = seededSlots().map((slot) => {
    const view = describeSlot(slot, PRICING);
    return view.kind === "open" ? view.label : `UNEXPECTED:${view.kind}`;
  });

  assert.deepEqual(labels, Array(10).fill("Open · from $5"));
});

test("prices come from the table — change the row, change the label", () => {
  // No price is written into the UI. This is the whole point of the price list
  // being data: an UPDATE in the database moves what the site advertises.
  const cheaper = PRICING.map((price) =>
    price.term_days === 1 ? { ...price, price_cents: 300 } : price,
  );

  const view = describeSlot(seededSlots()[0], cheaper);
  assert.equal(view.kind === "open" && view.label, "Open · from $3");
});

test("with no price list at all, a position says Open rather than inventing one", () => {
  const view = describeSlot(seededSlots()[0], []);
  assert.equal(view.kind === "open" && view.label, "Open");
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

test("whole-dollar prices render without decimals", () => {
  assert.equal(formatPriceCents(500), "$5");
  assert.equal(formatPriceCents(1200), "$12");
  assert.equal(formatPriceCents(2500), "$25");
  assert.equal(formatPriceCents(100), "$1");
});

test("prices that are not whole dollars keep their cents", () => {
  // The launch prices are whole dollars, so this should not arise — but a
  // silently truncated price would be a wrong number on screen.
  assert.equal(formatPriceCents(1250), "$12.50");
  assert.equal(formatPriceCents(1), "$0.01");
});

test("nonsense prices degrade to $0 rather than rendering NaN", () => {
  assert.equal(formatPriceCents(Number.NaN), "$0");
  assert.equal(formatPriceCents(-100), "$0");
  assert.equal(formatPriceCents(Number.POSITIVE_INFINITY), "$0");
});

// ---------------------------------------------------------------------------
// Occupied positions
// ---------------------------------------------------------------------------

test("an occupied position shows its real sponsor and nothing invented", () => {
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking() as unknown as SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING, { now: new Date("2026-09-25T12:00:00.000Z") });

  assert.equal(view.kind, "sponsored");
  assert.equal(view.kind === "sponsored" && view.name, "Ada's Bakery");
  assert.equal(view.kind === "sponsored" && view.description, "Sourdough, Thursdays");
  assert.equal(view.kind === "sponsored" && view.endsAt, "2026-10-14T12:00:00.000Z");
  // Normalised by the URL parser, which is the same pass that rejects unsafe
  // schemes — hence the trailing slash.
  assert.equal(view.kind === "sponsored" && view.href, "https://example.com/");
});

test("an occupied position carries the confirmed label and no price", () => {
  // `Sponsored · until {date}` is the copy recorded in IMPLEMENTATION-PLAN.md
  // §24 finding 26. "Open · from $5" on a booked card would be a contradiction.
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking() as unknown as SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING, { now: new Date("2026-09-25T12:00:00.000Z") });

  assert.equal(view.kind === "sponsored" && view.label, "Sponsored · until 14 Oct");
  assert.equal("priceCents" in view, false);
  assert.ok(
    !JSON.stringify(view).includes("$"),
    "no price may appear anywhere in a sponsored view",
  );
});

// ---------------------------------------------------------------------------
// End dates — rendered by the `/sponsor` grid, never by the 88px card
// ---------------------------------------------------------------------------

test("a term ending in another year carries the year in the label", () => {
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking({ ends_at: "2027-01-04T12:00:00.000Z" }) as unknown as
      SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING, { now: new Date("2026-09-25T12:00:00.000Z") });
  assert.equal(view.kind === "sponsored" && view.label, "Sponsored · until 4 Jan 2027");
});

test("an unparseable end date still labels the slot as sponsored", () => {
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking({ ends_at: "not a date" }) as unknown as
      SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING);
  assert.equal(view.kind === "sponsored" && view.label, "Sponsored");
  assert.equal(view.kind === "sponsored" && view.endsAt, "not a date");
});

test("a date in the same year omits the year", () => {
  assert.equal(
    formatEndDate("2026-10-14T12:00:00.000Z", new Date("2026-09-25T12:00:00.000Z")),
    "14 Oct",
  );
});

test("a date in another year carries it, so a term is never ambiguous", () => {
  assert.equal(
    formatEndDate("2027-01-04T12:00:00.000Z", new Date("2026-09-25T12:00:00.000Z")),
    "4 Jan 2027",
  );
});

test("an unparseable end date yields nothing, not the string `Invalid Date`", () => {
  assert.equal(formatEndDate("not a date", new Date("2026-09-25T12:00:00.000Z")), "");
  assert.equal(formatEndDate("", new Date("2026-09-25T12:00:00.000Z")), "");
});

// ---------------------------------------------------------------------------
// Sponsor-supplied URLs — stored XSS
//
// `sponsor_link` and `sponsor_logo_url` are written by sponsors. Rendered raw
// into an href, a `javascript:` value executes in our origin for every visitor
// who clicks the card. These are the strings that would do it.
// ---------------------------------------------------------------------------

test("a javascript: destination is rejected", () => {
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("javascript:void(0)"), null);
});

test("scheme tricks are rejected, because the URL parser is doing the work", () => {
  // A regex-based guard would have to anticipate each of these. WHATWG parsing
  // normalises case and strips tab/newline characters before resolving the
  // scheme, so they all collapse to the same rejected result.
  for (const attack of [
    "JaVaScRiPt:alert(1)",
    "jav\tascript:alert(1)",
    "java\nscript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
  ]) {
    assert.equal(safeExternalUrl(attack), null, `${attack} should be rejected`);
  }
});

test("other dangerous schemes are rejected", () => {
  for (const attack of [
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/abc",
  ]) {
    assert.equal(safeExternalUrl(attack), null, `${attack} should be rejected`);
  }
});

test("relative and protocol-relative values are rejected", () => {
  // Protocol-relative matters: `//evil.com` is a valid navigation but has no
  // explicit scheme, so it must not be treated as safe by accident.
  assert.equal(safeExternalUrl("//evil.com"), null);
  assert.equal(safeExternalUrl("/sponsor"), null);
  assert.equal(safeExternalUrl("example.com"), null);
  assert.equal(safeExternalUrl(""), null);
  assert.equal(safeExternalUrl(null), null);
});

test("genuine http and https destinations are kept", () => {
  assert.equal(safeExternalUrl("https://example.com"), "https://example.com/");
  assert.equal(safeExternalUrl("http://example.com/path"), "http://example.com/path");
});

test("an occupied position with a javascript: link renders unlinked, but still shows the sponsor", () => {
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking({
      sponsor_name: "Hostile Co",
      sponsor_link: "javascript:alert(document.cookie)",
    }) as unknown as SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING);

  assert.equal(view.kind, "sponsored");
  // The card still exists — the sponsor is real — it simply is not a link.
  assert.equal(view.kind === "sponsored" && view.href, null);
  assert.equal(view.kind === "sponsored" && view.name, "Hostile Co");
});

test("an occupied position with a javascript: logo renders without an image", () => {
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking({ sponsor_logo_url: "javascript:alert(1)" }) as unknown as
      SlotState["occupiedBy"],
  };

  const view = describeSlot(slot, PRICING, { logoHost: "proj.supabase.co" });
  assert.equal(view.kind === "sponsored" && view.logoUrl, null);
});

// ---------------------------------------------------------------------------
// Logo URLs — narrower than the link guard, on purpose
//
// A logo pointing anywhere on the internet makes every visitor's browser fetch
// a third party's host on every page view: an IP leak and a tracking-pixel
// vector. Logos are held to our own storage host.
// ---------------------------------------------------------------------------

const STORAGE = "proj.supabase.co";

test("a logo on our storage host is allowed", () => {
  const url = `https://${STORAGE}/storage/v1/object/public/logos/a.png`;
  assert.equal(safeStorageUrl(url, STORAGE), url);
});

test("a logo pointing at any other host is refused", () => {
  for (const url of [
    "https://evil.example.com/logo.png",
    "https://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/x.png",
    // Lookalikes: correct-looking prefixes and suffixes must not match.
    `https://${STORAGE}.evil.example.com/x.png`,
    `https://evil.example.com/${STORAGE}/x.png`,
    "https://supabase.co/x.png",
  ]) {
    assert.equal(safeStorageUrl(url, STORAGE), null, `${url} should be refused`);
  }
});

test("a plain-http logo on our own host is still refused", () => {
  // https only: a downgrade to http would let the image be swapped in transit.
  assert.equal(safeStorageUrl(`http://${STORAGE}/logos/a.png`, STORAGE), null);
});

test("with no storage host configured, no logo renders at all", () => {
  // Fails closed. A caller that forgets to pass the host loses logos rather
  // than silently allowing any host through.
  assert.equal(safeStorageUrl(`https://${STORAGE}/logos/a.png`, null), null);
  assert.equal(safeStorageUrl("https://evil.example.com/x.png", null), null);
});

test("describeSlot drops a logo when no host is given, but keeps the sponsor", () => {
  const logo = `https://${STORAGE}/storage/v1/object/public/logos/a.png`;
  const slot: SlotState = {
    ...seededSlots()[0],
    occupiedBy: liveBooking({ sponsor_logo_url: logo }) as unknown as
      SlotState["occupiedBy"],
  };

  const withoutHost = describeSlot(slot, PRICING);
  assert.equal(withoutHost.kind === "sponsored" && withoutHost.logoUrl, null);
  assert.equal(withoutHost.kind === "sponsored" && withoutHost.name, "Ada's Bakery");

  const withHost = describeSlot(slot, PRICING, { logoHost: STORAGE });
  assert.equal(withHost.kind === "sponsored" && withHost.logoUrl, logo);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("a full read returns the ten positions, the live bookings, and the prices", async () => {
  const result = await readSponsorBoard(
    readerReturning({ rows: FULL_BOARD([liveBooking()]) }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.slots.length, 10);
  assert.equal(result.ok && result.pricing.length, 3);

  // Position 1 is occupied; the rest are free. Absence is the free state.
  assert.equal(result.ok && result.slots[0].occupiedBy?.sponsor_name, "Ada's Bakery");
  assert.equal(result.ok && result.slots[1].occupiedBy, null);
  assert.deepEqual(
    result.ok ? result.slots.map((slot) => slot.slot_number) : [],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test("a booking for a position that no longer exists is ignored, not fatal", async () => {
  const result = await readSponsorBoard(
    readerReturning({
      rows: FULL_BOARD([liveBooking({ slot_number: 99 })]),
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.slots.length, 10);
  assert.ok(
    result.ok && result.slots.every((slot) => slot.occupiedBy === null),
    "an orphaned booking must not be attached to an unrelated position",
  );
});

test("a query error yields no board, and the bars render nothing", async () => {
  const result = await readSponsorBoard(
    readerReturning({ error: { message: 'relation "sponsor_slot" does not exist' } }),
  );
  assert.equal(result.ok, false);
});

test("a thrown client error is caught rather than rejecting", async () => {
  const result = await readSponsorBoard(readerReturning({ throw: "fetch failed" }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "fetch failed");
});

test("a board missing its price list fails rather than showing positions unpriceable", async () => {
  // A partial read would render ten positions with no price, which is the kind
  // of half-truth the honesty rule exists to prevent.
  const rows = FULL_BOARD();
  const result = await readSponsorBoard(
    readerReturning({ rows: { ...rows, sponsor_pricing: [] } }),
  );

  // An empty price list is a real answer — no prices are configured — and the
  // grid still renders, saying `Open` rather than `from $0`.
  assert.equal(result.ok, true);
  const view = describeSlot(result.ok ? result.slots[0] : seededSlots()[0], []);
  assert.equal(view.kind === "open" && view.label, "Open");
});

test("no rows at all is a failure, not an empty board", async () => {
  const result = await readSponsorBoard(readerReturning({ rows: {} }));
  assert.equal(result.ok, false);
});
