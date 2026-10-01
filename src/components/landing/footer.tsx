import { env } from "@/lib/env";

/**
 * Footer — the domain, and nothing else.
 *
 * It previously carried a second line: "Every number on this page is real."
 * That is removed, deliberately. The page now demonstrates the claim rather
 * than asserting it, and a sentence promising honesty underneath a page that
 * already shows it reads as protest.
 *
 * The domain is read from configuration rather than written here, so it cannot
 * drift from where the app is actually deployed.
 */
export function Footer() {
  const host = new URL(env.NEXT_PUBLIC_APP_URL).host;

  return (
    <footer className="border-t border-border">
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <p className="text-small text-text-muted">{host}</p>
      </div>
    </footer>
  );
}
