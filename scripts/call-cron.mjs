// Calls a protected endpoint on the app, from the command line.
//
//   npm run reconcile            POST {APP_URL}/api/cron/reconcile
//   npm run activate             POST {APP_URL}/api/admin/activate-ready
//   npm run activate -- --prod   the same, against a real deployment
//
// Reads APP_URL and CRON_SECRET out of `.env.local`, the same file the dev
// server reads, so there is one place these values live locally.
//
// The secret is never printed. What is printed is the target host, the status
// code, and the JSON body — which is the endpoints' own counts-only summary,
// deliberately the only thing they return.
//
// ---------------------------------------------------------------------------
// Why this refuses things
// ---------------------------------------------------------------------------
//
// Local development and production share one hosted database. That makes
// `npm run activate` against a localhost target the single most dangerous
// command in this repository: it looks like a local operation, it goes to a
// local server, and it activates every real racer who is waiting — because the
// rows it reads are the real ones.
//
// So the target is decided first, printed before anything is sent, and three
// rules apply:
//
//   1. A non-localhost target requires `--prod`. Reaching a real deployment is
//      something somebody says out loud.
//   2. `--prod` requires an `https` target. `--prod` over plain HTTP would mean
//      sending CRON_SECRET in clear text.
//   3. Activating against a localhost target requires `--local`. This is the
//      one rule that is not in the brief's two; it exists because the brief's
//      third sentence asks for it — a localhost run must not be able to activate
//      real racers by accident — and rules 1 and 2 do not cover that case,
//      because localhost is the default and always allowed.
//
// `reconcile` is not given rule 3. It is idempotent, it changes no racer's
// status except to finish or expire one whose window has closed, and the fixture
// walkthrough needs it locally.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const path = args.find((a) => a.startsWith("/"));
const flags = new Set(args.filter((a) => a.startsWith("--")));

if (!path) {
  console.error("usage: node scripts/call-cron.mjs /api/cron/reconcile [--prod|--local]");
  process.exit(2);
}

/** The endpoint that changes state rather than just reading it. */
const ACTIVATE = "/api/admin/activate-ready";

function readEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(".env.local", "utf8");
  } catch {
    return env;
  }

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnvLocal();

const appUrl = process.env.APP_URL ?? env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
const secret = process.env.CRON_SECRET ?? env.CRON_SECRET;

if (!appUrl) {
  console.error("APP_URL is not set in .env.local (or the environment).");
  process.exit(2);
}
if (!secret) {
  console.error("CRON_SECRET is not set in .env.local (or the environment).");
  process.exit(2);
}

// --- Where this is about to go ----------------------------------------------
let target;
try {
  target = new URL(path, appUrl);
} catch {
  console.error(`APP_URL is not a usable URL: ${appUrl}`);
  process.exit(2);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocal = LOCAL_HOSTS.has(target.hostname);
const isHttps = target.protocol === "https:";

// Printed before anything is sent, and before any refusal, so a refusal still
// tells you where it was pointed.
console.log(`target  ${target.origin}${target.pathname}`);
console.log(`mode    ${isLocal ? "local" : "remote"}`);

if (!isLocal) {
  if (!flags.has("--prod")) {
    console.error(
      `\nRefusing: ${target.host} is not localhost. Re-run with '-- --prod' if that is really where you mean to go.`,
    );
    process.exit(2);
  }
  if (!isHttps) {
    console.error(
      "\nRefusing: --prod over plain http would send CRON_SECRET in clear text. The target must be https.",
    );
    process.exit(2);
  }
}

if (isLocal && path === ACTIVATE && !flags.has("--local")) {
  console.error(
    [
      "",
      "Refusing: activating against a localhost target.",
      "",
      "Local and production share one hosted database, so this would activate",
      "every real racer who is waiting — the server is local, the rows are not.",
      "",
      "  fixture walkthrough   npm run activate -- --local",
      "  a real deployment     npm run activate -- --prod",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

// --- Send --------------------------------------------------------------------
const response = await fetch(target, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});

console.log(`${response.status}`);

const text = await response.text();
if (text) {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    // The endpoints return counts only, so this should not happen — but if one
    // ever returns something else, print it rather than swallowing it.
    console.log(text);
  }
}

process.exit(response.ok ? 0 : 1);
