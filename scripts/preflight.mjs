// Production smoke test.
//
//   npm run preflight -- https://www.raceto10.lol
//   npm run preflight -- http://localhost:3939
//
// ## What this is allowed to do
//
// GETs, and POSTs sent the way a stranger sends them: no cookies, no headers,
// no secret. Nothing here reads or writes a database, and nothing reads an
// environment variable. The point is to find out what an anonymous visitor
// gets, which is the only thing a smoke test of a public site can honestly
// claim to measure.
//
// Three of the four POSTs below are chosen because they must *refuse* without a
// secret — a 401 and a 404 prove the guard is still there. The fourth,
// `/api/auth/start-check`, is the sign-in rate limit, and it is the one request
// in this file that changes anything at all: it counts one anonymous attempt
// against the caller's IP. That is exactly what one visitor loading `/join`
// does, it is bounded by the endpoint's own limit, and there is no way to ask
// "does this 5xx?" without asking the real endpoint.
//
// ## Why the HTML is unescaped before it is compared
//
// React escapes an apostrophe into `&#x27;`, so the headline is in the markup
// as `You said you&#x27;d get customers.` A naive `includes(HEADLINE)` fails
// against a page that is rendering the headline perfectly — which is a smoke
// test that reports the one thing it was written to check as broken.

const HEADLINE = "You said you'd get customers. Now prove it in public, for free.";

const SECURITY_HEADERS = [
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "permissions-policy",
  "strict-transport-security",
];

const base = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

if (!base) {
  console.error("usage: npm run preflight -- <base-url>");
  process.exit(2);
}

let origin;
try {
  origin = new URL(base);
} catch {
  console.error(`Not a usable URL: ${base}`);
  process.exit(2);
}
if (origin.protocol !== "http:" && origin.protocol !== "https:") {
  console.error(`Only http and https can be checked, got: ${origin.protocol}`);
  process.exit(2);
}

/** The order matters: `&amp;` last, or `&amp;lt;` decodes twice. */
function decodeEntities(html) {
  return html
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

let failures = 0;

function check(label, pass, detail = "") {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function info(label) {
  console.log(`INFO  ${label}`);
}

async function request(path, init = {}) {
  try {
    const response = await fetch(new URL(path, origin), { redirect: "follow", ...init });
    const body = await response.text();
    return { ok: true, status: response.status, headers: response.headers, body };
  } catch (error) {
    return { ok: false, status: null, headers: null, body: "", error: String(error) };
  }
}

const statusLine = (r) => (r.ok ? `status ${r.status}` : `request failed: ${r.error}`);

console.log(`preflight  ${origin.origin}\n`);

// --- The home page ---------------------------------------------------------

const home = await request("/");
check("/ returns 200", home.ok && home.status === 200, statusLine(home));

const homeText = home.ok ? decodeEntities(home.body) : "";
check(
  "/ contains the exact headline",
  homeText.includes(HEADLINE),
  homeText.includes(HEADLINE) ? "" : `looked for: ${HEADLINE}`,
);

// --- The public pages ------------------------------------------------------

for (const path of ["/join", "/sponsor", "/privacy", "/terms"]) {
  const response = await request(path);
  check(`${path} returns 200`, response.ok && response.status === 200, statusLine(response));
}

// --- A racer page that cannot exist ----------------------------------------

{
  const response = await request("/r/zzz-not-a-real-handle");
  check(
    "/r/<unknown> returns 404",
    response.ok && response.status === 404,
    statusLine(response),
  );
}

// --- Headers ---------------------------------------------------------------

{
  const missing = home.ok
    ? SECURITY_HEADERS.filter((name) => !home.headers.get(name))
    : SECURITY_HEADERS;

  check(
    "the five security headers are present on /",
    home.ok && missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : "",
  );
}

// --- Endpoints that must refuse --------------------------------------------

{
  const fixture = await request("/api/dev/fixture-payments", { method: "POST" });
  check(
    "POST /api/dev/fixture-payments returns 404",
    fixture.ok && fixture.status === 404,
    statusLine(fixture),
  );
}

{
  const reconcile = await request("/api/cron/reconcile");
  check(
    "GET /api/cron/reconcile returns 401 without a secret",
    reconcile.ok && reconcile.status === 401,
    statusLine(reconcile),
  );

  const activate = await request("/api/admin/activate-ready", { method: "POST" });
  check(
    "POST /api/admin/activate-ready returns 401 without a secret",
    activate.ok && activate.status === 401,
    statusLine(activate),
  );
}

// --- Files that must never be served ---------------------------------------

for (const path of ["/.env", "/.env.local", "/.fixtures/payments.json"]) {
  const response = await request(path);
  check(`${path} returns 404`, response.ok && response.status === 404, statusLine(response));
}

// --- The one endpoint a visitor is meant to reach --------------------------

{
  const started = await request("/api/auth/start-check", { method: "POST" });
  check(
    "POST /api/auth/start-check does not 5xx",
    started.ok && started.status < 500,
    statusLine(started),
  );
}

// --- What the gate is doing ------------------------------------------------
//
// Not a pass or a fail. Whichever way it is set is a decision, and this line
// only reports which one is in force.

{
  const join = await request("/join");
  const joinText = join.ok ? decodeEntities(join.body) : "";

  if (!join.ok) {
    info(`/join could not be read (${statusLine(join)}), so the gate is unknown`);
  } else if (joinText.includes("Signups aren't open yet")) {
    info("/join: JOIN CLOSED — signups aren't open yet");
  } else if (joinText.includes("Continue with Google")) {
    // The connect step is only ever rendered for a signed-in founder, so an
    // anonymous request cannot see it either way. Saying "open" here would be
    // a guess dressed as a measurement.
    info("/join: signed out — the gate is not observable anonymously; sign in to see the connect step");
  } else {
    info("/join: neither the closed notice nor the sign-in buttons were found");
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
