"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps the home page current without a socket.
 *
 * ## Why polling, and why sixty seconds
 *
 * V1 has no realtime. The number on this page is verified by a reconciler that
 * runs every thirty minutes, so a faster refresh would mostly redraw the same
 * figures — and a websocket would be a second, always-open connection to keep
 * honest for a page that changes twice an hour.
 *
 * Sixty seconds is the compromise the product states: fast enough that arriving
 * on the page after a tab has been idle does not show a number that is hours
 * stale, slow enough that an open tab is not a request every few seconds.
 *
 * ## Only while visible
 *
 * A background tab that keeps asking is a cost with no reader. `router.refresh`
 * re-renders the server components in place, so nothing here replaces state a
 * visitor is looking at — no scroll jumps, no form cleared — which is what makes
 * refreshing at all acceptable on a page with a search box on it.
 *
 * ## It renders nothing
 *
 * A component whose whole job is a side effect. It is in the tree rather than in
 * the page's own script so that the page stays a server component and no data
 * fetching moves to the browser.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      // `visibilityState` rather than a focus event, because a tab can be
      // focused in a window nobody is looking at. The check runs inside the tick
      // rather than gating the interval, so a tab that becomes visible resumes
      // on its own without a second listener to keep in step.
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);

    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}
