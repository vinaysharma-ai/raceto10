"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * The hero search.
 *
 * ## Why this one is a client component when the header's was not
 *
 * The header's version was a plain `GET` form: no state, no JavaScript, and the
 * query ended up in the URL. That is the better shape for a search that is the
 * page's purpose. This one is not — it sits above the fold on the page a
 * visitor lands on first, and its job is to answer "is anyone racing?" before
 * they have committed to anything. Sending them to another page to find that out
 * is a worse answer than showing them here.
 *
 * ## Every state says something
 *
 * A box that goes quiet is indistinguishable from a box that is broken. So all
 * of the outcomes are spoken: matches, no matches, nobody racing yet, and a read
 * that failed. The empty ones are separate sentences because they are separate
 * facts, and telling someone "no match" when the truth is "nobody has started a
 * race" sends them hunting for a spelling mistake that is not there.
 *
 * One character is not enough to search on, and rather than sit silent it says
 * so. That is the whole reason there is a `short` state.
 *
 * ## What is derived, and what is stored
 *
 * Only the *answer* is stored, tagged with the query it answers. Everything
 * else — too short, empty, waiting on a debounce — is a function of the text in
 * the box, so it is computed during render rather than pushed into state from
 * an effect. That is what keeps a slow reply for "ad" from painting itself over
 * a fast one for "ada": the reply is only shown while it still matches what is
 * typed.
 */

type Result = {
  public_slug: string;
  founder_name: string | null;
  x_handle: string | null;
  product_name: string | null;
};

type SearchResponse = {
  results: Result[];
  /**
   * Whether anybody is on the board at all.
   *
   * `false` and `null` mean different things and get different sentences:
   * `false` is "nobody has started a race yet", `null` is "we could not tell".
   */
  anyoneRacing: boolean | null;
  unavailable?: true;
};

type Outcome =
  | { kind: "idle" }
  | { kind: "short" }
  | { kind: "searching" }
  | { kind: "results"; results: Result[] }
  | { kind: "none-racing" }
  | { kind: "no-match" }
  | { kind: "unavailable" };

const FIELD_ID = "landing-search";
const RESULTS_ID = "landing-search-results";
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/** The most precise thing to ask the board for, given what this row has. */
function needleFor(racer: Result): string {
  return racer.founder_name ?? racer.x_handle ?? racer.product_name ?? racer.public_slug;
}

export function SearchBox({ className }: { className?: string }) {
  const [query, setQuery] = useState("");
  /** The last answer, and the query it was an answer to. */
  const [answer, setAnswer] = useState<{ for: string; outcome: Outcome } | null>(null);

  const trimmed = query.trim();

  // One in-flight request at a time. A slow response for "ad" must never land
  // on top of a fast one for "ada".
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (trimmed.length < MIN_CHARS) {
      inFlight.current?.abort();
      return;
    }

    const timer = setTimeout(async () => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("the search request failed");

        const body = (await response.json()) as SearchResponse;

        setAnswer({
          for: trimmed,
          outcome: body.unavailable
            ? { kind: "unavailable" }
            : body.results.length > 0
              ? { kind: "results", results: body.results }
              : body.anyoneRacing === false
                ? { kind: "none-racing" }
                : // Null means the count could not be read, which is not the same
                  // as an empty board. Saying "no match" there would be a claim
                  // we cannot support; saying "unavailable" is the truth.
                  body.anyoneRacing === null
                  ? { kind: "unavailable" }
                  : { kind: "no-match" },
        });
      } catch (error) {
        // An aborted request is this component replacing its own question, not
        // a failure. Only a real one becomes a message.
        if ((error as Error).name === "AbortError") return;
        setAnswer({ for: trimmed, outcome: { kind: "unavailable" } });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed]);

  // Leaving the page with a request open would resolve into an unmounted tree.
  useEffect(() => () => inFlight.current?.abort(), []);

  const outcome: Outcome =
    trimmed.length === 0
      ? { kind: "idle" }
      : trimmed.length < MIN_CHARS
        ? { kind: "short" }
        : answer && answer.for === trimmed
          ? answer.outcome
          : { kind: "searching" };

  return (
    <div className={`relative ${className ?? ""}`}>
      <label htmlFor={FIELD_ID} className="sr-only">
        Search a founder or SaaS
      </label>
      <input
        id={FIELD_ID}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search a founder or SaaS"
        autoComplete="off"
        aria-describedby={outcome.kind === "idle" ? undefined : RESULTS_ID}
        className="h-9 w-full min-w-0 rounded-pill border border-border bg-bg px-4 text-small text-text placeholder:text-text-muted/70 focus:border-text focus:outline-none"
      />

      <div
        id={RESULTS_ID}
        aria-live="polite"
        className={
          outcome.kind === "idle"
            ? "hidden"
            : "absolute left-0 right-0 top-full z-40 mt-2 rounded-card border border-border bg-surface p-2"
        }
      >
        {outcome.kind === "short" ? (
          <p className="px-2 py-1 text-small text-text-muted">Type one more character.</p>
        ) : null}

        {outcome.kind === "searching" ? (
          <p className="px-2 py-1 text-small text-text-muted">Searching...</p>
        ) : null}

        {outcome.kind === "none-racing" ? (
          <p className="px-2 py-1 text-small text-text-muted">
            No one has started a race yet.
          </p>
        ) : null}

        {outcome.kind === "no-match" ? (
          <p className="px-2 py-1 text-small text-text-muted">No match.</p>
        ) : null}

        {outcome.kind === "unavailable" ? (
          <p className="px-2 py-1 text-small text-text-muted">
            Search is unavailable just now. Try again in a moment.
          </p>
        ) : null}

        {outcome.kind === "results" ? (
          <ul className="flex flex-col">
            {outcome.results.map((racer) => (
              <li key={racer.public_slug}>
                <Link
                  href={`/leaderboard?q=${encodeURIComponent(needleFor(racer))}`}
                  className="flex flex-col rounded-sm px-2 py-2 transition-colors hover:bg-bg focus-visible:bg-bg focus-visible:outline-none"
                >
                  <span className="text-small text-text">
                    {racer.x_handle
                      ? `@${racer.x_handle}`
                      : (racer.founder_name ?? racer.public_slug)}
                  </span>
                  {racer.product_name ? (
                    <span className="text-small text-text-muted">{racer.product_name}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
