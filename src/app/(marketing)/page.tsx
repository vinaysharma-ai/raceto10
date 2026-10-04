import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { Nav } from "@/components/landing/nav";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { RaceGlobe } from "@/components/globe/race-globe";
import { SponsorRails } from "@/components/sponsors/sponsor-rails";

/**
 * The landing page.
 *
 *   sponsor slots · header · hero · the map · waitlist · footer
 *
 * ## The rails are back, and empty
 *
 * Ten outlined slots used to flank this page carrying prices and a "take a
 * position" flow. They were removed, and they return here with nothing in them:
 * an outline at rest, `Sponsor this` on hover, and a click that lands on a page
 * saying sponsorship has not started. No price, because there is no price
 * anyone can pay yet, and an empty slot is the only honest way to draw an empty
 * product.
 *
 * `has-sponsors` is what reserves the space the fixed top and bottom strips
 * occupy below 1340px. It has to be on this element rather than on `main`, or
 * the header and the footer would sit underneath the strips.
 *
 * ## What is gone
 *
 * "How it works" and its three cards, the read-only reassurance line, the
 * footer's "Every number on this page is real", and the sponsor grid that used
 * to sit under the globe with a price on every card.
 *
 * The footer line is worth one sentence, because removing it looks like a
 * regression. A sentence *asserting* honesty is weaker than a page that
 * demonstrates it: the count vanishes when it cannot be read, the map shows no
 * dots when nobody has joined, and the sponsor slots show no logos because
 * there are no sponsors. All visible proof. A line of copy claiming the same
 * thing asks to be taken on trust, and it is the kind of copy that appears on
 * exactly the sites that are making their numbers up.
 */
export default function Home() {
  return (
    <div className="has-sponsors flex flex-1 flex-col">
      <SponsorRails />

      <Nav />

      <main className="flex-1">
        <Hero />
        <RaceGlobe />
        <WaitlistForm />
      </main>

      <Footer />
    </div>
  );
}
