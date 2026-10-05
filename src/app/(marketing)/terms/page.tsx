import type { Metadata } from "next";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { env } from "@/lib/env";

/**
 * `/terms`.
 *
 * ## What this is, and what it is not
 *
 * Short, plain, and limited to what the product actually is: a public board
 * where founders' customer counts are shown. There is no prize, no fee and no
 * contract being sold here, so the terms are correspondingly small. Claims about
 * payments, sponsorship or prize money are absent because none of those exist
 * yet.
 *
 * ## The one term that matters
 *
 * Eligibility. A race only means something if everybody in it started from zero,
 * so entering an account that already has customers is the thing this document
 * is really about. It is stated first for that reason.
 */

export const metadata: Metadata = {
  title: "Terms",
  description: "The rules for entering a RaceTo10 race.",
};

export default function TermsPage() {
  const contact = env.NEXT_PUBLIC_CONTACT_EMAIL;

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-medium">Terms</h1>
        <p className="mt-3 max-w-2xl text-small text-text-muted prose">
          The rules for entering a race on RaceTo10. Using the site does not
          commit you to anything; entering a race does.
        </p>

        <div className="mt-10 flex max-w-2xl flex-col gap-10">
          <section>
            <h2 className="text-medium">Eligibility</h2>
            <p className="mt-3 text-small text-text-muted prose">
              To enter, the product you are racing must have no paying customers
              and no recurring revenue at the moment you enter. We check this
              against your payment provider&apos;s record, and an account that
              does not qualify is refused.
            </p>
          </section>

          <section>
            <h2 className="text-medium">Racing in public</h2>
            <p className="mt-3 text-small text-text-muted prose">
              Entering means agreeing that your product name, display name, X
              handle if you signed in with X, approximate location and verified
              customer count are shown publicly. You can ask for your entry to be
              removed at any time, and it comes off the board.
            </p>
          </section>

          <section>
            <h2 className="text-medium">The count</h2>
            <p className="mt-3 text-small text-text-muted prose">
              Your customer count is read from your payment provider, not
              reported by you, and it refreshes on a schedule rather than
              instantly. A race is finished when the count reaches ten. A race
              whose window closes first ends there, and the board says so.
            </p>
          </section>

          <section>
            <h2 className="text-medium">Fair use</h2>
            <p className="mt-3 text-small text-text-muted prose">
              One entry per person. An entry whose count is not real, or which
              was entered on an account that did not qualify, is removed. We can
              close an entry that breaks these rules, and we will say when we
              have.
            </p>
          </section>

          <section>
            <h2 className="text-medium">No prize</h2>
            <p className="mt-3 text-small text-text-muted prose">
              A race is a public commitment, not a competition with a payout.
              There is no fee to enter and nothing to win except the evidence.
            </p>
          </section>

          <section>
            <h2 className="text-medium">Contact</h2>
            <p className="mt-3 text-small text-text-muted prose">
              {contact ? (
                <>
                  Questions about these terms:{" "}
                  <a
                    href={`mailto:${contact}`}
                    className="text-text underline underline-offset-4"
                  >
                    {contact}
                  </a>
                  .
                </>
              ) : (
                "There is no contact address configured on this deployment."
              )}
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </>
  );
}
