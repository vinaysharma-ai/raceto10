import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RACE_TARGET,
  activityLines,
  countryName,
  describeActivity,
  globeDots,
  placeLabel,
  progressLabel,
  progressOf,
  racersOnTheBoard,
  racersWaiting,
  rankRacers,
  recentActivity,
  searchRacers,
  timeAgo,
  timeRemaining,
  xProfileUrl,
  type ActivityRow,
  type PublicRacer,
} from "./board.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function racer(overrides: Partial<PublicRacer> = {}): PublicRacer {
  return {
    public_slug: "ada",
    founder_name: "Ada Lovelace",
    x_handle: "ada",
    product_name: "Ledgerly",
    product_url: "https://ledgerly.example.com",
    status: "racing",
    current_customer_count: 0,
    activated_at: "2026-09-28T10:00:00.000Z",
    race_end_at: "2026-10-05T10:00:00.000Z",
    reached_ten_at: null,
    created_at: "2026-09-28T09:00:00.000Z",
    city: "Lisbon",
    country: "PT",
    latitude: 38.7167,
    longitude: -9.1333,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

test("a country code becomes a country name", () => {
  assert.equal(countryName("PT"), "Portugal");
  assert.equal(countryName("US"), "United States");
  assert.equal(countryName("de"), "Germany");
});

test("an unknown or malformed code degrades to itself, never to a guess", () => {
  assert.equal(countryName(null), null);
  // Not "Unknown Region" — the sentinel ICU returns for a well-formed code it
  // does not know. Printing that as a founder's location would be a bug.
  assert.equal(countryName("ZZ"), "ZZ");
  assert.equal(countryName("Portugal"), "Portugal");
});

test("a place label degrades in the right order", () => {
  assert.equal(placeLabel({ city: "Lisbon", country: "PT" }), "Lisbon, Portugal");
  assert.equal(placeLabel({ city: "Lisbon", country: null }), "Lisbon");
  assert.equal(placeLabel({ city: null, country: "PT" }), "Portugal");
  assert.equal(placeLabel({ city: null, country: null }), null);
});

// ---------------------------------------------------------------------------
// The globe
// ---------------------------------------------------------------------------

test("a racer with coordinates gets a dot at their location", () => {
  const dots = globeDots([racer()]);

  assert.equal(dots.length, 1);
  // GeoJSON order: longitude first. Reversing these is the classic bug, and it
  // would put every European founder in the Indian Ocean.
  assert.deepEqual(dots[0].coordinates, [-9.1333, 38.7167]);
  assert.equal(dots[0].slug, "ada");
  // Who, what and how far. The location is the dot's position, not a label —
  // repeating it in the popup was the only other thing it could have said.
  assert.equal(dots[0].who, "@ada");
  assert.equal(dots[0].product, "Ledgerly");
  assert.equal(dots[0].count, 0);
});

test("a dot with no verified handle is named by display name, not by a slug", () => {
  // A Google-only founder has no handle, and inventing one from the slug would
  // publish a name nobody proved they own.
  const dots = globeDots([racer({ x_handle: null })]);

  assert.equal(dots[0].who, "Ada Lovelace");
});

test("a racer with no coordinates gets no dot, and none is invented", () => {
  const dots = globeDots([
    racer({ public_slug: "a", latitude: null, longitude: null }),
    racer({ public_slug: "b", latitude: 51.5, longitude: null }),
  ]);

  assert.deepEqual(dots, []);
});

test("a racer who has not started is not plotted", () => {
  for (const status of ["registered", "ready", "withdrawn"] as const) {
    assert.deepEqual(globeDots([racer({ status })]), [], `${status} should not plot`);
  }
});

test("a finished racer stays on the map", () => {
  // The race is over; the result is not. `01` §6 keeps finished racers public.
  assert.equal(globeDots([racer({ status: "finished" })]).length, 1);
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

test("only racers in a race are on the board", () => {
  const board = racersOnTheBoard([
    racer({ public_slug: "a", status: "registered" }),
    racer({ public_slug: "b", status: "ready" }),
    racer({ public_slug: "c", status: "racing" }),
    racer({ public_slug: "d", status: "finished" }),
  ]);

  assert.deepEqual(board.map((r) => r.public_slug), ["c", "d"]);
});

test("waiting racers are separated, not mixed into the board", () => {
  // `01` §6. A founder with no clock has no progress to rank, and listing them
  // beside people who are racing would rank them at zero.
  const waiting = racersWaiting([
    racer({ public_slug: "a", status: "ready" }),
    racer({ public_slug: "b", status: "racing" }),
  ]);

  assert.deepEqual(waiting.map((r) => r.public_slug), ["a"]);
});

test("the board is ordered by customers, then by who started first", () => {
  const ranked = rankRacers([
    racer({ public_slug: "late", current_customer_count: 4, activated_at: "2026-09-28T11:00:00.000Z" }),
    racer({ public_slug: "early", current_customer_count: 4, activated_at: "2026-09-28T09:00:00.000Z" }),
    racer({ public_slug: "leader", current_customer_count: 9 }),
  ]);

  assert.deepEqual(ranked.map((r) => r.public_slug), ["leader", "early", "late"]);
});

test("the ordering is stable for otherwise identical racers", () => {
  const same = {
    current_customer_count: 2,
    activated_at: "2026-09-28T10:00:00.000Z",
  };

  const ranked = rankRacers([
    racer({ ...same, public_slug: "b" }),
    racer({ ...same, public_slug: "a" }),
  ]);

  assert.deepEqual(rankRacers(ranked).map((r) => r.public_slug), ["a", "b"]);
});

test("progress clamps at the target and never goes negative", () => {
  assert.equal(progressOf({ current_customer_count: 0 }), 0);
  assert.equal(progressOf({ current_customer_count: 4 }), 4);
  assert.equal(progressOf({ current_customer_count: RACE_TARGET }), RACE_TARGET);
  // A count above the target is a finished race, not 11 of 10.
  assert.equal(progressOf({ current_customer_count: 12 }), RACE_TARGET);
  // `02` §10 requires a downward correction never to surface as negative
  // progress. Even if a verified count fell below the baseline, a spectator
  // sees 0.
  assert.equal(progressOf({ current_customer_count: -3 }), 0);
  assert.equal(progressOf({ current_customer_count: Number.NaN }), 0);
});

test("progress reads the same wherever it is phrased", () => {
  assert.equal(progressLabel(racer({ current_customer_count: 4 })), "4 of 10 customers");
  assert.equal(progressLabel(racer({ current_customer_count: 12 })), "10 of 10 customers");
});

test("time remaining counts down in days and hours", () => {
  assert.deepEqual(timeRemaining(racer(), NOW), { days: 6, hours: 22, ended: false });
});

test("a race with no clock has no remaining time, not zero", () => {
  assert.equal(timeRemaining({ race_end_at: null }, NOW), null);
  assert.equal(timeRemaining({ race_end_at: "not a date" }, NOW), null);
});

test("a finished clock says so rather than going negative", () => {
  assert.deepEqual(timeRemaining({ race_end_at: "2026-09-27T10:00:00.000Z" }, NOW), {
    days: 0,
    hours: 0,
    ended: true,
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("an empty query returns everything untouched", () => {
  const racers = [racer({ public_slug: "a" }), racer({ public_slug: "b", x_handle: "grace" })];
  assert.equal(searchRacers(racers, "").length, 2);
  assert.equal(searchRacers(racers, "   ").length, 2);
});

test("search matches founder name, X handle and product", () => {
  const racers = [
    racer({ public_slug: "a", founder_name: "Ada Lovelace", x_handle: "ada", product_name: "Ledgerly" }),
    racer({ public_slug: "b", founder_name: "Grace Hopper", x_handle: "ghopper", product_name: "Northwind" }),
  ];

  assert.deepEqual(searchRacers(racers, "ada").map((r) => r.public_slug), ["a"]);
  assert.deepEqual(searchRacers(racers, "northwind").map((r) => r.public_slug), ["b"]);
  assert.deepEqual(searchRacers(racers, "ghopper").map((r) => r.public_slug), ["b"]);
  assert.deepEqual(searchRacers(racers, "ADA").map((r) => r.public_slug), ["a"]);
  assert.deepEqual(searchRacers(racers, "lvc").map((r) => r.public_slug), []);
});

test("a racer with null fields does not crash the search", () => {
  const racers = [racer({ product_name: null, x_handle: null })];
  assert.equal(searchRacers(racers, "ledgerly").length, 0);
  assert.equal(searchRacers(racers, "ada").length, 1);
});

test("a handle becomes a profile URL, safely", () => {
  assert.equal(xProfileUrl("ada"), "https://x.com/ada");
  // Handles are validated to [A-Za-z0-9_], so this should be unreachable — but
  // this is the last step before an href, and encoding means a bad row cannot
  // produce a link that points somewhere else.
  assert.equal(xProfileUrl("a/b"), "https://x.com/a%2Fb");
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activity(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    event_type: "customer_milestone",
    milestone_customer_count: 4,
    occurred_at: "2026-09-28T11:00:00.000Z",
    public_slug: "ada",
    founder_name: "Ada Lovelace",
    x_handle: "ada",
    product_name: "Ledgerly",
    city: "Lisbon",
    country: "PT",
    activated_at: "2026-09-28T08:00:00.000Z",
    ...overrides,
  };
}

test("a milestone names the customer number", () => {
  const line = describeActivity(activity());
  assert.equal(line.who, "@ada");
  assert.equal(line.what, "reached 4 of 10");
  assert.equal(line.where, "Lisbon, Portugal");
});

test("every event type reads differently", () => {
  assert.equal(describeActivity(activity({ event_type: "joined" })).what, "joined");
  assert.equal(describeActivity(activity({ event_type: "activated" })).what, "started a race");
  assert.equal(
    describeActivity(activity({ event_type: "expired", milestone_customer_count: 6 })).what,
    "ran out of time at 6 of 10",
  );
  assert.equal(
    describeActivity(activity({ event_type: "connection_lost" })).what,
    "connection was lost",
  );
});

test("a finished race says how long it took", () => {
  // Every finished racer has ten customers, so the time is the only thing that
  // distinguishes one from another.
  const line = describeActivity(activity({ event_type: "finished" }));

  assert.match(line.what, /^finished in 3h/, line.what);
});

test("a finished event with no start time still reads, without inventing one", () => {
  // `activated_at` is null for a row written before the column existed. Saying
  // just "finished" is honest; a made-up duration would not be.
  const line = describeActivity(activity({ event_type: "finished", activated_at: null }));

  assert.equal(line.what, "finished");
});

test("joined is never part of the feed, however recent it is", () => {
  // Registering is not an event in a race — nothing has happened yet. Filtered
  // before the limit, so a busy signup day cannot push real events out of the
  // eight slots.
  const rows = Array.from({ length: 10 }, (_, i) =>
    activity({
      event_type: "joined",
      public_slug: `p${i}`,
      occurred_at: `2026-09-28T11:0${i}:00.000Z`,
    }),
  );

  assert.deepEqual(recentActivity(rows, 8), []);
});

test("a milestone with no number does not print `#null`", () => {
  const line = describeActivity(activity({ milestone_customer_count: null }));
  assert.ok(!line.what.includes("null"));
});

test("a racer with no X handle is named by their founder name", () => {
  // Not by their slug — the slug is an address, not a name.
  assert.equal(describeActivity(activity({ x_handle: null })).who, "Ada Lovelace");
});

test("the feed identifies rows without an id from the database", () => {
  // The public view exposes no primary key on purpose, so the key is built
  // from the fields. Two different events must not collide.
  const lines = activityLines(
    [
      activity({ event_type: "activated", occurred_at: "2026-09-28T10:00:00.000Z" }),
      activity({ event_type: "customer_milestone", occurred_at: "2026-09-28T10:00:00.000Z" }),
    ],
    NOW,
    8,
  );

  assert.equal(new Set(lines.map((l) => l.key)).size, 2);
});

test("the feed is newest first and capped", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    activity({
      occurred_at: new Date(Date.parse("2026-09-28T00:00:00.000Z") + i * 60_000).toISOString(),
    }),
  );

  const lines = activityLines(rows, NOW, 3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].when, "11h ago");
});

test("an empty feed stays empty — no placeholder rows", () => {
  assert.deepEqual(activityLines([], NOW, 8), []);
  assert.deepEqual(recentActivity([], 8), []);
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test("relative times are coarse and honest", () => {
  assert.equal(timeAgo("2026-09-28T11:59:30.000Z", NOW), "just now");
  assert.equal(timeAgo("2026-09-28T11:48:00.000Z", NOW), "12m ago");
  assert.equal(timeAgo("2026-09-28T09:00:00.000Z", NOW), "3h ago");
  assert.equal(timeAgo("2026-09-26T12:00:00.000Z", NOW), "2d ago");
});

test("an unusable timestamp renders nothing rather than `Invalid Date`", () => {
  assert.equal(timeAgo("not a date", NOW), "");
});
