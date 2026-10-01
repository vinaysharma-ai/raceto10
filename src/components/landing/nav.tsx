import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { ButtonLink } from "@/components/ui/button";

/**
 * The header — mark, search, and the one action.
 *
 * ## A plain form, not a client component
 *
 * The search is an HTML `GET` form posting to `/leaderboard`. That means it
 * works with JavaScript disabled, the query ends up in the URL, and a search is
 * shareable and back-button-able — three things a client-side filter with
 * `useState` gives up for no benefit at this size. It also keeps the header a
 * server component, so nothing about it ships to the browser.
 *
 * ## One border, at the bottom of the row
 *
 * The only divider in the header. The previous version had a rule that stopped
 * short of the page edge and read as a rendering fault; this one spans the
 * viewport and sits under the whole row.
 */
export function Nav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-3 px-6 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-text">
          <Logo className="h-5 w-auto" />
          <span className="text-small">raceto10</span>
        </Link>

        {/* Beside the logo on desktop; its own row underneath on phones, where
            squeezing it between the mark and the button would leave it too
            narrow to read the placeholder. */}
        <form
          action="/leaderboard"
          method="get"
          role="search"
          className="order-last w-full sm:order-none sm:w-56"
        >
          <label htmlFor="site-search" className="sr-only">
            Search a founder or startup
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="Search a founder or startup."
            autoComplete="off"
            className="h-8 w-full rounded-pill border border-border bg-bg px-3 text-small text-text placeholder:text-text-muted/70 focus:border-text focus:outline-none"
          />
        </form>

        <ButtonLink href="/join" className="ml-auto shrink-0">
          Join the race
        </ButtonLink>
      </div>
    </header>
  );
}
