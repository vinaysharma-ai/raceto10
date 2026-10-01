import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXCLUSION_VIOLATION,
  HOLD_MINUTES,
  holdWindow,
  placeHold,
  type HoldRequest,
  type HoldStore,
  type NewHold,
} from "./hold.ts";

/**
 * Placing a hold, against a fake store.
 *
 * The interesting behaviour is not the SQL — it is the order the steps run in,
 * which failure maps to which message, and the fact that the price never comes
 * from the request. All of that is testable without a database, which is why
 * the store is a port.
 */

const NOW = new Date("2026-09-25T10:00:00.000Z");

const REQUEST: HoldRequest = {
  slotNumber: 4,
  termDays: 3,
  sponsorName: "Ada's Bakery",
  sponsorDescription: "Sourdough, baked Thursdays",
  sponsorLink: "https://example.com",
};

/** A store that succeeds, recording the order of every call it receives. */
function recordingStore(overrides: Partial<HoldStore> = {}) {
  const calls: string[] = [];
  const inserted: NewHold[] = [];

  const store: HoldStore = {
    async priceForTerm(termDays) {
      calls.push(`price:${termDays}`);
      return 500;
    },
    async findPosition(slotNumber) {
      calls.push(`position:${slotNumber}`);
      return "slot-id-4";
    },
    async cancelStaleHolds(slotId, at) {
      calls.push(`cancel:${slotId}@${at.toISOString()}`);
    },
    async insertHold(row) {
      calls.push("insert");
      inserted.push(row);
      return { id: "sponsorship-1" };
    },
    ...overrides,
  };

  return { store, calls, inserted };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a free position is held, and the outcome says at what price", async () => {
  const { store, inserted } = recordingStore();
  const result = await placeHold(store, REQUEST, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.sponsorshipId, "sponsorship-1");
  assert.equal(result.ok && result.slotNumber, 4);
  assert.equal(result.ok && result.termDays, 3);
  assert.equal(result.ok && result.priceCents, 500);
  assert.equal(inserted.length, 1);
});

test("the price comes from the store, never from the request", async () => {
  // The plan is explicit: the price is read from `sponsor_pricing`, never sent
  // by the client and never computed. A caller that smuggles one in must not be
  // able to change what is stored.
  const { store, inserted } = recordingStore({
    async priceForTerm() {
      return 1200;
    },
  });

  await placeHold(
    store,
    { ...REQUEST, priceCents: 1 } as unknown as HoldRequest,
    NOW,
  );

  assert.equal(inserted[0]?.priceCents, 1200);
});

test("the stored window runs from now, for the term, with a 30-minute hold", async () => {
  const { store, inserted } = recordingStore();
  await placeHold(store, REQUEST, NOW);

  const row = inserted[0]!;
  assert.equal(row.startsAt.toISOString(), NOW.toISOString());
  assert.equal(
    row.endsAt.toISOString(),
    new Date("2026-09-28T10:00:00.000Z").toISOString(),
  );
  assert.equal(
    row.holdExpiresAt.toISOString(),
    new Date("2026-09-25T10:30:00.000Z").toISOString(),
  );
});

test("a 1-day term ends exactly one day later, and a 7-day term seven", () => {
  assert.equal(
    holdWindow(1, NOW).endsAt.toISOString(),
    new Date("2026-09-26T10:00:00.000Z").toISOString(),
  );
  assert.equal(
    holdWindow(7, NOW).endsAt.toISOString(),
    new Date("2026-10-02T10:00:00.000Z").toISOString(),
  );
  assert.equal(HOLD_MINUTES, 30);
});

test("the sponsor's link is stored normalised, not raw", async () => {
  const { store, inserted } = recordingStore();
  await placeHold(store, { ...REQUEST, sponsorLink: "https://example.com" }, NOW);

  // Same pass that rejects `javascript:` also normalises — hence the slash.
  assert.equal(inserted[0]?.sponsorLink, "https://example.com/");
});

// ---------------------------------------------------------------------------
// Stale holds
//
// The exclusion constraint cannot reference `now()` — it is not immutable, so
// it cannot appear in an index predicate — which means an abandoned 10:00 hold
// would still block a genuine 10:29 buyer. The cancellation therefore has to
// happen here, immediately before the insert, rather than waiting for the sweep.
// ---------------------------------------------------------------------------

test("stale holds on this position are cancelled before the insert", async () => {
  const { store, calls } = recordingStore();
  await placeHold(store, REQUEST, NOW);

  const cancelIndex = calls.indexOf("cancel:slot-id-4@2026-09-25T10:00:00.000Z");
  const insertIndex = calls.indexOf("insert");

  assert.ok(cancelIndex !== -1, "stale holds must be cancelled");
  assert.ok(
    cancelIndex < insertIndex,
    "the cancellation must happen before the insert, in the same pass",
  );
});

