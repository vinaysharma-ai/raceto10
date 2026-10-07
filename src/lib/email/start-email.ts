/**
 * The email that tells a founder their clock has started.
 *
 * ## Why the sender is an argument
 *
 * `sendStartEmail` takes the thing that actually posts to the provider as a
 * parameter. That is the whole testability story: a test passes a stub and
 * asserts what was composed and what was returned, with no network and no key.
 * The production wiring is one function at the bottom of this file.
 *
 * ## Why nothing here can fail an activation
 *
 * The race has already started by the time this runs — `beginActivation` has
 * committed. So every outcome is a value rather than a throw, and the caller
 * turns it into a counter. An outage at the mail provider is not a reason to
 * report a failed activation for a clock that is running.
 *
 * Skipped and failed are separate outcomes. Skipped means no provider is
 * configured, which is a deployment state somebody chose; failed means one is
 * configured and it did not work. They leave `email_sent_at` null in exactly the
 * same way, and they read differently in a log.
 */

/** The parts of the message a provider needs. */
export type StartEmailMessage = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
};

export type SendOutcome =
  | { status: "sent" }
  /** No `RESEND_API_KEY` or no `EMAIL_FROM`. Not an error. */
  | { status: "skipped" }
  /** Configured, and it did not work. */
  | { status: "failed"; reason: string };

export type SendDeps = {
  /** Posts the message. The only thing that touches the network. */
  post(message: StartEmailMessage, apiKey: string): Promise<SendOutcome>;
  env: Record<string, string | undefined>;
  now?: Date;
};

export type StartEmailInput = {
  to: string | null;
  productName: string | null;
  daysLeft: number | null;
  publicUrl: string | null;
};

/**
 * Whether a provider is configured at all.
 *
 * Both variables, or neither is any use: a key with no From address cannot send,
 * and a From address with no key cannot either. Requiring both here means the
 * "skipped" decision is made in one place rather than at each call site.
 */
export function emailConfigured(env: Record<string, string | undefined>): boolean {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  return Boolean(key && from);
}

/**
 * The subject and body.
 *
 * Plain text and HTML, both written out. The HTML is small and hand-written
 * rather than generated, because a template engine for five lines is a
 * dependency and a rendering step between a founder and a sentence.
 *
 * No tracking pixel, no open counter, no click wrapper. This is the only email
 * the product sends, and it is one a person asked for by joining a race.
 */
export function composeStartEmail(
  input: StartEmailInput,
  from: string,
): StartEmailMessage | null {
  // No address means nothing to send to. X sign-ins often carry none, and the
  // profile step asks for one — so a racer without one has not finished
  // registering, and there is nothing to apologise for.
  if (!input.to) return null;

  const product = input.productName ?? "your product";
  const window =
    input.daysLeft === null ? "your race" : `${input.daysLeft} day${input.daysLeft === 1 ? "" : "s"}`;

  const subject = "Your race has started";
  const link = input.publicUrl;

  const lines = [
    `${product} is racing.`,
    ``,
    `Your clock started, and you have ${window} to reach 10 paying customers. Your count is at 0 of 10.`,
    ``,
    link ? `Your public page: ${link}` : null,
    ``,
    `You're receiving this because you joined a race on raceto10.lol.`,
  ].filter((line): line is string => line !== null);

  const text = lines.join("\n");

  const html = [
    `<p>${escapeHtml(product)} is racing.</p>`,
    `<p>Your clock started, and you have ${escapeHtml(window)} to reach 10 paying customers. Your count is at 0 of 10.</p>`,
    link
      ? `<p><a href="${escapeHtml(link)}">Your public page</a></p>`
      : "",
    `<p>You're receiving this because you joined a race on raceto10.lol.</p>`,
  ].join("\n");

  return { to: input.to, from, subject, html, text };
}

/** Product names and URLs are founder-supplied, so they are escaped into the HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Composes and sends, returning an outcome and never throwing.
 *
 * The order matters: the configuration is checked before anything is composed,
 * so a deployment with no provider does no work and logs one line rather than
 * building a message it cannot deliver.
 */
export async function sendStartEmail(
  deps: SendDeps,
  input: StartEmailInput,
): Promise<SendOutcome> {
  const key = deps.env.RESEND_API_KEY?.trim();
  const from = deps.env.EMAIL_FROM?.trim();

  if (!key || !from) {
    // One line, and the exact words the owner asked for. Not an error and not a
    // warning: nothing is wrong, there is simply no provider.
    console.log("email skipped");
    return { status: "skipped" };
  }

  const message = composeStartEmail(input, from);
  if (!message) return { status: "skipped" };

  try {
    return await deps.post(message, key);
  } catch (error) {
    // The category, never the provider's response body — which echoes the
    // recipient address back in its errors.
    return { status: "failed", reason: (error as Error).name || "request_failed" };
  }
}

/**
 * The real sender.
 *
 * A plain `POST` rather than the `resend` package: the API is one request with
 * one header, and a dependency whose whole surface is `fetch` is a dependency
 * that can be updated out from under a working product.
 */
export async function postToResend(
  message: StartEmailMessage,
  apiKey: string,
): Promise<SendOutcome> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // The status only. Resend's error body quotes the recipient address and
    // sometimes the From header, and neither belongs in a log line.
    return { status: "failed", reason: `http_${response.status}` };
  }

  return { status: "sent" };
}
