"use client";

import { useActionState } from "react";

import { completeProfile, type ProfileState } from "@/app/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRODUCT_NAME_MAX } from "@/lib/validation/profile";

/**
 * The profile step: what is being raced, who is racing it, and the consent.
 *
 * ## What is prefilled and what is asked for
 *
 * The name and the email arrive from the provider and are shown, not re-asked.
 * An email is only editable when the provider did not supply one, because a
 * founder who edits an address we already hold to something they cannot receive
 * mail at has broken the one channel the product uses to reach them.
 *
 * ## Why the X handle is gone from this form
 *
 * It used to be asked for here. But a typed handle is a claim, not a proof, and
 * the board links it to x.com — so anyone could have typed somebody else's and
 * the link would have been published under our name. It now comes only from an
 * X sign-in. A Google-only founder appears under their display name.
 *
 * ## The consent line is the public row, spelled out
 *
 * Not a link to a policy. The checkbox is the agreement, so the sentence next
 * to it lists the literal contents of what becomes public. The privacy page
 * has the longer version; this has the one that fits beside a tick box.
 */

const INITIAL: ProfileState = { status: "idle" };

export type ProfileFormValues = {
  name: string | null;
  email: string | null;
  x_handle: string | null;
};

export function ProfileForm({ profile }: { profile: ProfileFormValues }) {
  const [state, formAction, pending] = useActionState(completeProfile, INITIAL);

  const needsEmail = !profile.email;

  return (
    <form action={formAction} className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-medium">Tell us what you&apos;re racing</h2>

      <div className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="productName" className="text-small text-text-muted">
            Product name · shown on the board
          </label>
          <Input
            id="productName"
            name="productName"
            type="text"
            required
            minLength={2}
            maxLength={PRODUCT_NAME_MAX}
            autoComplete="off"
            placeholder="Ledgerly"
            className="max-w-sm"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="name" className="text-small text-text-muted">
            Your name · shown on the board
          </label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            defaultValue={profile.name ?? ""}
            placeholder="Ada Lovelace"
            className="max-w-sm"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-small text-text-muted">
            Email · never public
          </label>
          {needsEmail ? (
            <>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                className="max-w-sm"
              />
              <p className="text-small text-text-muted prose">
                Your provider didn&apos;t share one. It is only so we can reach
                you, and it never appears on the site.
              </p>
            </>
          ) : (
            <>
              <input type="hidden" name="email" value={profile.email ?? ""} />
              <p className="text-small text-text" id="email">
                {profile.email}
              </p>
              <p className="text-small text-text-muted prose">
                From your provider, and never public. It is only so we can reach
                you.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Required, and labelled with the actual list rather than "I agree to the
          terms". This is the consent `public_consent_at` records, every public
          view filters on it, and the location below is stored only because of
          it — so what the founder is agreeing to should be the literal contents
          of their public row, not a link to a policy. */}
      <label className="mt-6 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="consent"
          value="yes"
          required
          className="mt-0.5 h-4 w-4 shrink-0 accent-text"
        />
        <span className="text-small text-text-muted prose">
          Race in public. The board will show my product name, display name,
          verified X handle if I signed in with X, approximate location and my
          verified customer count. My email and my Stripe details are never
          shown.
        </span>
      </label>

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
          {pending ? "Saving..." : "Save and continue"}
        </Button>
      </div>
    </form>
  );
}
