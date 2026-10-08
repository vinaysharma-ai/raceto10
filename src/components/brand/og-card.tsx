import { HEADLINE } from "@/lib/headline";
import { RACE_TARGET } from "@/lib/race/board";

/**
 * The link-preview cards, drawn rather than rendered.
 *
 * ## Why every style here is inline
 *
 * These are laid out by satori, which `next/og` uses to turn an element tree
 * into a PNG. Satori understands a subset of flexbox and reads no stylesheet:
 * a Tailwind class on one of these elements is a class that does nothing at
 * all, silently, and the card comes out unstyled. Inline styles are not a
 * preference here, they are the only thing that works.
 *
 * ## Why the mark is copied rather than imported
 *
 * `Logo` is `currentColor` throughout, which is what lets the header tint it.
 * Satori resolves `currentColor` inconsistently inside an `svg`, and a card
 * that renders a black mark on a black background is a card with no mark on it.
 * So the same three paths are drawn here with the colour named outright. If the
 * mark changes, both files change; that is the cost of not being able to share
 * the `currentColor` trick across two renderers.
 *
 * ## No fonts are fetched
 *
 * `ImageResponse` falls back to the font bundled with Next when none is given.
 * Naming a family here would mean a network request at build time and a card
 * that fails to render whenever that request does — for a typeface that is not
 * worth an outage.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

// Named rather than themed, because there is no CSS custom property to read.
// They are the values in `globals.css`, transcribed.
const BG = "#0a0a0a";
const TEXT = "#f5f5f3";
const MUTED = "#8a8a85";
const LIVE = "#34c77b";

/** The raceto10 mark: the digits "10", where the 0 is a track with an arc on it. */
function Mark({ px }: { px: number }) {
  return (
    <svg
      width={px}
      height={Math.round((px * 28) / 36)}
      viewBox="0 0 36 28"
      fill="none"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* the whole distance */}
      <circle cx="24" cy="14" r="8" stroke={TEXT} opacity={0.4} />
      {/* the 1 */}
      <path d="M4.5 11 L9.5 6 L9.5 22" stroke={TEXT} />
      {/* the ground covered */}
      <path d="M24 6 A8 8 0 1 1 16.12 12.61" stroke={TEXT} />
    </svg>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: BG,
        padding: "0 80px",
      }}
    >
      {children}
    </div>
  );
}

/** "raceto10.lol", the same on every card. */
function Address() {
  return (
    <div style={{ marginTop: 40, display: "flex", fontSize: 30, color: MUTED }}>
      raceto10.lol
    </div>
  );
}

/**
 * The brand card: what `/` shows, and what any racer page falls back to.
 *
 * It carries no numbers and no names. A card that guessed at a count would be
 * the one place on the site where a figure appears that nothing verified.
 */
export function BrandCard() {
  return (
    <Frame>
      <Mark px={120} />
      <div
        style={{
          display: "flex",
          marginTop: 44,
          fontSize: 56,
          fontWeight: 600,
          lineHeight: 1.25,
          color: TEXT,
          textAlign: "center",
          maxWidth: 940,
        }}
      >
        {HEADLINE}
      </div>
      <Address />
    </Frame>
  );
}

/**
 * One racer's card.
 *
 * Everything on it comes from `public_racers`, which is the same boundary the
 * page behind it reads from — so a card cannot show what the page would refuse
 * to. There is deliberately no avatar: `avatar_url` is a provider URL and
 * fetching it would make this route depend on somebody else's host being up.
 */
export function RacerCard({
  who,
  product,
  count,
  status,
  done,
}: {
  who: string;
  product: string | null;
  count: number;
  status: string;
  done: boolean;
}) {
  return (
    <Frame>
      <Mark px={88} />

      <div
        style={{
          display: "flex",
          marginTop: 40,
          fontSize: 56,
          fontWeight: 600,
          color: TEXT,
          textAlign: "center",
          maxWidth: 940,
        }}
      >
        {product ?? who}
      </div>

      {product ? (
        <div style={{ display: "flex", marginTop: 14, fontSize: 32, color: MUTED }}>
          {who}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "baseline", marginTop: 44 }}>
        <span style={{ fontSize: 112, fontWeight: 700, color: done ? LIVE : TEXT }}>
          {count}
        </span>
        <span style={{ fontSize: 46, color: MUTED, marginLeft: 16 }}>
          of {RACE_TARGET}
        </span>
      </div>

      <div style={{ display: "flex", marginTop: 20, fontSize: 34, color: done ? LIVE : MUTED }}>
        {status}
      </div>

      <Address />
    </Frame>
  );
}
