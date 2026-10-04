import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { signOut } from "@/app/actions/auth";
import { ProfileForm } from "@/components/auth/profile-form";
import { SignInButtons } from "@/components/auth/sign-in";
import { ActivateForm } from "@/components/join/activate-form";
import { StripeConnectForm } from "@/components/join/stripe-connect-form";
import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";
import { Button } from "@/components/ui/button";
import { getJoinState } from "@/lib/queries/join-state";
import { describeDuration } from "@/lib/race/config";
import { describeIneligibility } from "@/lib/verification/eligibility.ts";

/**
 * `/join` — the entry flow, start to finish.
 *
 * ## Shape
 *
 * The stage is resolved server-side (`getJoinState`) and the stage body is a
 * renderer: one exhaustive switch, no branching on partial state. That is
 * deliberate. The stages are mutually exclusive, and a page that assembled
 * itself from three independent reads could show a combination that is not
 * real — "eligible" beside no connection.
 *
 * ## Why the body streams
 *
 * `getJoinState` reads the session, the profile, the connection and the race,
 * and none of that is needed to paint the page. Held in the page itself, every
 * one of those reads would sit in front of the first byte. Behind a `Suspense`
 * boundary the header, the heading and the footer are on screen immediately and
 * only the stage waits, which is the part that genuinely cannot be known
 * earlier.
 *
 * The fallback is honest about being a fallback. It shows the page's real
 * heading and says it is checking, rather than a grey box that could mean
 * anything.
 *
 * ## The states a founder can be in, and why each looks different
 *
 *   * **registered** — signed in, profile incomplete. Asked for the fields the
 *     provider did not supply, and nothing else.
 *   * **ready** — connected and verified at 0/$0. Shown the start control.
 *   * **racing** — the clock is running. Shown the window, the baseline and a
 *     link to the public board.
 *   * **ineligible** — the account has customers or revenue. Told which, and
 *     that it is a refusal rather than a failure.
 *   * **verification failure** — we could not read the account. Told that, and
 *     offered the fix, which is different from ineligible's.
 *
 * Distinguishing the last two matters more than it looks: telling someone with
 * a dead credential that they "already have customers" sends them to Stripe to
 * fix a business fact that is not wrong.
 */

export const metadata: Metadata = {
  title: "Join the race",
  description: "Enter RaceTo10 and race to your first 10 paying customers in public.",
};

/**
 * Reasons the callback can bounce someone back here.
 *
 * Mapped through a fixed list rather than rendered from the query string: the
 * parameter is user-controlled, and echoing it would let anyone put arbitrary
 * copy on this page by editing a URL.
 */
const PROBLEMS: Record<string, string> = {
  declined: "You cancelled at the sign-in screen. Nothing was shared.",
  provider: "That sign-in didn't complete. Nothing was shared. Try again.",
  "no-code": "That sign-in link was incomplete. Try again from the start.",
  profile: "We couldn't finish setting up your account. Try again in a moment.",
  link: "That account couldn't be linked. It may already be connected.",
};

/** Rendered on the server, so the format is fixed rather than locale-dependent. */
function formatEnd(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/** Whole days remaining, floored — never rounds a partial day up. */
function daysLeft(raceEndAt: Date, now: Date): number {
  return Math.max(0, Math.floor((raceEndAt.getTime() - now.getTime()) / 86_400_000));
}

/**
 * What is on screen while the stage is read.
 *
 * It carries the page's real heading and subline rather than a placeholder
 * shape, so the first paint is already the page a visitor came for. The line
 * underneath says what is happening, which is the one thing a spinner cannot.
 */
function JoinFallback() {
  return (
    <div>
      <h1 className="text-medium">Join the race</h1>
      <p className="mt-3 text-small text-text-muted prose">
        Start at 0 customers. Race to your first 10.
      </p>
      <p className="mt-8 text-small text-text-muted" role="status">
        Checking your account...
      </p>
    </div>
  );
}

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}) {
  // Reading the query string is not slow data, so it stays in the shell: the
  // message a failed sign-in carries has to be in the first paint, not streamed
  // in after it.
  const { problem } = await searchParams;

  return (
    <>
      <Nav />

      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-12">
        <Suspense fallback={<JoinFallback />}>
          <JoinStage problem={problem} />
        </Suspense>
      </main>

      <Footer />
    </>
  );
}

