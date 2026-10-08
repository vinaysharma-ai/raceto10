import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { clientIp } from "@/lib/geo";
import { consume } from "@/lib/queries/rate-limit";

/**
 * May this address start another sign-in?
 *
 * ## Why this is a route and not a server action
 *
 * The limit has to be asked before the browser leaves for the provider, and the
 * thing that answers it must not also be the thing that navigates. A server
 * action that both counted and redirected could report a refusal only by
 * redirecting back to the page that had just asked — which is how the button
 * that started this ended up stuck.
 *
 * So the question and the navigation are separate: the browser asks here, gets
 * one bit back, and only then decides.
 *
 * ## What it returns
 *
 * `{limited:true}` when this address has used its twenty, `{ok:true}`
 * otherwise. Nothing else, and nothing about the subject — the bucket is keyed
 * on an IP address, and echoing one back would put it in a response body for no
 * reason.
 *
 * ## Why every failure is `{ok:true}`
 *
 * The caller treats anything that is not an explicit `{limited:true}` as
 * permission, and this handler is written so that stays true even if it is the
 * thing that breaks: `consume` is called with `failClosed: false`, an
 * unreadable counter allows, and the `catch` below turns a throw into the same
 * answer. A limiter that locks people out when its own storage is down is a
 * worse outage than the script it exists to bound.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const limit = await consume("signinStart", clientIp(await headers()), {
      failClosed: false,
    });

    if (!limit.allowed) return NextResponse.json({ limited: true });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
