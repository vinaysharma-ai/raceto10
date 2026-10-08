import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { ShareOnX } from "@/components/share/share-on-x";
import { SponsorRails } from "@/components/sponsors/sponsor-rails";
import { getPublicRacer, getRacerEvents } from "@/lib/queries/race-board";
import { raceShareText, racerPageUrl } from "@/lib/share";
import {
  RACE_TARGET,
  describeActivity,
  finishedLabel,
  progressOf,
  timeAgo,
  timeRemaining,
  xProfileUrl,
} from "@/lib/race/board";

/**
 * `/r/[handle]` — one racer's public page.
 *
 * ## Why this exists
 *
 * The leaderboard answers "who is winning". It cannot answer "what happened to
 * this one person", which is the question a reader has after clicking a name —
 * and it is the link a founder sends to somebody who asks how the race is going.
 *
 * ## What it shows, and what it refuses to
 *
 * Product, status, count, and the timeline of what actually happened. No email,
 * no provider account, no customer, no amount — not because they are hidden here
 * but because none of them is in `public_racers` or `public_race_events` to
 * begin with. The views are the boundary; this page cannot leak what they do not
 * carry.
 *
 * ## The 404 is real
 *
 * `notFound()` rather than a page that says "no such racer". A slug belonging to
 * somebody who has not consented is indistinguishable from one that never
 * existed, which is deliberate: "this person exists but has not agreed to be
 * shown" is itself a fact about them, and a public page has no business
 * disclosing it.
 *
 * The rails are here because this is a public race page and the sponsor slots
 * belong to the public board, not to the join flow. `/join`, `/sponsor`,
 * `/privacy` and `/terms` have none.
 */

export const dynamic = "force-dynamic";

type Params = { handle: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { handle } = await params;
  const racer = await getPublicRacer(handle);

  if (!racer) return { title: "Not found" };

  const who = racer.x_handle ? `@${racer.x_handle}` : (racer.founder_name ?? handle);
  const name = racer.product_name ?? who;
  const count = progressOf(racer);

  // The product name leads, because it is what a reader recognises in a tab and
  // in a link preview; the founder's handle is what they search for. Every
  // field here is a column of `public_racers`, so no metadata can carry
  // something the page itself would not show.
  return {
    title: `${name}: ${count} of ${RACE_TARGET} on raceto10`,
    description: `${racer.product_name ? `${racer.product_name}, by ` : ""}${who} — ${count} of ${RACE_TARGET} paying customers, in public on raceto10.`,
  };
}

export default async function RacerPage({ params }: { params: Promise<Params> }) {
  const { handle } = await params;
  const racer = await getPublicRacer(handle);

  if (!racer) notFound();

  const events = await getRacerEvents(racer.public_slug);
  const progress = progressOf(racer);
  const remaining = timeRemaining(racer);
  const finished = finishedLabel(racer);
  const now = new Date();

  // The same fallback the metadata uses, so a shared card and the sentence in
  // it cannot name the founder differently.
  const who = racer.x_handle ? `@${racer.x_handle}` : (racer.founder_name ?? racer.public_slug);

  return (
    <div className="has-sponsors flex flex-1 flex-col">
      <SponsorRails />

      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-medium">
          {racer.x_handle ? (
            <a
              href={xProfileUrl(racer.x_handle)}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
            >
              @{racer.x_handle}
            </a>
          ) : (
            (racer.founder_name ?? racer.public_slug)
          )}
        </h1>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {racer.product_name ? (
            <p className="text-small text-text-muted">{racer.product_name}</p>
          ) : null}
          {racer.product_url ? (
            <a
              href={racer.product_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-small text-text-muted underline underline-offset-4 transition-colors hover:text-text"
            >
              Visit
            </a>
          ) : null}
        </div>

        <div className="mt-8 rounded-card border border-border bg-surface p-6">
          <div className="flex items-baseline gap-3">
            <span className={`text-medium ${racer.status === "finished" ? "text-live" : "text-text"}`}>
              {progress}
            </span>
            <span className="text-small text-text-muted">of {RACE_TARGET} customers</span>
          </div>

          <div className="mt-3 h-px w-full overflow-hidden bg-border">
            <div
              className={racer.status === "finished" ? "h-full bg-live" : "h-full bg-text"}
              style={{ width: `${(progress / RACE_TARGET) * 100}%` }}
            />
          </div>

          <p className="mt-4 text-small text-text-muted">
            {finished ? (
              <span className="text-live">{finished}</span>
            ) : racer.status === "expired" || remaining?.ended ? (
              <span>time ran out</span>
            ) : remaining ? (
              <span>
                {remaining.days}d {remaining.hours}h left
              </span>
            ) : (
              <span>Not started yet</span>
            )}
          </p>
        </div>

        <section className="mt-10">
          <h2 className="text-small text-text-muted">What happened</h2>

          {events.length === 0 ? (
            // Not an error and not a placeholder. A racer who has registered but
            // not started has genuinely done nothing yet.
            <p className="mt-3 text-small text-text-muted prose">
              Nothing has happened yet.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col">
              {events.map((event) => {
                const line = describeActivity(event);
                return (
                  <li
                    key={`${event.event_type}-${event.occurred_at}`}
                    className="flex flex-wrap items-baseline gap-x-2 border-b border-border py-2 text-small last:border-b-0"
                  >
                    <span className="text-text-muted">{line.what}</span>
                    <span className="ml-auto text-text-muted">
                      {timeAgo(event.occurred_at, now)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
          <ShareOnX
            text={raceShareText(racer.product_name ?? who, progress)}
            url={racerPageUrl(racer.public_slug)}
          />
          <Link
            href="/leaderboard"
            className="text-small text-text-muted underline-offset-4 transition-colors hover:text-text hover:underline"
          >
            The whole board
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
