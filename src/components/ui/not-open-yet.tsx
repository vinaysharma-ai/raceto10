import type { ReactNode } from "react";

/**
 * The honest "this isn't switched on yet" panel.
 *
 * One component, used by both `/join` and `/sponsor`. The two places a visitor
 * can be told "not yet" should look and read identically — a second
 * hand-rolled variant is how one of them quietly becomes a form that fails on
 * submit instead of a notice that says so up front.
 *
 * ## What it must always say
 *
 * Three things, in this order: that it isn't open, why, and that nothing
 * happened as a result. The last one is the one people actually need. A visitor
 * who has just typed their details into a form needs to be told that nothing
 * was saved and nothing was charged, in as many words — "unavailable" alone
 * leaves them wondering what they just did.
 *
 * No colour. There is no red in this palette, and this is not an error anyway;
 * `text-muted` on a bordered surface is the correct weight for a fact.
 */
export function NotOpenYet({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-medium">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-small text-text-muted prose">
        {children}
      </div>
    </div>
  );
}
