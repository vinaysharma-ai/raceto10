// Removes everything a fixture racer created.
//
//   npm run fixture:cleanup
//
// ## Why this has to exist
//
// Local development and production share one hosted database. A fixture race is
// a real set of rows — a racer, a connection, customers, events — and without
// this it would sit on the live public board next to real founders, with a
// number nobody paid for. That is the worst outcome this product can produce,
// so removing one has to be as easy as creating one.
//
// ## No child process
//
// This used to shell out to `npx supabase db query`, which fails on Windows with
// `spawnSync npx.cmd EINVAL` — Node refuses to spawn a `.cmd` without a shell,
// and enabling the shell would mean interpolating SQL into a command line. It
// talks to the REST API directly instead, with the service key from
// `.env.local`. One fewer moving part, and nothing to quote.
//
// ## What identifies a fixture racer
//
// `provider_connections.external_account_ref` is the account a key belongs to.
// A real one is Stripe's own `acct_…`; a fixture one is `acct_fixture…`
// (`FIXTURE_ACCOUNT_ID` in src/lib/verification/stripe/fixture-mode.ts). No
// flag, no schema, nothing to forget to set.
//
// ## Guards run before anything is deleted
//
//   1. Every matched racer must have *only* fixture connections. A racer with
//      one real connection and one fixture connection is not a fixture racer,
//      and deleting them would destroy a real founder's race.
//   2. More than five matched racers aborts. The fixture path is for one person
//      testing alone; a larger number means the pattern matched something it was
//      not meant to.
//
// Both are checked first, so a refusal deletes nothing. That is a weaker
// guarantee than a transaction — PostgREST cannot span statements — and it is
// the strongest one available here. Said plainly rather than implied, because
// the difference matters if a delete ever fails midway.
//
// ## Ordered, so nothing is orphaned
//
// Children before parents: credentials and runs hang off the connection;
// customers, baselines and events hang off the racer; rate-limit rows use the
// racer id as their subject.
//
// ## It never touches `profiles`
//
// The profile is the signed-in person's account, created by OAuth and shared
// with every future race they enter. Deleting it would delete their login, which
// is not what cleaning up a test race means.
//
// ## Counts only
//
// Table names and row counts. No ids, no emails, nothing about anybody. A
// cleanup script that printed rows would be a second way to read the database.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/** Must match `FIXTURE_ACCOUNT_PREFIX` in src/lib/verification/stripe/fixture-mode.ts. */
const FIXTURE_PREFIX = "acct_fixture";

/** The most racers this will ever remove in one run. See the note above. */
const MAX_RACERS = 5;

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

// Service role: `provider_credentials`, `racer` and `rate_limit_counter` grant
// nothing to any other role.
const db = createClient(url, key, { auth: { persistSession: false } });

/** Deletes matching rows and returns how many went, without printing any of them. */
async function remove(table, column, values) {
  if (values.length === 0) return 0;

  const { data, error } = await db.from(table).delete().in(column, values).select("id");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data?.length ?? 0;
}

async function main() {
  // --- Identify ------------------------------------------------------------
  const { data: connections, error: connError } = await db
    .from("provider_connections")
    .select("id, racer_id, external_account_ref");

  if (connError) throw new Error(`provider_connections: ${connError.message}`);

  const all = connections ?? [];
  const fixtureConnections = all.filter(
    (c) => typeof c.external_account_ref === "string" &&
      c.external_account_ref.startsWith(FIXTURE_PREFIX),
  );

  const racerIds = [...new Set(fixtureConnections.map((c) => c.racer_id))];

  if (racerIds.length === 0) {
    console.log("no fixture racers found");
    console.log("  deleted 0 rows");
    return;
  }

  // --- Guards, before a single delete --------------------------------------
  if (racerIds.length > MAX_RACERS) {
    console.error(
      `refusing: ${racerIds.length} racers match the fixture pattern, limit is ${MAX_RACERS}.`,
    );
    console.error("Nothing was deleted.");
    process.exitCode = 1;
    return;
  }

  const mixed = racerIds.filter((id) =>
    all.some(
      (c) => c.racer_id === id &&
        !(typeof c.external_account_ref === "string" &&
          c.external_account_ref.startsWith(FIXTURE_PREFIX)),
    ),
  );

  if (mixed.length > 0) {
    console.error(
      `refusing: ${mixed.length} matched racer(s) also have a non-fixture connection.`,
    );
    console.error("Nothing was deleted.");
    process.exitCode = 1;
    return;
  }

  console.log(`removing ${racerIds.length} fixture racer(s)`);

  const connectionIds = fixtureConnections.map((c) => c.id);
  const rows = [];

  // --- Children before parents ---------------------------------------------
  for (const [table, column, values] of [
    ["provider_credentials", "provider_connection_id", connectionIds],
    ["reconciliation_runs", "provider_connection_id", connectionIds],
    ["verification_snapshots", "racer_id", racerIds],
    ["race_customer", "racer_id", racerIds],
    ["race_baseline_customer", "racer_id", racerIds],
    ["race_event", "racer_id", racerIds],
    // Key-verification limits use the racer id as their subject.
    ["rate_limit_counter", "subject", racerIds],
    ["provider_connections", "racer_id", racerIds],
    ["racer", "id", racerIds],
  ]) {
    const count = await remove(table, column, values);
    rows.push([table, count]);
  }

  let total = 0;
  for (const [table, count] of rows) {
    console.log(`  ${table.padEnd(22)} ${count}`);
    total += count;
  }
  console.log(`  deleted ${total} rows`);

  // profiles is deliberately absent. See the header.
}

try {
  await main();
} catch (error) {
  // The message is a table name and a PostgREST error, never a row.
  console.error(String(error.message ?? error));
  process.exitCode = 1;
}
