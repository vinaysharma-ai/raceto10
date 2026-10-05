// Calls a protected endpoint on the running app, from the command line.
//
//   npm run reconcile   ->  POST {APP_URL}/api/cron/reconcile
//   npm run activate    ->  POST {APP_URL}/api/admin/activate-ready
//
// Reads APP_URL and CRON_SECRET out of `.env.local`, the same file the dev
// server reads, so there is one place these values live locally and no shell
// setup beyond the flag.
//
// The secret is never printed. What is printed is the status code and the JSON
// body, which is the endpoint's own counts-only summary — deliberately the only
// thing these endpoints return.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/call-cron.mjs /api/cron/reconcile");
  process.exit(2);
}

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

const url = new URL(path, appUrl).toString();

const response = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});

console.log(`${response.status} ${url}`);

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
