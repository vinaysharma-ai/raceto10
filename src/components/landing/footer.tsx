import { TextLink } from "@/components/ui/button";

/**
 * Footer — the address, and the pages that have to be reachable from every
 * screen.
 *
 * It previously carried a second line: "Every number on this page is real."
 * That is removed, deliberately. The page now demonstrates the claim rather
 * than asserting it, and a sentence promising honesty underneath a page that
 * already shows it reads as protest.
 *
 * The domain is written literally rather than read from configuration. It is
 * the product's public address, not a property of whichever deploy is
 * rendering, and a footer that says `localhost:3000` in one environment is a
 * footer that can say the wrong thing in another.
 */
export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-6">
        <p className="text-small text-text-muted">www.raceto10.lol</p>

        <nav className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <TextLink href="/sponsor">Sponsor</TextLink>
          <TextLink href="/privacy">Privacy</TextLink>
          <TextLink href="/terms">Terms</TextLink>
        </nav>
      </div>
    </footer>
  );
}