async function JoinStage({ problem }: { problem?: string }) {
  const { state, durationDays } = await getJoinState();

  // Phrased through the one helper, so "7" never reaches the page as a bare
  // number. `duration` is a count of days, not a sentence.
  const duration = describeDuration(durationDays);

  // Only a known reason renders. An unknown one is ignored rather than shown.
  const message = problem ? PROBLEMS[problem] : undefined;

  const now = new Date();

  return (
    <>
      <h1 className="text-medium">
        {state.stage === "racing" || state.stage === "finished"
          ? "Your race"
          : "Join the race"}
      </h1>

      {state.stage === "racing" || state.stage === "finished" ? null : (
        <p className="mt-3 text-small text-text-muted prose">
          Start at 0 customers. Race to your first 10.
        </p>
      )}

      {state.stage === "signed-out" || state.stage === "profile-incomplete" ? (
        <p className="mt-4 text-small text-text prose">
          To enter, your product must currently have 0 paying customers and $0
          MRR.
        </p>
      ) : null}

      {message ? (
        <p role="alert" className="mt-6 text-small text-text">
          {message}
        </p>
      ) : null}

      <div className="mt-8">
        {state.stage === "signed-out" ? <SignInButtons next="/join" /> : null}

        {state.stage === "profile-incomplete" ? (
          <ProfileForm profile={state.profile} />
        ) : null}

        {state.stage === "no-connection" ? (
          <>
            <p className="mb-6 text-small text-text-muted prose">
              Signed in as{" "}
              <span className="text-text">@{state.profile.x_handle}</span>. One
              step left: connect the account we verify your customer count
              from.
            </p>
            <StripeConnectForm />
          </>
        ) : null}

        {state.stage === "connection-unhealthy" ? (
          <>
            <div className="mb-6 rounded-card border border-border bg-surface p-6">
              <h2 className="text-medium">Your Stripe connection needs renewing</h2>
              <p className="mt-2 text-small text-text-muted prose">
                The key we were given no longer works. It may have been revoked
                or replaced in Stripe. Your race has not started, and nothing
                was changed in your account.
              </p>
            </div>
            <StripeConnectForm />
          </>
        ) : null}

        {state.stage === "unverified" ? (
          <>
            <div className="mb-6 rounded-card border border-border bg-surface p-6">
              <h2 className="text-medium">We couldn&apos;t verify your account</h2>
              <p className="mt-2 text-small text-text-muted prose">
                We weren&apos;t able to read your customer and subscription
                data. This is usually a key without the right read permissions,
                not a problem with your account.
              </p>
              <p className="mt-2 text-small text-text-muted prose">
                Your clock has not started.
              </p>
            </div>
            <StripeConnectForm />
          </>
        ) : null}

        {state.stage === "ineligible" ? (
          <div className="rounded-card border border-border bg-surface p-6">
            <h2 className="text-medium">This account can&apos;t enter</h2>
            <p className="mt-2 text-small text-text prose">
              {describeIneligibility(state.reason)}
            </p>
            <p className="mt-3 text-small text-text-muted prose">
              Your clock has not started and nothing was changed.
            </p>
          </div>
        ) : null}

        {state.stage === "eligible" ? <ActivateForm durationLabel={duration} /> : null}

        {(state.stage === "racing" || state.stage === "finished") && (
          <div className="rounded-card border border-border bg-surface p-6">
            <h2 className="text-medium">
              {state.stage === "finished"
                ? "You reached 10 customers"
                : "Your clock is running"}
            </h2>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-small">
              <dt className="text-text-muted">Started</dt>
              <dd className="text-text">{formatEnd(state.race.activatedAt)} UTC</dd>

              <dt className="text-text-muted">
                {state.stage === "finished" ? "Ended" : "Ends"}
              </dt>
              <dd className="text-text">
                {formatEnd(state.race.raceEndAt)} UTC
                {state.stage === "racing" ? (
                  <span className="text-text-muted">
                    {" "}
                    · {daysLeft(state.race.raceEndAt, now)} days left
                  </span>
                ) : null}
              </dd>

              <dt className="text-text-muted">Started from</dt>
              <dd className="text-text">
                {state.race.baselineCustomerCount} customers
              </dd>

              <dt className="text-text-muted">Verified now</dt>
              <dd className="text-text">
                {state.race.currentCustomerCount} of 10
                {state.race.countReconciledAt ? (
                  <span className="text-text-muted">
                    {" "}
                    · checked {formatEnd(state.race.countReconciledAt)} UTC
                  </span>
                ) : (
                  <span className="text-text-muted"> · not checked yet</span>
                )}
              </dd>
            </dl>

            {/* The count is polled, not live. Saying when it was last checked
                is the honest treatment: the whole premise is that the number
                is real, and a number with no timestamp implies a freshness
                that does not exist. */}
            <p className="mt-4 text-small text-text-muted prose">
              We re-check your Stripe account roughly every 30 minutes, so your
              count can be up to half an hour behind.
            </p>

            <div className="mt-6">
              <Link href="/leaderboard" className="text-small text-text underline">
                See the public board
              </Link>
            </div>

            {state.connection && state.connection.status !== "connected" ? (
              <p className="mt-4 text-small text-text prose">
                Your Stripe connection has stopped working, so your count is
                frozen at {state.race.currentCustomerCount}.{" "}
                <Link href="/join" className="underline">
                  Reconnect
                </Link>{" "}
                to resume counting.
              </p>
            ) : null}
          </div>
        )}

        {state.stage === "withdrawn" ? (
          <div className="rounded-card border border-border bg-surface p-6">
            <h2 className="text-medium">This entry is closed</h2>
            <p className="mt-2 text-small text-text-muted prose">
              This race was withdrawn or disqualified, so the clock is no
              longer running.
            </p>
          </div>
        ) : null}
      </div>

      {state.stage === "signed-out" ? null : (
        <div className="mt-6 flex items-center justify-between gap-4">
          {/* Every stage past `signed-out` carries a profile, and the handle
              is only absent while the founder is still supplying it. */}
          <p className="text-small text-text-muted">
            {state.profile.x_handle ? `Signed in as @${state.profile.x_handle}` : "Signed in"}
          </p>
          <form action={signOut}>
            <Button type="submit" variant="secondary">
              Sign out
            </Button>
          </form>
        </div>
      )}

      {/* The part that is still not built, stated plainly rather than faked. */}
      {state.stage === "eligible" ? (
        <section className="mt-12 border-t border-border pt-6">
          <h2 className="text-small text-text-muted">What happens when you start</h2>
          <p className="mt-3 text-small text-text-muted prose">
            Your clock starts the moment you press the button, and runs for{" "}
            {duration ?? "the configured window"}. Your customer count is
            verified against your Stripe account and shown publicly until you
            reach 10 or the window closes.
          </p>
        </section>
      ) : null}

      <section className="mt-12 border-t border-border pt-6">
        <h2 className="text-small text-text-muted">What becomes public</h2>
        <p className="mt-3 text-small text-text-muted prose">
          Your name, X handle, product name, approximate location and verified
          customer count. Nothing is shown until you have agreed to that. Your
          email and your provider details are never public.
        </p>
      </section>
    </>
  );
}
