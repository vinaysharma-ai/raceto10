import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSearchPattern,
  readRaceBoard,
  readSearch,
  type RaceBoardReader,
} from "./race-board.ts";

/**
 * Reading the race.
 *
 * The distinction under test throughout is "the race is empty" versus "the race
 * could not be read". Collapsing the two would put a confident "nobody is
 * racing" on the board whenever the database was unreachable.
 */

type Rows = Record<string, unknown>[] | null;

function reader(response: {
  racers?: Rows;
  activity?: Rows;
  search?: Rows;
  error?: { message: string } | null;
  throw?: string;
}): RaceBoardReader {
  const respond = (data: Rows) => {
    if (response.throw) return Promise.reject(new Error(response.throw));
    return Promise.resolve({ data, error: response.error ?? null });
  };
  return {
    listRacers: () => respond(response.racers ?? null),
    listActivity: () => respond(response.activity ?? null),
    search: () => respond(response.search ?? null),
  };
}

const RACER = {
  public_slug: "ada",
  founder_name: "Ada Lovelace",
  x_handle: "ada",
  product_name: "Ledgerly",
  status: "racing",
  current_customer_count: 3,
  activated_at: "2026-09-28T10:00:00.000Z",
  race_end_at: "2026-10-05T10:00:00.000Z",
  reached_ten_at: null,
  created_at: "2026-09-28T09:00:00.000Z",
  city: "Lisbon",
  country: "PT",
  latitude: 38.7167,
  longitude: -9.1333,
};

const EVENT = {
  event_type: "activated",
  milestone_customer_count: null,
  occurred_at: "2026-09-28T10:00:00.000Z",
  public_slug: "ada",
  founder_name: "Ada Lovelace",
  x_handle: "ada",
  product_name: "Ledgerly",
  city: "Lisbon",
  country: "PT",
};

test("a good read returns the racers and the feed", async () => {
  const result = await readRaceBoard(reader({ racers: [RACER], activity: [EVENT] }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.board.racers[0].public_slug, "ada");
  assert.equal(result.ok && result.board.activity.length, 1);
});

test("an empty race is a success with nothing in it", async () => {
  // The honest empty state. Not an error, and not a reason to hide the globe —
  // the map renders its coastlines and no dots.
  const result = await readRaceBoard(reader({ racers: [], activity: [] }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.board.racers, []);
});

test("a query error is a failure, not an empty race", async () => {
  const result = await readRaceBoard(
    reader({ error: { message: 'relation "public_racers" does not exist' } }),
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("public_racers"));
});

test("a thrown client error is caught rather than rejecting", async () => {
  const result = await readRaceBoard(reader({ throw: "fetch failed" }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "fetch failed");
});

test("a null result is a failure, not an empty race", async () => {
  assert.equal((await readRaceBoard(reader({}))).ok, false);
});

test("the feed limit is passed through to the read", async () => {
  let asked = -1;
  const spy: RaceBoardReader = {
    listRacers: () => Promise.resolve({ data: [], error: null }),
    listActivity: (limit) => {
      asked = limit;
      return Promise.resolve({ data: [], error: null });
    },
    search: () => Promise.resolve({ data: [], error: null }),
  };

  await readRaceBoard(spy, 3);
  assert.equal(asked, 3);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("an empty query does not reach the database", async () => {
  // A search box someone clicked into and left alone must not become a query
  // that returns the whole board.
  let called = false;
  const spy: RaceBoardReader = {
    listRacers: () => Promise.resolve({ data: [], error: null }),
    listActivity: () => Promise.resolve({ data: [], error: null }),
    search: () => {
      called = true;
      return Promise.resolve({ data: [], error: null });
    },
  };

  const result = await readSearch(spy, "   ");
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.results, []);
  assert.equal(called, false);
});

test("a search returns only the public fields the view carries", async () => {
  const result = await readSearch(
    reader({
      search: [
        { public_slug: "ada", founder_name: "Ada", x_handle: "ada", product_name: "Ledgerly" },
      ],
    }),
    "ada",
  );

  assert.equal(result.ok, true);
  const row = result.ok ? result.results[0] : null;
  // The search projection is narrower than the board on purpose: no location,
  // no count. If a column ever appears here, this fails.
  assert.deepEqual(Object.keys(row ?? {}).sort(), [
    "founder_name",
    "product_name",
    "public_slug",
    "x_handle",
  ]);
});

test("LIKE wildcards typed by a person are treated as characters", () => {
  // `%` and `_` mean something to a LIKE pattern. Passing them through
  // unescaped would turn a search for "100%" into a match against everything.
  assert.equal(buildSearchPattern("100%"), "100\\%");
  assert.equal(buildSearchPattern("a_b"), "a\\_b");
  assert.equal(buildSearchPattern("back\\slash"), "back\\\\slash");
  assert.equal(buildSearchPattern("plain"), "plain");
});

test("PostgREST filter syntax cannot be injected through the search box", () => {
  // The `.or()` filter is a string with its own grammar: `,` separates
  // conditions and `.` separates column from operator from value. A search for
  // `ada,product_name.not.is.null` would otherwise append a *condition* rather
  // than search for that text.
  const injected = buildSearchPattern("ada,product_name.not.is.null");

  assert.ok(!injected.includes(","), "a condition separator survived");
  assert.ok(!injected.includes("."), "a column/operator separator survived");

  // The text is still recognisable, so the search is not silently useless.
  assert.ok(injected.includes("ada"));
});

test("grouping, quoting and operator characters are stripped too", () => {
  const cleaned = buildSearchPattern('a(b)c:d*e"f\'g');
  for (const char of ["(", ")", ":", "*", '"', "'"]) {
    assert.ok(!cleaned.includes(char), `${char} survived`);
  }
});

test("the pattern is bounded before it is escaped", () => {
  // Bounding first means an escape sequence can never be cut in half, and it
  // caps the work an arbitrary query can ask for.
  const pattern = buildSearchPattern("a".repeat(500));

  assert.ok(pattern.length <= 64, `length was ${pattern.length}`);
});

test("a query that is entirely filter syntax degrades to an empty pattern", () => {
  // Not an error and not everything — the escaped pattern is empty, so the
  // LIKE matches nothing rather than matching all.
  assert.equal(buildSearchPattern(",...()"), "");
});

test("a search failure is reported, not silently empty", async () => {
  const result = await readSearch(reader({ error: { message: "boom" } }), "ada");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "boom");
});
