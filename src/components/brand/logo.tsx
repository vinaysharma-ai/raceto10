/**
 * The raceto10 mark — the digits "10" where the 0 is an open progress arc,
 * drawn in pure white stroke on black.
 *
 * The concept survives the redesign unchanged; only the execution moved. The
 * arc used to be the accent colour, which made the mark the brightest orange
 * thing on a page whose palette is now grey — so it is white now, like the
 * rest of the product, and the only thing distinguishing the two glyphs is
 * the shape of the zero.
 *
 * The 280° ring is deliberate: the gap is the progress still to go, which is
 * the whole idea of the product compressed into one stroke. Drawn as the zero
 * rather than as a smaller arc nested inside a full circle, because the nested
 * reading is illegible at 16px and has to survive being a favicon.
 *
 * Inline SVG rather than an image asset so it stays crisp at every size and
 * inherits `currentColor` from whatever it sits in.
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

      {/* the 1 */}
      <path d="M4.5 11 L9.5 6 L9.5 22" stroke="currentColor" />

      {/* the 0 — an open ring closed 280° of the way round */}
      <path d="M24 6 A8 8 0 1 1 16.12 12.61" stroke="currentColor" />
    </svg>
  );
}
