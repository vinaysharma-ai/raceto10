import Link from "next/link";

import { env } from "@/lib/env";
import { describeSlot, type SlotState, type TermPrice } from "@/lib/sponsors/board";

/**
 * One sponsor slot, at both sizes it appears in.
 *
 * Uniform and quiet while empty — one border, one background, one line of text.
 * Deliberately no colour variation between slots yet: the only thing that
 * distinguishes one from another right now is its number, and inventing
 * decoration to make them look different would be dressing up an empty
 * inventory as a full one. Real logos and real sponsor names arrive later and
 * are what will make them look different.
 *
 * ## Every sponsor-supplied value here arrives already sanitised
 *
 * `href` and `logoUrl` come from `describeSlot`, which guards each to what it
 * needs to be — the link may point anywhere, the logo only at our storage host.
 * This component must never render a raw `sponsor_link` or `sponsor_logo_url`.
 */

/** The host sponsor logos must come from, read so it cannot drift from uploads. */
const STORAGE_HOST = (() => {
  try {
    return new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname;
  } catch {
    // A malformed URL is reported loudly by src/lib/env.ts at boot. Null here
    // means logos simply do not render.
    return null;
  }
})();

const CARD =
  "flex h-[76px] w-[164px] shrink-0 flex-col justify-center rounded-card border border-border bg-surface px-4 transition-colors";

export function SponsorSlotCard({
  slot,
  pricing,
  href = "/sponsor",
}: {
  slot: SlotState;
  pricing: TermPrice[];
  /**
   * Where an empty slot goes when clicked.
   *
   * `/sponsor` on the landing page, because a visitor who clicks an empty slot
   * wants to know what it costs and how to take it. Defaulted rather than
   * required so the call site does not have to restate it.
   */
  href?: string;
}) {
  const view = describeSlot(slot, pricing, { logoHost: STORAGE_HOST });

  if (view.kind === "sponsored") {
    const content = (
      <>
        <span className="flex items-center gap-2">
          {view.logoUrl ? (
            // Deliberately a plain <img>, not next/image. next/image routes
            // remote sources through the server-side optimiser, which means the
            // *server* fetches the URL. The browser fetches this one instead,
            // and `describeSlot` has already restricted it to our storage host.
            //
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={view.logoUrl}
              alt=""
              width={16}
              height={16}
              className="h-4 w-4 shrink-0 rounded-sm object-contain"
            />
          ) : null}
          <span className="truncate text-small text-text">{view.name}</span>
        </span>
        {view.description ? (
          // One line, per the sold-slot spec. It was clamped to two, which does
          // not fit the card: the second line was sliced by the card's own edge,
          // so every occupied slot rendered a half-visible row of glyphs.
          <span className="mt-1 truncate text-small text-text-muted">
            {view.description}
          </span>
        ) : null}
      </>
    );

    // An unsafe or missing destination still shows the sponsor — it just does
    // not become a link. Sending a visitor who clicked a sponsor's card to our
    // own sales page would be worse than not being clickable at all.
    return view.href ? (
      <a
        href={view.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${CARD} hover:border-text focus-visible:border-text focus-visible:outline-none`}
      >
        {content}
      </a>
    ) : (
      <div className={CARD}>{content}</div>
    );
  }

  return (
    <Link
      href={href}
      className={`${CARD} hover:border-text focus-visible:border-text focus-visible:outline-none`}
    >
      <span className="text-small text-text-muted">{view.label}</span>
    </Link>
  );
}
