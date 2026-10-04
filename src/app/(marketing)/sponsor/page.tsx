import type { Metadata } from "next";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { TextLink } from "@/components/ui/button";
import { NotOpenYet } from "@/components/ui/not-open-yet";
import { env } from "@/lib/env";

/**
 * `/sponsor` — the ten slots, and the truth about them.
 *
 * ## Why there is no grid here any more
 *
 * This page used to render ten cards with a price on each, read from a real
 * price table and a real exclusion constraint. All of that was built and none
 * of it could take money, so the page showed a price list above a notice saying
 * nothing could be bought. A price nobody can pay is not information.
 *
 * What is left is the notice, and the only two facts that are true: the slots
 * exist, and they are not for sale yet. The slots themselves are drawn on the
 * home page, empty, because that is what they are.
 *
 * ## No rails here
 *
 * This page renders none of the slots it describes. Ten empty boxes around a
 * page explaining that the boxes are empty is a joke at the reader's expense.
 */

export const metadata: Metadata = {
  title: "Sponsor RaceTo10",
  description:
    "Ten sponsor slots on the RaceTo10 home page. Not open yet, and nothing can be bought here today.",
};

export default function SponsorPage() {
  // Present only when the owner has configured an address. With none, the line
  // is absent rather than pointing at a mailbox nobody reads.
  const contact = env.NEXT_PUBLIC_CONTACT_EMAIL;

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-medium">Sponsor RaceTo10</h1>

        <div className="mt-8">
          <NotOpenYet title="Sponsorship isn't open yet.">
            <p>
              Nothing can be bought here today. Slots will open once races are
              running and the numbers are real.
            </p>
            <p>
              Ten slots, five on each side of the home page, shown to everyone
              watching the race.
            </p>
            {contact ? (
              <p>
                <a
                  href={`mailto:${contact}`}
                  className="text-text underline-offset-4 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  Email us to be told when slots open.
                </a>
              </p>
            ) : null}
          </NotOpenYet>
        </div>

        <div className="mt-8">
          <TextLink href="/">Back to the race</TextLink>
        </div>
      </main>

      <Footer />
    </>
  );
}
