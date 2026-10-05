import type { Metadata } from "next";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { TextLink } from "@/components/ui/button";
import { getRaceBoard } from "@/lib/queries/race-board";
import {
  RACE_TARGET,
  finishedLabel,
  progressOf,
  racersOnTheBoard,
  racersWaiting,
  rankRacers,
  searchRacers,
  timeRemaining,
  xProfileUrl,
  type PublicRacer,
} from "@/lib/race/board";

/**
 * `/leaderboard` — the public race.
 *
 * This is where a racer lands once their window opens, so it is the payoff
 * screen for the whole signup: a founder should arrive and see themselves on
 * the board with their clock running.
 *
 * ## Columns, per `01` §6
 *
 * X handle, product, customers, progress. MRR is deliberately absent — `00`
 * defers it until currency normalisation is honest, and a revenue column that
 * silently compares dollars to rupees is worse than no column.
 *
 * ## Waiting racers are kept off the board
 *
 * `01` §6: "Waiting users are not mixed into the active board." A founder who
 * is verified and eligible but whose clock has not started has no progress to
 * rank, and putting them in the same list would rank them at zero beside people
 * who are actually racing. They get their own short section instead.
 */

export const metadata: Metadata = {
  title: "The board",
  description: `Founders racing to their first ${RACE_TARGET} paying customers, in public.`,
};

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ q }, result] = await Promise.all([searchParams, getRaceBoard()]);

  const query = typeof q === "string" ? q : "";
  const all = result.ok ? rankRacers(racersOnTheBoard(result.board.racers)) : [];
  const shown = searchRacers(all, query);
  const waiting = result.ok ? racersWaiting(result.board.racers) : [];

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="text-medium">The board</h1>
          {result.ok && all.length > 0 ? (
            <p className="text-small text-text-muted">
              {all.length} {all.length === 1 ? "founder" : "founders"} racing
            </p>
          ) : null}
        </div>

        {query ? (
          <p className="mt-2 text-small text-text-muted">
            {shown.length} {shown.length === 1 ? "result" : "results"} for{" "}
            <span className="text-text">{query}</span>.{" "}
            <TextLink href="/leaderboard">Clear</TextLink>
          </p>
        ) : null}

        <div className="mt-8">
          {!result.ok ? (
            // Not an empty board. We could not read it, and saying "nobody is
            // racing" would be a claim we cannot support.
            <p className="text-small text-text" role="alert">
              The board could not be loaded just now. That is a problem on our
              side, not an empty race.
            </p>
          ) : all.length === 0 ? (
            <div className="rounded-card border border-border bg-surface p-6">
              <p className="text-small text-text-muted prose">
                No races have started yet.
              </p>
              <div className="mt-5">
                <TextLink href="/join">Be the first</TextLink>
              </div>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-small text-text-muted">
              No founder or startup matches that.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {shown.map((racer, index) => (
                <RacerRow key={racer.public_slug} racer={racer} position={index + 1} />
              ))}
            </ol>
          )}
        </div>

        {waiting.length > 0 && !query ? (
          <section className="mt-10">
            <h2 className="text-small text-text-muted">
              Waiting to start · {waiting.length}
            </h2>
            <p className="mt-2 text-small text-text-muted prose">
              Verified at zero customers. Their clocks have not started yet.
            </p>
            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
              {waiting.map((racer) => (
                <li key={racer.public_slug} className="text-small text-text-muted">
                  <Identity racer={racer} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <Footer />
    </>
  );
}

function Identity({ racer }: { racer: PublicRacer }) {
  if (racer.x_handle) {
    return (
      <a
        href={xProfileUrl(racer.x_handle)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
      >
        @{racer.x_handle}
      </a>
    );
  }

  return <span className="text-text">{racer.founder_name ?? racer.public_slug}</span>;
}

function RacerRow({ racer, position }: { racer: PublicRacer; position: number }) {
  const progress = progressOf(racer);
  const remaining = timeRemaining(racer);
  const finished = racer.status === "finished";

  // Column widths are fixed rather than content-sized so the numbers line up
  // down the page. A leaderboard whose digits move horizontally from row to row
  // is hardest to read at exactly the moment someone is comparing two of them.
  return (
    <li className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 text-small text-text-muted">{position}</span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Identity racer={racer} />
            {racer.product_name ? (
              <span className="min-w-0 truncate text-small text-text-muted">
                {racer.product_name}
              </span>
            ) : null}
          </div>

          {/* The bar is the count, drawn. It cannot disagree with the number to
              the right because both come from `progress`. */}
          <div className="mt-2 h-px w-full overflow-hidden bg-border">
            <div
              className={finished ? "h-full bg-live" : "h-full bg-text"}
              style={{ width: `${(progress / RACE_TARGET) * 100}%` }}
            />
          </div>
        </div>

        <span className="w-12 shrink-0 text-right text-small">
          <span className={finished ? "text-live" : "text-text"}>{progress}</span>
          <span className="text-text-muted">/{RACE_TARGET}</span>
        </span>
      </div>

      <p className="mt-2 pl-8 text-small text-text-muted">
        {finishedLabel(racer) ? (
          // How long it took, not just that it happened. Every finished racer
          // has ten customers, so the only thing separating two of them is the
          // time — and green is reserved for genuinely live state, which a won
          // race is.
          <span className="text-live">{finishedLabel(racer)}</span>
        ) : racer.status === "expired" ? (
          // Stated rather than hidden: a board that quietly drops the founders
          // who did not make it is a list of winners, not a record of a race.
          <span>time ran out</span>
        ) : remaining?.ended ? (
          // The clock has passed but the row has not been reconciled since, so
          // it is still `racing`. Says the same thing until the next run writes
          // the transition.
          <span>time ran out</span>
        ) : remaining ? (
          <span>
            {remaining.days}d {remaining.hours}h left
          </span>
        ) : null}
      </p>
    </li>
  );
}
