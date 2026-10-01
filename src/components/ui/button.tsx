import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";

type Variant = "primary" | "secondary";

/**
 * Buttons.
 *
 * `primary` is white on black — the single highest-contrast element in the
 * product now that the accent colour is gone. It was orange before, which made
 * it compete with the sponsor cards and the logo arc for attention; white is
 * louder and quieter at the same time, because there is only ever one of them
 * on a screen.
 *
 * `ghost` is for the secondary actions that used to be accent-coloured text
 * links (`Take a position`, `Be the first`). They are now underlined-on-hover
 * white, so they read as text rather than as a second button.
 *
 * No shadows, no gradients, no glow. Focus is a colour change plus an outline
 * that only appears for keyboard users.
 */
const BASE =
  "inline-flex h-9 items-center justify-center rounded-pill px-4 text-small transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text " +
  "disabled:pointer-events-none disabled:opacity-40";

const VARIANT: Record<Variant, string> = {
  primary: "bg-text text-bg hover:bg-text/90",
  secondary: "border border-border bg-transparent text-text hover:border-text",
};

export function buttonClasses(variant: Variant = "primary", className?: string) {
  return [BASE, VARIANT[variant], className].filter(Boolean).join(" ");
}

type ButtonProps = ComponentPropsWithoutRef<"button"> & { variant?: Variant };

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return <button className={buttonClasses(variant, className)} {...props} />;
}

type ButtonLinkProps = ComponentPropsWithoutRef<typeof Link> & {
  variant?: Variant;
};

export function ButtonLink({ variant = "primary", className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, className)} {...props} />;
}

/**
 * A text link, for the places that used to be accent-coloured.
 *
 * Kept here rather than inlined at each call site so the hover treatment is one
 * decision: `text-muted` at rest, full white on hover, underline on hover only.
 * A permanently underlined quiet link reads as a footnote; this reads as an
 * action without becoming a third button style.
 */
export function TextLink({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Link>) {
  return (
    <Link
      className={[
        "text-small text-text-muted underline-offset-4 transition-colors",
        "hover:text-text hover:underline focus-visible:text-text focus-visible:outline-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