test("only the position being bought is cleared", async () => {
  const { store, calls } = recordingStore();
  await placeHold(store, REQUEST, NOW);

  const cancels = calls.filter((call) => call.startsWith("cancel:"));
  assert.deepEqual(cancels, ["cancel:slot-id-4@2026-09-25T10:00:00.000Z"]);
});

test("nothing is inserted when the position does not exist", async () => {
  const { store, calls } = recordingStore({
    async findPosition() {
      return null;
    },
  });

  const result = await placeHold(store, { ...REQUEST, slotNumber: 99 }, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "unknown-position");
  assert.ok(!calls.includes("insert"), "no row may be written for a missing position");
});

test("nothing is inserted when the term has no price", async () => {
  const { store, calls } = recordingStore({
    async priceForTerm() {
      return null;
    },
  });

  const result = await placeHold(store, { ...REQUEST, termDays: 7 }, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no-price");
  assert.ok(!calls.includes("insert"), "no row may be written without a real price");
  // The position is not even looked up — an unpriceable term is decided first.
  assert.ok(!calls.some((call) => call.startsWith("position:")));
});

// ---------------------------------------------------------------------------
// The link guard, re-applied where it is written
//
// Validation checks this too, for a useful error message. This function writes
// to the database, so it cannot assume a caller validated: a `javascript:` URL
// that reached the row would be stored XSS on every page rendering the sponsor.
// ---------------------------------------------------------------------------

test("a javascript: link is refused before anything is read or written", async () => {
  const { store, calls } = recordingStore();

  const result = await placeHold(
    store,
    { ...REQUEST, sponsorLink: "javascript:alert(document.cookie)" },
    NOW,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "invalid-link");
  assert.deepEqual(calls, [], "nothing may be read or written for an invalid link");
});

test("relative and scheme-tricked links are refused", async () => {
  for (const link of [
    "/sponsor",
    "//evil.example.com",
    "example.com",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    const { store, calls } = recordingStore();
    const result = await placeHold(store, { ...REQUEST, sponsorLink: link }, NOW);

    assert.equal(result.ok, false, `${link} should be refused`);
    assert.equal(result.ok === false && result.reason, "invalid-link");
    assert.deepEqual(calls, []);
  }
});

// ---------------------------------------------------------------------------
// Concurrency — what the exclusion constraint is for
// ---------------------------------------------------------------------------

test("an exclusion violation becomes 'position taken', not a storage error", async () => {
  // 23P01 is the constraint having already decided who was first. That is an
  // expected outcome of two sponsors clicking at once, not a fault to log.
  const { store } = recordingStore({
    async insertHold() {
      return { error: { code: EXCLUSION_VIOLATION, message: "conflicting key value" } };
    },
  });

  const result = await placeHold(store, REQUEST, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "position-taken");
});

test("the message for a taken position does not leak a constraint name", async () => {
  const { store } = recordingStore({
    async insertHold() {
      return {
        error: {
          code: EXCLUSION_VIOLATION,
          message: 'conflicting key value violates exclusion constraint "sponsorship_no_overlap"',
        },
      };
    },
  });

  const result = await placeHold(store, REQUEST, NOW);

  assert.ok(result.ok === false);
  assert.ok(
    !result.ok && !/sponsorship_no_overlap|constraint|23P01/.test(result.message),
    "the sponsor must never see a database error",
  );
});

test("any other insert failure is reported as a storage error", async () => {
  const { store } = recordingStore({
    async insertHold() {
      return { error: { code: "23514", message: "check constraint violated" } };
    },
  });

  const result = await placeHold(store, REQUEST, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "storage-error");
  assert.ok(!result.ok && !/23514|constraint/.test(result.message));
});

test("two sponsors racing the same position — exactly one hold survives", async () => {
  // A fake that models the constraint rather than the SQL: whichever insert
  // lands first wins, and the second is refused. This is the mechanism the
  // whole design rests on, so it is worth asserting even in miniature.
  let held = false;

  const racingStore = (): HoldStore => ({
    async priceForTerm() {
      return 500;
    },
    async findPosition() {
      return "slot-id-4";
    },
    async cancelStaleHolds() {},
    async insertHold() {
      if (held) {
        return { error: { code: EXCLUSION_VIOLATION, message: "conflicting key value" } };
      }
      held = true;
      return { id: "sponsorship-winner" };
    },
  });

  const [first, second] = await Promise.all([
    placeHold(racingStore(), REQUEST, NOW),
    placeHold(racingStore(), REQUEST, NOW),
  ]);

  const winners = [first, second].filter((result) => result.ok);
  assert.equal(winners.length, 1, "exactly one sponsor may hold a position");
  assert.equal(
    [first, second].filter((result) => !result.ok && result.reason === "position-taken")
      .length,
    1,
  );
});
