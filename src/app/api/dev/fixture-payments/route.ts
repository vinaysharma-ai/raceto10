import { NextResponse } from "next/server";

import { addFixturePayments, fixtureMode } from "@/lib/verification/stripe/fixture.ts";

/**
 * Mints synthetic paying customers, locally only.
 *
 * ## Why it 404s rather than 403s
 *
 * A 403 would confirm the route exists. On a deployment where this is not
 * supposed to be reachable, the honest answer to "what is at this path" is
 * nothing at all — the same answer any other unregistered path gives. The route
 * carrying a name like `dev/fixture-payments` is already a hint; a status code
 * that distinguishes "disabled" from "absent" is a further one.
 *
 * ## Two guards, and the outer one is not the flag
 *
 * `fixtureMode()` requires `NODE_ENV !== "production"` *and*
 * `STRIPE_FIXTURE_MODE=true`. On Vercel `NODE_ENV` is always `production`, so
 * no environment configuration can open this route there.
 *
 * `addFixturePayments` re-checks the same predicate rather than trusting this
 * handler. That is not redundancy for its own sake: this is the one function in
 * the product that can fabricate a customer, and a caller that forgot to ask
 * first should still be refused.
 */

export const dynamic = "force-dynamic";

function notFound() {
  return new NextResponse(null, { status: 404 });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!fixtureMode()) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Expected JSON." }, { status: 400 });
  }

  const { racerId, add } = (body ?? {}) as { racerId?: unknown; add?: unknown };

  if (typeof racerId !== "string" || !racerId) {
    return NextResponse.json({ ok: false, message: "racerId is required." }, { status: 400 });
  }

  const count = Number(add);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return NextResponse.json(
      { ok: false, message: "add must be a whole number from 1 to 10." },
      { status: 400 },
    );
  }

  const result = await addFixturePayments(racerId, count);

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, total: result.total });
}
