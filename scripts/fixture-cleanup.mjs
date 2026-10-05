// Removes everything a fixture racer created.
//
//   npm run fixture:cleanup
//
// ## Why this has to exist
//
// Local development and production share one hosted database. A fixture race is
// a real set of rows — a racer, a connection, customers, events — and without
// this it would sit on the live public board next to real founders, with a
// number nobody paid for. That is the single worst outcome this product can
// produce, so removing one has to be as easy as creating one.
//
// ## What identifies a fixture racer
//
// `provider_connections.external_account_ref` is the account a key belongs to.
// A real one is Stripe's own `acct_…`; a fixture one is `acct_fixture…`
// (`FIXTURE_ACCOUNT_ID`). No flag, no schema, nothing to forget to set.
//
// ## Two guards, because this deletes
//
//   1. Every matched racer must have *only* fixture connections. A racer with
//      one real connection and one fixture connection is not a fixture racer,
//      and deleting them would destroy a real founder's race.
//   2. More than five matched racers aborts. The fixture path is for one person
//      testing alone; a larger number means the pattern matched something it was
//      not meant to, and stopping is cheaper than being wrong.
//
// Both raise, inside the transaction, so nothing is deleted when either fires.
//
// ## One transaction
//
// The whole thing is a single `do` block, which PostgreSQL runs as one
// transaction. A failure anywhere rolls back everything, so there is no state
// where a racer is gone and their customers are not.
//
// ## It never touches `profiles`
//
// Deliberate, and stated rather than implied. The profile is the signed-in
// person's account, created by OAuth and shared with every future race they
// enter. Deleting it would delete their login, which is not what cleaning up a
// test race means.
//
// ## Counts only
//
// The output is table names and row counts. No ids, no emails, nothing about
// anybody. A cleanup script that printed rows would be a second way to read the
// database, which is not what it is for.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Must match `FIXTURE_ACCOUNT_PREFIX` in src/lib/verification/stripe/fixture-mode.ts. */
const FIXTURE_PREFIX = "acct_fixture";

/** The most racers this will ever remove in one run. See the note above. */
const MAX_RACERS = 5;

const SQL = `
do $$
declare
  fixtures uuid[];
  n integer;
  removed integer;
begin
  select array_agg(distinct c.racer_id)
    into fixtures
    from provider_connections c
   where c.external_account_ref like '${FIXTURE_PREFIX}%';

  n := coalesce(array_length(fixtures, 1), 0);

  if n = 0 then
    raise notice 'no fixture racers found';
    return;
  end if;

  if n > ${MAX_RACERS} then
    raise exception 'refusing: % racers match the fixture pattern, limit is ${MAX_RACERS}', n;
  end if;

  -- Guard: a racer with any non-fixture connection is not a fixture racer.
  -- Deleting them would destroy a real founder's race.
  if exists (
    select 1
      from provider_connections c
     where c.racer_id = any(fixtures)
       and c.external_account_ref not like '${FIXTURE_PREFIX}%'
  ) then
    raise exception 'refusing: a matched racer also has a non-fixture connection';
  end if;

  raise notice 'removing % fixture racer(s)', n;

  -- Children before parents. Credentials and runs hang off the connection;
  -- customers, baselines and events hang off the racer; rate-limit rows are
  -- keyed on the racer id as the subject.
  delete from provider_credentials
   where provider_connection_id in (
     select id from provider_connections where racer_id = any(fixtures)
   );
  get diagnostics removed = row_count;
  raise notice '  provider_credentials  %', removed;

  delete from reconciliation_runs
   where provider_connection_id in (
     select id from provider_connections where racer_id = any(fixtures)
   );
  get diagnostics removed = row_count;
  raise notice '  reconciliation_runs   %', removed;

  delete from verification_snapshots where racer_id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  verification_snapshots %', removed;

  delete from race_customer where racer_id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  race_customer         %', removed;

  delete from race_baseline_customer where racer_id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  race_baseline_customer %', removed;

  delete from race_event where racer_id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  race_event            %', removed;

  -- The subject of a key-verification limit is the racer id.
  delete from rate_limit_counter where subject = any(fixtures::text[]);
  get diagnostics removed = row_count;
  raise notice '  rate_limit_counter    %', removed;

  delete from provider_connections where racer_id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  provider_connections  %', removed;

  delete from racer where id = any(fixtures);
  get diagnostics removed = row_count;
  raise notice '  racer                 %', removed;

  -- profiles is deliberately absent. See the header.
end $$;
`;

const dir = mkdtempSync(join(tmpdir(), "raceto10-fixture-"));
const file = join(dir, "cleanup.sql");
writeFileSync(file, SQL, "utf8");

try {
  const out = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "db", "query", "--linked", "--file", file],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(out.trim());
} catch (error) {
  // The CLI reports the raise as a non-zero exit with the message in stderr.
  // Printed as-is: the guards' text is written for a person.
  const detail = [error.stdout, error.stderr]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join("\n");
  console.error(detail || String(error.message));
  console.error("\nNothing was deleted.");
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
