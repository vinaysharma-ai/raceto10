"use client";

import { useActionState } from "react";

import { completeProfile, type ProfileState } from "@/app/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The fields OAuth could not supply.
 *
 * ## Only the missing ones are rendered
 *
 * `01` §7 orders `/join` as identity, then *only the fields the provider did not
 * supply*. Google returns a name and an address; X returns a handle and often no
 * address at all. Asking a founder to re-type something we already have is the
 * kind of form that makes people distrust the rest of the page.
 *
 * So each field is conditional on its column being null. When nothing is
 * missing, the caller does not render this at all.
 *
 * ## Why the labels say where each value goes
 *
 * The handle is the first column of the public leaderboard and the link on it;
 * the name is a display label; the email never leaves the database. A form that
 * collects something private-looking and publishes it is worth being suspicious
 * of, so each field says which it is before it is filled in rather than after.
 */

const INITIAL: ProfileState = { status: "idle" };

export type ProfileFormValues = {
  name: string | null;
  email: string | null;
  x_handle: string | null;
};

export function ProfileForm({ profile }: { profile: ProfileFormValues }) {
  const [state, formAction, pending] = useActionState(completeProfile, INITIAL);

  const needsName = !profile.name;
  const needsHandle = !profile.x_handle;
  const needsEmail = !profile.email;

  return (
    <form action={formAction} className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-medium">
        {needsHandle || needsEmail
          ? "Two things we still need"
          : "One thing we still need"}
      </h2>
      <p className="mt-2 max-w-lg text-small text-text-muted prose">
        Your provider didn&apos;t share{" "}
        {needsHandle && needsEmail
          ? "your X handle or an email address"
          : needsHandle
            ? "your X handle"
            : "an email address"}
        . We only ask for what we don&apos;t already have.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        {needsName ? (
          <div>
            <label htmlFor="name" className="text-small text-text-muted">
              Your name · shown on the board
            </label>
            <Input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Ada Lovelace"
              className="mt-2 max-w-sm"
            />
          </div>
        ) : null}

        {needsHandle ? (
          <div>
            <label htmlFor="xHandle" className="text-small text-text-muted">
              X handle · shown on the board
            </label>
            <Input
              id="xHandle"
              name="xHandle"
              type="text"
              required
              autoComplete="username"
              placeholder="@ada"
              className="mt-2 max-w-sm"
            />
            <p className="mt-2 text-small text-text-muted prose">
              This is how you appear on the leaderboard and how people find you.
            </p>
          </div>
        ) : null}

        {needsEmail ? (
          <div>
            <label htmlFor="email" className="text-small text-text-muted">
              Email · never public
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              className="mt-2 max-w-sm"
            />
            <p className="mt-2 text-small text-text-muted prose">
              Only so we can reach you. It never appears on the site.
            </p>
          </div>
        ) : null}
      </div>

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
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
