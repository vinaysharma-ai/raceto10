/**
 * The raceto10 mark — the digits "10", where the 0 is a track with a progress
 * arc drawn on it.
 *
 * Two strokes make the zero: a full ring at 40% and the arc at 100%. The arc is
 * the progress made, the dim ring is the whole distance, and the gap between the
 * arc's end and its start is what is left. That is the product compressed into
 * one glyph, and it needs both halves to read — an arc alone is a broken circle,
 * a ring alone is just a zero.
 *
 * The arc closes 280° of the way round. Drawn as the zero rather than as a
 * smaller arc nested inside a full circle, because the nested reading is
 * illegible at 16px and this has to survive being a favicon.
 *
 * Everything is `currentColor`, so in the header (inside `text-text`) the mark
 * renders #f5f5f3 exactly as specified, and nowhere has an accent colour of its
 * own. The arc was orange once; the palette has no accent now, and the ring's
 * lower opacity is the only thing separating the two glyphs.
 *
 * Inline SVG rather than an image asset so it stays crisp at every size.
 */
type LogoProps = {
  className?: string;
  /** Labels the mark for assistive tech. Omit when paired with a wordmark. */
  title?: string;
};

export function Logo({ className, title }: LogoProps) {
  return (
    <svg
      viewBox="0 0 36 28"
      fill="none"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      {/* the whole distance — the zero's track, at 40% */}
      <circle cx="24" cy="14" r="8" stroke="currentColor" opacity={0.4} />

      {/* the 1 */}
      <path d="M4.5 11 L9.5 6 L9.5 22" stroke="currentColor" />

      {/* the ground covered — 280° of the ring, at full strength */}
      <path d="M24 6 A8 8 0 1 1 16.12 12.61" stroke="currentColor" />
    </svg>
  );
}
