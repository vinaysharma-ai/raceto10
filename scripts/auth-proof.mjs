// Proves the sign-in buttons leave the page, and that the pending state ends.
//
//   npm run build
//   npx next start -p 3939
//   node scripts/auth-proof.mjs
//
// Every request that could write anything is intercepted in the browser and
// answered locally: `/api/auth/start-check` never reaches the server, so no
// counter row is touched. Local and production share one hosted database, and a
// proof is not a reason to write to it.
//
// `**/auth/v1/authorize**` is intercepted too — it is the address the browser
// is asserted to have arrived at, and following it for real would mean leaving
// for a provider.

import { chromium } from "playwright";

const BASE = process.env.PROOF_URL ?? "http://localhost:3939";

const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

/** The stub the authorize URL resolves to, so the navigation can complete. */
const STUB = { status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" };

/** Answers the limit check without involving the server, or the database. */
async function stubCheck(route, body = '{"ok":true}', delayMs = 0) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({ status: 200, contentType: "application/json", body });
}

const buttonNamed = (page, name) => page.getByRole("button", { name, exact: true });

const disabledOf = (page, name) =>
  page.evaluate(
    (label) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label)
        ?.disabled ?? null,
    name,
  );

async function openJoin(browser, routeCheck) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/api/auth/start-check", routeCheck);
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

const browser = await chromium.launch();

try {
  // ---------------------------------------------------------------------
  // 1 and 2. Each button navigates to its own authorize URL.
  // ---------------------------------------------------------------------
  for (const provider of ["google", "x"]) {
    const name = provider === "google" ? "Continue with Google" : "Continue with X";
    const { context, page } = await openJoin(browser, (route) => stubCheck(route));
    // Supabase's authorize endpoint answers with a 302 to the provider, so
    // without this the browser would follow it off-site for real.
    await page.route("**/auth/v1/authorize**", (route) => route.fulfill(STUB));

    const button = buttonNamed(page, name);
    await button.waitFor({ state: "visible", timeout: 20_000 });

    // This is also the X half of the earlier fix, end to end: the button is
    // rendered from the live Supabase settings, and it must be pressable.
    const blocked = await disabledOf(page, name);
    check(`${provider}: the button renders enabled`, blocked === false, `disabled=${blocked}`);

    await button.click();
    await page.waitForURL(/\/auth\/v1\/authorize/, { timeout: 15_000 });

    const url = new URL(page.url());
    check(
      `${provider}: the browser navigates to the authorize URL`,
      url.pathname.endsWith("/auth/v1/authorize") && url.searchParams.get("provider") === provider,
      `${url.origin}${url.pathname}`,
    );

    const redirectTo = url.searchParams.get("redirect_to");
    let parsed = null;
    try {
      parsed = new URL(redirectTo);
    } catch {
      /* reported below */
    }
    check(
      `${provider}: redirect_to is /auth/callback with next=/join`,
      parsed?.pathname === "/auth/callback" && parsed?.searchParams.get("next") === "/join",
      redirectTo,
    );

    // A navigation that actually committed is the proof the button is not
    // stuck: the document carrying `Redirecting...` is gone.
    check(
      `${provider}: the press navigated rather than sticking on Redirecting...`,
      page.url().includes("/auth/v1/authorize"),
    );

    await context.close();
  }

  // ---------------------------------------------------------------------
  // 3. A restored document resets the label.
  // ---------------------------------------------------------------------
  {
    // The check is held open so the pending state is on screen to be observed.
    const { context, page } = await openJoin(browser, (route) =>
      stubCheck(route, '{"ok":true}', 6000),
    );

    // Recorded rather than followed: the assertion below is that this is never
    // reached, and a stub keeps that check hermetic if the code regresses.
    let leftThePage = null;
    await page.route("**/auth/v1/authorize**", (route) => {
      leftThePage = route.request().url();
      return route.fulfill(STUB);
    });

    await buttonNamed(page, "Continue with Google").click();
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Redirecting..."),
      undefined,
      { timeout: 5_000 },
    );

    const bothDisabled = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .filter((b) => b.textContent.includes("Continue with") || b.textContent.trim() === "Redirecting...")
        .every((b) => b.disabled),
    );
    check("pending: the pressed button reads Redirecting... and both are disabled", bothDisabled);

    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );

    await page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === "Continue with Google",
        );
        return b && !b.disabled;
      },
      undefined,
      { timeout: 3_000 },
    );
    check("pageshow(persisted): the label resets and the button is pressable again", true);

    // The held-open check resolves after the reset. It must not drag the page
    // away, because the founder has been given it back.
    await page.waitForTimeout(7_000);
    check(
      "pageshow(persisted): a late arrival does not navigate the restored page",
      leftThePage === null && page.url().endsWith("/join"),
      leftThePage ?? page.url(),
    );

    await context.close();
  }

  // ---------------------------------------------------------------------
  // 4. The eight-second reset.
  // ---------------------------------------------------------------------
  {
    const { context, page } = await openJoin(browser, (route) => stubCheck(route));

    // The provider is made unreachable, which is the case the eight-second exit
    // exists for: the browser never leaves, so the button is the only thing
    // still on screen and it has to stop claiming it is redirecting.
    //
    // 204 rather than abort: a browser answers an aborted navigation with its
    // own error page, which would replace the very document under test. A 204
    // means "nothing to show", and Chromium stays exactly where it is.
    await page.route("**/auth/v1/authorize**", (route) =>
      route.fulfill({ status: 204, body: "" }),
    );

    await buttonNamed(page, "Continue with Google").click();

    // First prove the stuck state is reachable at all — otherwise the reset
    // below would pass for the wrong reason.
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Redirecting..."),
      undefined,
      { timeout: 5_000, polling: 250 },
    );
    check("provider unreachable: the button is left on Redirecting...", true);

    await page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === "Continue with Google",
        );
        return b && !b.disabled;
      },
      undefined,
      { timeout: 11_000, polling: 250 },
    );

    const notice = await page.locator('[role="status"]').textContent();
    check(
      "after 8s: the label resets with the slow sign-in sentence",
      notice === "Sign-in is taking longer than expected. Try again.",
      JSON.stringify(notice),
    );

    await context.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
