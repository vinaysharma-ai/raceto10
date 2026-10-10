// Counts the funnel, and nothing else.
//
//   npm run funnel
//
// ## What it is
//
// A read-only look at how far people get: how many accounts exist, how many
// races are in each state, which connections are healthy, how many racers
// arrived on each of the last fourteen days, and what the reconciliation runs
// of the last day did. The service key is read from `.env.local`, the same file
// the dev server uses.
//
// ## Counts only
//
// Every query below asks for one non-identifying column — a status, or a
// timestamp — and the only thing ever printed is a number against a label. No
// email, no handle, no key, no id reaches stdout, including on failure: the
// error path prints the table name and the error message, which is PostgREST's
// and never a row.
//
// This is the same rule `fixture-cleanup.mjs` follows, and for the same reason.
// A script that printed rows would be a second, quieter way to read the
// database, and this one runs often enough that nobody would look twice.
//
// ## Why it pages instead of counting
//
// `&select=status` on its own is subject to PostgREST's `max-rows` ceiling, and
// a ceiling is the one failure this kind of script must not have: it would
// report a smaller total than the truth with no error to say so. So every tally
// walks the table a page at a time, ordered by `id` so the pages are cut in a
// stable order, until a short page says the end has been reached.
//
// The alternative — a `head: true` exact count per known status value — has no
// ceiling, but it can only count values this file already knows about. A status
// that exists in the table and not in the list would be silently dropped from
// the total, which is the same class of quiet wrongness in the other direction.
// Walking the rows shows the unknown value under its own name.
//
// ## Why the two windows are UTC
//
// "Per day" only means something once somebody picks a timezone, and the
// database stores instants. The days below are UTC calendar days and the output
// says so, so a count that looks a day off is explainable rather than mysterious.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DAY_MS = 86_400_000;

/** How many days of arrivals to show, today included. */
const DAYS = 14;

/**
 * The statuses each column is expected to hold, in the order they are reached.
 *
 * These are printed even at zero, because a zero is the interesting number in a
 * funnel — it is the step nobody is getting past. Anything found in the table
 * that is not on the list is printed after these, under its own name, so a new
 * status shows up here rather than going missing.
 *
 * `racer.status` is `racer_status` after the v2 rename (see
 * `20260928120100_identity_and_provider_schema.sql`), plus the two terminal
 * values added in `20261005120000_racer_status_terminal_values.sql`.
 * `reconciliation_runs.status` is a plain string, not an enum, so its list is
 * only ever a display order.
 */
const RACER_STATUSES = [
  "registered",
  "ready",
  "racing",
  "finished",
  "expired",
  "ineligible",
  "verification_failed",
  "withdrawn",
  "disqualified",
];

const CONNECTION_STATUSES = ["pending", "connected", "revoked", "unavailable"];

const RUN_STATUSES = ["running", "ok", "failed"];

function env() {
  const out = {};
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = env();

if (!url || !key) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be in .env.local.",
  );
  process.exit(2);
}

// Service role, because `racer`, `profiles` and `provider_connections` grant
// nothing to any other role. Read-only: nothing below writes, and nothing below
// is called with a method that could.
const db = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 1000;

/**
 * Walks a table and counts how many rows fall under each value of `column`.
 *
 * `build` is a function rather than a query because a PostgREST builder is
 * single-use — re-ranging one that has already been awaited does not re-run it.
 * A fresh builder per page is what makes the loop below honest.
 */
async function tally(build, column) {
  const counts = new Map();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build()
      // Ordered by the primary key purely so the pages are cut in a stable
      // order. Without an order, two pages can overlap and the total comes out
      // high with nothing to indicate it.
      .order("id")
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);

    const rows = data ?? [];
    for (const row of rows) {
      const value = row[column];
      const label = value === null || value === undefined ? "(null)" : String(value);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    if (rows.length < PAGE) return counts;
  }
}

/**
 * One exact count.
 *
 * `head: true` means the count comes from the response headers and no row is
 * ever sent, so this is the one place the `max-rows` ceiling above does not
 * apply — PostgREST counts the whole matched set regardless of the page size it
 * would have used. That is why the two profile numbers are counted rather than
 * walked.
 *
 * `refine` is applied to the filter builder that `.select()` returns, which is
 * the only place these filters exist in this version of the client — `from()`
 * hands back a query builder with no `not`, `gte` or `eq` on it at all.
 */
