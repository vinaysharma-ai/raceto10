import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { Nav } from "@/components/landing/nav";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { RaceGlobe } from "@/components/globe/race-globe";
import { SponsorStrip } from "@/components/sponsors/sponsor-strip";

/**
 * The landing page.
 *
 *   header · hero · the map · sponsors · waitlist
 *
 * ## What is gone
 *
 * "How it works" and its three cards, the read-only reassurance line, the
 * footer's "Every number on this page is real", and the ten-slot sponsor rails
 * that used to flank every page.
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
    <>
      <Nav />

      <main className="flex-1">
        <Hero />
        <RaceGlobe />
        <SponsorStrip />
        <WaitlistForm />
      </main>

      <Footer />
    </>
  );
}
