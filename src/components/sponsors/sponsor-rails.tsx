import Link from "next/link";

/**
 * The ten sponsor slots, empty.
 *
 * ## Nothing inside them, on purpose
 *
 * A slot at rest is a thin outline and nothing else: no price, no brand, no
 * placeholder logo. There are no sponsors, so a slot that showed anything would
 * be showing something that is not real. On hover the outline brightens and the
 * words appear, which is the entire inventory statement this product can
 * honestly make.
 *
 * Every slot goes to `/sponsor`, which says plainly that sponsorship has not
 * started. There is no checkout in V1 and no path to one.
 *
 * ## Two layouts, one component
 *
 * At 1280px and above these are fixed rails flanking the content column. Below
 * that there is no room beside the column, so they become a strip pinned to the
 * top and another to the bottom, each scrolling horizontally. The page's own
 * padding for those strips comes from `has-sponsors` on the page root.
 *
 * Which of the four groups is visible is decided entirely in CSS, so the markup
 * is the same at every width and there is no measurement or resize listener to
 * get out of step with the stylesheet.
 */

const SLOTS = [1, 2, 3, 4, 5];

function Slot() {
  return (
    <Link href="/sponsor" aria-label="Sponsor this slot" className="sponsor-slot">
      <span className="sponsor-slot__label">Sponsor this</span>
    </Link>
  );
}

function Group({ className, label }: { className: string; label: string }) {
  return (
    <aside className={className} aria-label={label}>
      {SLOTS.map((n) => (
        <Slot key={n} />
      ))}
    </aside>
  );
}

export function SponsorRails() {
  return (
    <>
      <Group className="sponsor-rail sponsor-rail--left" label="Sponsor slots, left" />
      <Group className="sponsor-rail sponsor-rail--right" label="Sponsor slots, right" />
      <Group className="sponsor-strip sponsor-strip--top" label="Sponsor slots, top" />
      <Group className="sponsor-strip sponsor-strip--bottom" label="Sponsor slots, bottom" />
    </>
  );
}
