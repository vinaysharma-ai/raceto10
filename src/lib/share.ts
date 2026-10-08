import { env } from "@/lib/env";
import { RACE_TARGET } from "@/lib/race/board";

/**
 * The share links.
 *
 * ## Why the text is built here
 *
 * The same sentence appears on a racer's page and on the founder's own view of
 * their race, and those two must not disagree — a founder sharing "6 of 10" and
 * landing a reader on a page that says something else is the kind of
 * inconsistency that makes a reader doubt the number.
 *
 * ## Why `intent/post` and not a widget
 *
 * It is a plain link to x.com. Nothing is loaded from X until somebody clicks
 * it, which means no third-party script on any page and no request to X from a
 * visitor who did not ask for one.
 */

/** "{product}: N of 10 customers on raceto10". */
export function raceShareText(name: string, count: number): string {
  return `${name}: ${count} of ${RACE_TARGET} customers on raceto10`;
}

/** The absolute URL of a racer's public page. */
export function racerPageUrl(slug: string): string {
  return new URL(`/r/${encodeURIComponent(slug)}`, env.NEXT_PUBLIC_APP_URL).toString();
}

/**
 * The compose window, prefilled.
 *
 * `URLSearchParams` rather than string concatenation: a product name is
 * founder-supplied and can contain an ampersand, a hash or a space, any of
 * which would truncate the URL or the text if it were pasted in raw.
 */
export function shareOnXUrl(text: string, url: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text, url }).toString()}`;
}