async function count(table, refine) {
  const query = db.from(table).select("*", { count: "exact", head: true });
  const { count: n, error } = await (refine ? refine(query) : query);
  if (error) throw new Error(error.message);
  return n ?? 0;
}

function barred(label, n) {
  console.log(`  ${label.padEnd(34)}${String(n).padStart(6)}`);
}

/**
 * Prints a known list first, zeros included, then anything else the table held.
 *
 * The unknown block is the point: it is where a status this file has not heard
 * of becomes visible instead of being folded into a total that no longer means
 * what its label says.
 */
function block(title, counts, known) {
  console.log(`\n${title}`);

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const knownSet = new Set(known);

  for (const value of known) barred(value, counts.get(value) ?? 0);
  for (const [value, n] of counts) {
    if (!knownSet.has(value)) barred(`${value} (unlisted)`, n);
  }

  barred("total", total);
}

function utcDay(value) {
  // Re-serialised rather than sliced off the front of the stored string, so the
  // bucket is a UTC day whatever offset PostgREST chose to render the instant in.
  return new Date(value).toISOString().slice(0, 10);
}

async function main() {
  const now = new Date();
  console.log(`raceto10 funnel — as of ${now.toISOString()} (read-only, counts only)`);

  // --- Profiles ------------------------------------------------------------
  //
  // Three numbers rather than one, because `profiles.deleted_at` is a real soft
  // delete: the public projections all filter on it, so a "total" that counted
  // deleted rows would be a number nobody means by that word, and one that
  // excluded them silently would hide that anybody had left.
  const profilesTotal = await count("profiles");
  const profilesDeleted = await count("profiles", (q) =>
    q.not("deleted_at", "is", null),
  );

  console.log("\nprofiles");
  barred("live (not deleted)", profilesTotal - profilesDeleted);
  barred("soft-deleted", profilesDeleted);
  barred("total", profilesTotal);

  // --- Racers by status ----------------------------------------------------
  const racers = await tally(() => db.from("racer").select("status"), "status");
  block("racers by status", racers, RACER_STATUSES);

  // --- Connections by status ----------------------------------------------
  //
  // Counted over connections rather than racers, so this is the state of the
  // plumbing — a racer who never connected a key has no row here at all.
  const connections = await tally(
    () => db.from("provider_connections").select("connection_status"),
    "connection_status",
  );
  block("connections by connection_status", connections, CONNECTION_STATUSES);

  // --- Arrivals, per day ---------------------------------------------------
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windowStart = new Date(todayStart.getTime() - (DAYS - 1) * DAY_MS);

  const arrivals = await tally(
    () =>
      db
        .from("racer")
        .select("created_at")
        .gte("created_at", windowStart.toISOString()),
    "created_at",
  );

  // Re-bucketed from instants to days here, because `tally` counts distinct
  // values and every instant is distinct — tallying the column directly would
  // print one line per racer.
  const perDay = new Map();
  for (const [instant, n] of arrivals) {
    const day = utcDay(instant);
    perDay.set(day, (perDay.get(day) ?? 0) + n);
  }

  const days = [];
  for (let i = 0; i < DAYS; i += 1) {
    days.push(new Date(windowStart.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }

  console.log(`\nracers created per day (last ${DAYS} days, UTC, today inclusive)`);
  for (const day of days) barred(day, perDay.get(day) ?? 0);
  barred("total in window", [...perDay.values()].reduce((a, b) => a + b, 0));

  // --- Reconciliation runs, last 24 hours ----------------------------------
  //
  // By `started_at`, which every run has, rather than `completed_at`, which a
  // run still going does not. A run that began inside the window and has not
  // finished is therefore counted, under `running` — which is where it belongs,
  // since the question this answers is what the fleet has been doing.
  const since = new Date(now.getTime() - DAY_MS).toISOString();

  const runs = await tally(
    () =>
      db.from("reconciliation_runs").select("status").gte("started_at", since),
    "status",
  );
  block("reconciliation runs, last 24h, by status", runs, RUN_STATUSES);
}

main().catch((error) => {
  console.error(`\nfunnel: ${error.message}`);
  process.exit(1);
});
