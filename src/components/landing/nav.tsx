import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { ButtonLink, TextLink } from "@/components/ui/button";

/**
 * The header — the mark on the left, the two ways onward on the right.
 *
 * The search used to live here and moved into the hero, where it sits under the
 * subline next to the call to action. In the header it competed with the
 * wordmark for a strip that is mostly empty, and it pushed the one action on the
 * page into the corner.
 *
 * ## One border, at the bottom of the row
 *
 * The only divider in the header, and it is on the `header` element itself so it
 * spans the viewport. An earlier version drew a rule inside the content column
 * that stopped short of the page edge and read as a rendering fault.
 */
export function Nav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-6 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-text">
          <Logo className="h-5 w-auto" />
          <span className="text-small">raceto10</span>
        </Link>

        <nav className="ml-auto flex items-center gap-4">
          <TextLink href="/sponsor">Sponsor</TextLink>
          <ButtonLink href="/join" className="shrink-0">
            Join the race
          </ButtonLink>
        </nav>
      </div>
    </header>
  );
}
