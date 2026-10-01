import { Suspense } from "react";

import { ButtonLink } from "@/components/ui/button";
import { getRaceBoard } from "@/lib/queries/race-board";
import { racersOnTheBoard } from "@/lib/race/board";

/**
 * Hero.
 *
 * The headline and subline are locked copy, reproduced verbatim. The subline
 * names Stripe because Stripe is the only processor actually wired — the
 * correction pass was explicit that the copy must not imply a choice the
 * product does not offer yet.
 *
 * One CTA, and no form fields: the button goes to `/join`, it does not scroll
 * to an input.
 */

/**
 * The live number.
 *
 * It counts racers, not waitlist signups. The waitlist was the right number
 * when nothing could be joined; now that a race can actually be started, the
 * honest headline figure is how many people are in one. A count of people
 * waiting to do a thing you can already do is a count of nothing.
 *
 * When the board cannot be read it renders **nothing** rather than a zero.
 * Zero is a claim — "nobody is racing" — and if the database is unreachable we
 * do not know that. The number is real, or it does not appear.
 */
async function LiveCount() {
  const result = await getRaceBoard();

  if (!result.ok) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[live-count] no number rendered — ${result.reason}`);
    }
    return null;
  }

  const count = racersOnTheBoard(result.board.racers).length;

  return (
    <p className="flex flex-wrap items-baseline gap-x-3">
      <span className="text-medium text-text">{count}</span>
      <span className="text-small text-text-muted">
        {count === 1 ? "founder racing" : "founders racing"}
      </span>
    </p>
  );
}

export function Hero() {
  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-12 pt-16">
      {/* Streamed: the headline paints before the count resolves, so a slow
          database read never delays the first meaningful paint. */}
      <Suspense fallback={null}>
        <LiveCount />
      </Suspense>

      <h1 className="mt-6 text-large text-text">
        You said you&apos;d get customers. Now prove it — in public, for free.
      </h1>

      <p className="mt-5 max-w-2xl text-small text-text-muted">
        raceto10 — connect Stripe, race to your first 10 customers.
      </p>

      <div className="mt-7">
        <ButtonLink href="/join">Join the race</ButtonLink>
      </div>
    </section>
  );
}
