"use client";

import { useActionState } from "react";

import { connectStripe, type ProviderState } from "@/app/actions/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Connecting a Stripe account.
 *
 * ## Handling of the key, in the browser
 *
 * `type="password"` so a pasted key is not left legible on screen for anyone
 * walking past, and `autoComplete="off"` so a password manager does not offer
 * to save it. The field is uncontrolled, so React never holds the value in
 * state and it is not part of any re-render — after a successful connect the
 * component re-renders without it, because nothing here ever had it.
 *
 * The form posts to a Server Action, so the key goes to the server and nowhere
 * else: it is never in a URL, never in client state, and never in a query.
 *
 * ## Why the instructions are this explicit
 *
 * `00` §49 chose a pasted restricted key because a Connect platform account is
 * not available to us. That makes the racer responsible for scoping the key,
 * which means the page has to say exactly what to grant — a racer who grants
 * write access has handed over far more than they intended, and we refuse those.
 */

const INITIAL: ProviderState = { status: "idle" };

export function StripeConnectForm() {
  const [state, formAction, pending] = useActionState(connectStripe, INITIAL);

  return (
    <div className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-medium">Connect Stripe</h2>
      <p className="mt-2 max-w-lg text-small text-text-muted prose">
        We verify your customer count by reading your Stripe account directly.
        Create a key that can only read, and we can never charge anyone or change
        anything.
      </p>

      <ol className="mt-4 flex flex-col gap-1 text-small text-text-muted prose">
        <li>
          1. Open{" "}
          <a
            href="https://dashboard.stripe.com/apikeys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text underline underline-offset-4"
          >
            dashboard.stripe.com/apikeys
          </a>
          .
        </li>
        <li>
          2. Create a <span className="text-text">restricted key</span>.
        </li>
        <li>
          3. Give it <span className="text-text">Read</span> on Customers,
          Charges, Subscriptions, Invoices and PaymentIntents, and nothing else.
        </li>
        <li>4. Create it and paste it below.</li>
      </ol>

      <form action={formAction} className="mt-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="apiKey" className="text-small text-text-muted">
            Restricted key · never shown again
          </label>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="rk_live_…"
            className="max-w-md font-mono"
          />
        </div>

        <p className="mt-2 max-w-lg text-small text-text-muted prose">
          We only read. Your key is encrypted, never shown again, and deleted
          when your race ends.
        </p>

        {/* Named so nobody spends time looking for it. A founder who came here
            expecting to choose a processor should be told the choice does not
            exist yet rather than left to wonder. */}
        <p className="mt-1 text-small text-text-muted prose">
          Lemon Squeezy: coming soon.
        </p>

        {state.status === "error" ? (
          <p className="mt-4 text-small text-text" role="alert">
            {state.message}
          </p>
        ) : null}

        {state.status === "ok" ? (
          <p className="mt-4 text-small text-text" role="status">
            {state.message}
          </p>
        ) : null}

        <div className="mt-6">
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Connect"}
          </Button>
        </div>
      </form>
    </div>
  );
}
