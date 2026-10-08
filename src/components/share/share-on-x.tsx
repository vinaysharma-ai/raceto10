import { shareOnXUrl } from "@/lib/share";

/**
 * A plain link to X's compose window, prefilled.
 *
 * Not a button: it sits beside secondary links like "The whole board" and is
 * read as one. `target="_blank"` with `rel="noopener noreferrer"` — `noopener`
 * because a page opened from here has no business holding a handle on this one,
 * and `noreferrer` because a founder's public page is not a place to hand X a
 * referrer for every visitor who shares it.
 *
 * No script is loaded from X at any point; the visitor's browser only reaches
 * x.com if they click.
 */
export function ShareOnX({ text, url }: { text: string; url: string }) {
  return (
    <a
      href={shareOnXUrl(text, url)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-small text-text-muted underline-offset-4 transition-colors hover:text-text hover:underline"
    >
      Share on X
    </a>
  );
}
