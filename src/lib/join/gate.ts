/**
 * Whether the product is taking new entries.
 *
 * ## Why this exists
 *
 * Verification reads a racer's live Stripe account, and the owner has no Stripe
 * account to test with. That means the connect step can be exercised end to end
 * exactly once — by a real founder, with a real key. A switch that closes
 * signups without a deploy is what makes it possible to stop taking entries
 * while that is sorted out, rather than leaving the step live and broken.
 *
 * ## Closed by default, and closed by anything unexpected
 *
 * Only the exact string `true` opens this. Absent, `TRUE`, `1`, `yes`, an empty
 * string — all closed. That is the opposite of the usual default, and
 * deliberate: the failure mode of guessing wrong in the open direction is a
 * founder pasting a live Stripe key into a flow that is not ready to hold it.
 * The failure mode in the closed direction is that somebody is told to come
 * back later, on a site that is explicitly telling them so.
 *
 * ## Not a required variable
 *
 * It is read directly from `process.env` and never validated. A launch switch
 * that could break the build by being absent would be a launch switch nobody
 * dares touch. Its absence is a valid, closed configuration.
 *
 * ## Pure, and separate from the page
 *
 * The page and the server action must agree about whether the door is open. If
 * the page hides the form and the action would still accept a post — or worse,
 * the other way round — one of them is wrong and neither is checkable. One
 * function, both callers, tested directly.
 */

/** Only this exact string opens the gate. */
const OPEN_VALUE = "true";

/**
 * Whether the connect step is open.
 *
 * Takes the environment as an argument with `process.env` as the default, so a
 * test can exercise both states without mutating the real process.
 */
export function joinOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.JOIN_OPEN === OPEN_VALUE;
}

/** The heading, shown by the page. */
export const JOIN_CLOSED_TITLE = "Signups aren't open yet";

/** The page's explanation. Says what is true: nothing was saved, and nothing was sent. */
export const JOIN_CLOSED_BODY =
  "We are not taking new entries at the moment. Nothing has been saved and nothing has been sent to Stripe.";

/**
 * What the action says if a submission arrives anyway.
 *
 * Written separately from the page copy rather than reusing it: this is the
 * answer to somebody who pressed a button, so it has to state that the attempt
 * did not go through. The page's version explains a state; this one closes an
 * action.
 */
export const JOIN_CLOSED_REFUSAL =
  "Signups aren't open yet, so that key was not checked and nothing was saved. Your Stripe account was not contacted.";
