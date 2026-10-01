import type { ComponentPropsWithoutRef } from "react";

/**
 * Inputs.
 *
 * Monospace, like everything else, because every field in this product holds
 * something a founder types about themselves — a handle, a product name, an
 * email — and those are exactly the strings that read better in a fixed-width
 * face.
 *
 * Focus is a border that goes to full white. Errors are the same border, since
 * there is no second colour to reach for; the message underneath carries the
 * meaning, and `aria-invalid` carries it to assistive tech.
 */
const INPUT =
  "h-10 w-full rounded-sm border border-border bg-bg px-3 text-small text-text " +
  "placeholder:text-text-muted/70 focus:border-text focus:outline-none " +
  "aria-invalid:border-text disabled:opacity-40";

export function Input({ className, ...props }: ComponentPropsWithoutRef<"input">) {
  return <input className={[INPUT, className].filter(Boolean).join(" ")} {...props} />;
}
