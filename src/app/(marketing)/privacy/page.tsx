import type { Metadata } from "next";

import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { env } from "@/lib/env";

/**
 * `/privacy`.
 *
 * ## Scope, and why it is this short
 *
 * It describes only what the product does today: a waitlist address, the profile
 * a sign-in fills in, what becomes public once a founder consents, and how to
 * ask for deletion. Nothing here is aspirational. A privacy page that describes
 * a key vault before the vault exists is the kind of copy this product cannot
 * afford, and it would be read as a promise. The paragraph about provider keys
 * is added when there is a vault to describe.
 *
 * ## Why the public row is listed twice
 *
 * Once here, and once beside the consent checkbox. That is not redundancy: the
 * checkbox is the agreement and has to stand alone, and this page is what
 * somebody reads when they want the whole picture rather than the part that fits
 * next to a tick box.
 */

export const metadata: Metadata = {
  title: "Privacy",
  description: "What RaceTo10 collects, what becomes public, and how to have it removed.",
};

export default function PrivacyPage() {
  const contact = env.NEXT_PUBLIC_CONTACT_EMAIL;

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-medium">Privacy</h1>
        <p className="mt-3 max-w-2xl text-small text-text-muted prose">
          What this site collects, and what it does with it. There is no
          analytics, no advertising and no tracking on any page.
        </p>

        <div className="mt-10 flex max-w-2xl flex-col gap-10">
          <section>
            <h2 className="text-medium">The waitlist</h2>
            <p className="mt-3 text-small text-text-muted prose">
              If you leave your email on the home page, we store that address and
              the answer you gave about how many paying customers you have. It is
              used for one thing: writing to you when the next race opens. It is
              never shown on the site, never sold, and never used for anything
              else.
            </p>
          </section>

          <section>
            <h2 className="text-medium">Signing in</h2>
            <p className="mt-3 text-small text-text-muted prose">
              Signing in with Google or X gives us your account&apos;s identifier,
              your display name, your avatar, and an email address if the
              provider supplies one. X sign-ins also give us your handle, which
              is what proves you own it. Your email address is never shown
              publicly and is only used to reach you about your race.
            </p>
          </section>

          <section>
            <h2 className="text-medium">What becomes public</h2>
            <p className="mt-3 text-small text-text-muted prose">
              Nothing is public until you tick the consent box on the join page.
              Once you do, the board shows your product name, your display name,
              your X handle if you signed in with X, an approximate location, and
              your verified customer count.
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              The location is not typed in and is not your address. It comes from
              the connection your browser made when you signed up, resolved to a
              city, and the coordinates are rounded to one decimal place before
              they are stored.
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              Your email address, your account identifiers and the details of any
              payment provider you connect are never public.
            </p>
          </section>

          <section>
            <h2 className="text-medium">The key you connect</h2>
            <p className="mt-3 text-small text-text-muted prose">
              We verify your customer count by reading your Stripe account. To
              do that you create a restricted key in Stripe and paste it here.
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              It must be a restricted key, and we refuse anything else. We ask
              for Read on Customers, Charges, Subscriptions, Invoices and
              PaymentIntents and nothing more, and we refuse a key that can
              write. RaceTo10 never charges anyone, never changes anything in
              your account, and never needs to.
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              The key is encrypted before it is stored, and it is never shown
              again after you paste it. It is deleted when your race ends, and
              when you disconnect. Nobody at RaceTo10 can read it back out.
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              While your race is running, we read your account on a schedule to
              count paying customers. Nothing about those customers is stored
              except an identifier we use to avoid counting the same one twice,
              which is never shown to anyone. Your customers are never named on
              this site, and no amounts are ever published.
            </p>
          </section>

          <section>
            <h2 className="text-medium">Deleting it</h2>
            <p className="mt-3 text-small text-text-muted prose">
              Ask, and we will remove your waitlist entry, your profile and your
              race.{" "}
              {contact ? (
                <a
                  href={`mailto:${contact}`}
                  className="text-text underline underline-offset-4"
                >
                  Email us at {contact}.
                </a>
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
