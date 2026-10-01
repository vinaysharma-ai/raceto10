import { safeExternalUrl } from "./urls.ts";

/**
 * Placing a hold on a sponsor position.
 *
 * ## What a hold is, and what it is not
 *
 * A hold is a `pending` sponsorship row — not a flag on the position. That
 * choice is what makes the concurrency problem disappear rather than get
 * managed: the exclusion constraint on `sponsorship` refuses a second
 * overlapping booking outright, so two sponsors who both click at 10:00:00
 * cannot both end up holding position 4. No `SELECT … FOR UPDATE`, no
 * read-then-write, no window in which both callers believe they were first.
 *
 * **The winner is decided before any money moves.** That is the whole point of
 * settling it here rather than at the payment step.
 *
 * ## No payment in this module
 *
 * Nothing here touches Stripe or any other processor. `placeHold` creates the
 * reservation and stops; the checkout steps that follow are a later step, and
 * deliberately not stubbed out here — an unimplemented payment path that looked
 * implemented would be worse than an absent one.
 *
 * Pure logic with a narrow store port, so the whole mechanism can be tested
 * against a fake. The Supabase-backed store lives in
 * `src/lib/queries/sponsorship.ts`.
 */

/** How long a sponsor has to complete checkout before the position is released. */
export const HOLD_MINUTES = 30;

/**
 * PostgreSQL's `exclusion_violation`. Raised by the `sponsorship_no_overlap`
 * constraint, and the only signal needed to know the position is not free.
 */
export const EXCLUSION_VIOLATION = "23P01";

export type HoldRequest = {
  slotNumber: number;
  termDays: number;
  sponsorName: string;
  sponsorDescription: string;
  sponsorLink: string;
  sponsorLogoUrl?: string | null;
};

export type NewHold = {
  slotId: string;
  termDays: number;
  priceCents: number;
  sponsorName: string;
  sponsorDescription: string;
  /** Already normalised by `safeExternalUrl`. */
  sponsorLink: string;
  sponsorLogoUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  holdExpiresAt: Date;
};

export type HoldFailure =
  | "invalid-link"
  | "unknown-position"
  | "no-price"
  /** The exclusion constraint refused it: someone else got there first. */
  | "position-taken"
  | "storage-error";

export type HoldOutcome =
  | {
      ok: true;
      sponsorshipId: string;
      slotNumber: number;
      termDays: number;
      priceCents: number;
      startsAt: string;
      endsAt: string;
      holdExpiresAt: string;
    }
  | { ok: false; reason: HoldFailure; message: string };

/**
 * The narrow slice of storage this module needs.
 *
 * Narrow enough that a fake is a dozen lines, which is the point: the
 * interesting behaviour here is the ordering and the failure mapping, not the
 * SQL.
 */
export type HoldStore = {
  /** The price for a term, from `sponsor_pricing`. Null when unconfigured. */
  priceForTerm(termDays: number): Promise<number | null>;
  /** The position's id, or null when no such position exists. */
  findPosition(slotNumber: number): Promise<string | null>;
  /** Cancels pending holds on this position whose window has already closed. */
  cancelStaleHolds(slotId: string, at: Date): Promise<void>;
  insertHold(row: NewHold): Promise<{ id: string } | { error: { code?: string; message: string } }>;
};

/** When a term bought now would start, end, and stop being held. */
export function holdWindow(termDays: number, now: Date) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return {
    startsAt: now,
    endsAt: new Date(now.getTime() + termDays * DAY_MS),
    holdExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60 * 1000),
  };
}

/**
 * Reserves a position for one sponsor, or explains why it could not.
 *
 * The order of the steps matters and is not arbitrary:
 *
 * 1. The link is re-guarded here even though validation already checked it. This
 *    function writes to the database, so it cannot assume a caller validated —
 *    and a `javascript:` URL that reached the row would be stored XSS on every
 *    page that renders the sponsor.
 * 2. The price is read from the table. It is never passed in, never computed,
 *    and never taken from the client.
 * 3. Stale holds on this position are cancelled *immediately before* the insert,
 *    in the same pass. The exclusion constraint cannot reference `now()` — it is
 *    not immutable, so it cannot appear in an index predicate — which means an
 *    abandoned hold would otherwise block a real buyer until the sweep ran.
 */
export async function placeHold(
  store: HoldStore,
  request: HoldRequest,
  now: Date = new Date(),
): Promise<HoldOutcome> {
  const link = safeExternalUrl(request.sponsorLink);
  if (!link) {
    return {
      ok: false,
      reason: "invalid-link",
      message: "That link needs to be a full web address, starting with https://",
    };
  }

  const priceCents = await store.priceForTerm(request.termDays);
  if (priceCents === null) {
    return {
      ok: false,
      reason: "no-price",
      message: "That term is not on sale at the moment.",
    };
  }

  const slotId = await store.findPosition(request.slotNumber);
  if (!slotId) {
    return {
      ok: false,
      reason: "unknown-position",
      message: "That position does not exist.",
    };
  }

  await store.cancelStaleHolds(slotId, now);

  const window = holdWindow(request.termDays, now);

  const inserted = await store.insertHold({
    slotId,
    termDays: request.termDays,
    priceCents,
    sponsorName: request.sponsorName,
    sponsorDescription: request.sponsorDescription,
    sponsorLink: link,
    sponsorLogoUrl: request.sponsorLogoUrl ?? null,
    ...window,
  });

  if ("error" in inserted) {
    if (inserted.error.code === EXCLUSION_VIOLATION) {
      // Not an error to log or investigate — the constraint has already decided
      // who was first, and it was not us.
      return {
        ok: false,
        reason: "position-taken",
        message: "Someone is buying that position right now. Try another one.",
      };
    }
    return {
      ok: false,
      reason: "storage-error",
      message: "We could not hold that position. Try again in a moment.",
    };
  }

  return {
    ok: true,
    sponsorshipId: inserted.id,
    slotNumber: request.slotNumber,
    termDays: request.termDays,
    priceCents,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    holdExpiresAt: window.holdExpiresAt.toISOString(),
  };
}
