// Reads everything an anonymous visitor can read, and looks for a leak.
//
//   npm run check:public
//
// ## What it is
//
// A read-only sweep with the publishable key — the same key a browser ships,
// the same key an attacker has. It asks PostgREST for every public view and
// every table that a public policy covers, and fails if any returned *column
// name* looks like something that should never have crossed that boundary.
//
// ## Why column names, and not values
//
// Because the column list is the security boundary. `public_racers` is an
// owner's-rights view whose `select` list is what an anonymous reader gets; a
// column that is not in that list cannot be returned however the query is
// phrased. So a name is the right unit: it is stable, it is checkable without
// reading anybody's data, and it does not require this script to hold anything
// sensitive to do its job.
//
// It writes nothing and reads no row's contents — only the shape of the
// response.
//
// ## The two allowlisted names
//
// `current_customer_count` and `milestone_customer_count` match /customer/i and
// are the product. The board's entire purpose is to publish a count of paying
// customers; that is not a leak, it is the thing being built. They are listed
// explicitly rather than by loosening the pattern, so the exception is visible
// and nobody can widen it by accident.
//
// ## The three that must be sealed
//
// `provider_credentials`, `provider_connections` and `rate_limit_counter` are
// asked for directly. Each must answer either with no rows or with a permission
// error. Either is a pass; a row is a failure.

import { readFileSync } from "node:fs";

const FORBIDDEN = /email|key|secret|token|account|customer|password/i;

/**
 * Column names that match the pattern and are the product rather than a leak.
 *
 * Kept as an exact list. A prefix match here would let `customer_email` through
 * on the strength of `customer_count`.
 */
const ALLOWED = new Set(["current_customer_count", "milestone_customer_count"]);

/** Views every anonymous reader is meant to have, and tables with public policies. */
const PUBLIC_SURFACES = [
  "public_racers",
  "public_race_events",
  "public_search",
  "public_sponsor_slots",
  "sponsorship_live",
  "waitlist_stats",
  "race_config",
  "sponsor_pricing",
  "sponsor_slot",
];

/** Must return nothing, or refuse. */
const SEALED = ["provider_credentials", "provider_connections", "rate_limit_counter"];

function env() {
  const out = {};
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = env();

if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be in .env.local.");
  process.exit(2);
}

const failures = [];

const HEADERS = { apikey: key, Authorization: `Bearer ${key}` };

/** One GET. Returns the status and, on success, the rows. */
async function read(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: HEADERS,
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Names that must not be readable through any public surface.
 *
 * ## Why probing is needed at all
 *
 * Reading `select=*` only reveals columns when there are rows. A view with none
 * returns `[]`, so the empty board this product launches with would report every
 * public view as clean *because it is empty* — which proves nothing. The column
 * list is the security boundary whether or not anybody has signed up.
 *
 * ## How a name can be probed without rows
 *
 * PostgREST answers `select=email` with 200 when `email` exists and is readable,
 * and 400 (`column ... does not exist`) when it does not. Status code alone, no
 * row read, no value returned. That is enough to tell a leak from an absence.
 *
 * The schema endpoint would answer this in one call, and it is deliberately not
 * used: it requires a *secret* key, and a check that has to hold a secret to run
 * is not the check this is. Everything here uses the publishable key, which is
 * the key an attacker already has.
 */
const PROBE_NAMES = [
  "email",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "api_key",
  "secret_key",
  "encrypted_secret",
  "key_last4",
  "key_version",
  "account_id",
  "external_account_ref",
  "provider_account_ref",
  "stripe_account_id",
  "customer_email",
  "external_customer_id",
  "provider_payment_id",
  "deleted_at",
];

/** 200 means the column exists and this key may read it. */
async function columnExists(table, column) {
  const response = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, {
    headers: HEADERS,
  });
  return { readable: response.status === 200, status: response.status };
}

/**
 * The probe proves it can tell a real column from an invented one.
 *
 * Without this the whole script could pass by always getting a non-200 — a
 * check that cannot fail is worse than no check, because it reports safety it
 * never verified. One known column and one that cannot exist, on a table that
 * is definitely readable.
 */
{
  const real = await columnExists("race_config", "duration_days");
  const fake = await columnExists("race_config", "definitely_not_a_column");

  if (!real.readable || fake.readable) {
    console.error(
      `The column probe cannot discriminate: a real column returned ${real.status} ` +
        `and an invented one returned ${fake.status}. Refusing to report a result ` +
        `from a check that cannot fail.`,
    );
    process.exit(1);
  }
}

console.log("Public surfaces, read with the publishable key:\n");

for (const table of PUBLIC_SURFACES) {
  const { status, body } = await read(table);

  if (status !== 200) {
    // Not necessarily a failure — a table may legitimately be closed. But it is
    // not a public surface either, so it is reported rather than counted clean.
    console.log(`  ${table.padEnd(22)} ${status}  (not readable)`);
    continue;
  }

  // 1. Whatever the row probe revealed, for any name the list below misses.
  const seen = Array.isArray(body) && body[0] ? Object.keys(body[0]) : [];
  const offending = seen.filter((c) => FORBIDDEN.test(c) && !ALLOWED.has(c));

  // 2. Every name on the list, by status code, rows or no rows.
  const leaked = [];
  for (const name of PROBE_NAMES) {
    const { readable } = await columnExists(table, name);
    if (readable) leaked.push(name);
  }

  if (leaked.length > 0) offending.push(...leaked);

  if (offending.length > 0) {
    failures.push(`${table}: exposes ${offending.join(", ")}`);
    console.log(`  ${table.padEnd(22)} FAIL  ${offending.join(", ")}`);
    continue;
  }

  const columns = seen.length > 0 ? `${seen.length} columns` : "no rows";
  const allowed = seen.filter((c) => ALLOWED.has(c));
  console.log(
    `  ${table.padEnd(22)} ok    ${columns}, ${PROBE_NAMES.length} names probed` +
      (allowed.length ? ` (allowlisted: ${allowed.join(", ")})` : ""),
  );
}

console.log("\nTables that must be sealed:\n");

for (const table of SEALED) {
  const { status, body } = await read(table);

  if (status !== 200) {
    console.log(`  ${table.padEnd(22)} sealed (${status})`);
    continue;
  }

  const rows = Array.isArray(body) ? body.length : 0;

  if (rows === 0) {
    console.log(`  ${table.padEnd(22)} sealed (200, no rows)`);
  } else {
    // The failure this whole script exists for.
    failures.push(`${table}: returned a row to the publishable key`);
    console.log(`  ${table.padEnd(22)} FAIL  returned ${rows} row(s)`);
  }
}

console.log("");

if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("No leaked columns, and every sealed table refused.");
}
