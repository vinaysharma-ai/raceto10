import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeStartEmail,
  emailConfigured,
  sendStartEmail,
  type SendOutcome,
  type StartEmailMessage,
} from "./start-email.ts";

/**
 * The start email, with a stub in place of the provider.
 *
 * Nothing here reaches the network, and nothing can: `sendStartEmail` takes the
 * posting function as an argument, so the real one is never in the import graph
 * of a test. The properties worth being thorough about are that a missing
 * configuration is a *skip* rather than a failure — activation must not be
 * affected by a deployment that has no mail provider — and that the composed
 * message escapes founder-supplied text.
 */

/** A sender that records what it was asked to send and returns what it is told to. */
function stub(outcome: SendOutcome = { status: "sent" }) {
  const sent: StartEmailMessage[] = [];
  const keys: string[] = [];

  return {
    sent,
    keys,
    post: async (message: StartEmailMessage, apiKey: string) => {
      sent.push(message);
      keys.push(apiKey);
      return outcome;
    },
  };
}

const CONFIGURED = { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "races@raceto10.lol" };

const input = {
  to: "ada@example.com",
  productName: "Ledgerly",
  daysLeft: 7,
  publicUrl: "https://www.raceto10.lol/r/ada",
};

// ---------------------------------------------------------------------------
// Is a provider configured?
// ---------------------------------------------------------------------------

test("both variables are required, and either alone is not enough", () => {
  assert.equal(emailConfigured(CONFIGURED), true);

  // A key with no From address cannot send, and a From with no key cannot
  // either. Requiring both here is what makes "skipped" one decision in one
  // place rather than a check at each call site.
  assert.equal(emailConfigured({ RESEND_API_KEY: "re_x" }), false);
  assert.equal(emailConfigured({ EMAIL_FROM: "a@b.c" }), false);
  assert.equal(emailConfigured({}), false);
});

test("a blank value is not a configuration", () => {
  // A half-filled environment is the likeliest way this goes wrong, and an
  // empty string reaching Resend produces an opaque 401 rather than a skip.
  assert.equal(emailConfigured({ RESEND_API_KEY: "   ", EMAIL_FROM: "a@b.c" }), false);
  assert.equal(emailConfigured({ RESEND_API_KEY: "re_x", EMAIL_FROM: "" }), false);
});

// ---------------------------------------------------------------------------
// Skipping, which must never look like failing
// ---------------------------------------------------------------------------

test("no configuration skips without attempting a send", async () => {
  const sender = stub();

  const outcome = await sendStartEmail({ post: sender.post, env: {} }, input);

  assert.equal(outcome.status, "skipped");
  assert.equal(sender.sent.length, 0, "a send was attempted with no provider configured");
});

test("a half configuration skips too", async () => {
  for (const env of [{ RESEND_API_KEY: "re_x" }, { EMAIL_FROM: "a@b.c" }]) {
    const sender = stub();
    const outcome = await sendStartEmail({ post: sender.post, env }, input);

    assert.equal(outcome.status, "skipped", JSON.stringify(env));
    assert.equal(sender.sent.length, 0);
  }
});

test("a racer with no address is skipped, not failed", async () => {
  // X sign-ins often carry no email, and the profile step is what asks for one.
  // Treating this as a failure would report a broken send for somebody who has
  // not finished registering.
  const sender = stub();

  const outcome = await sendStartEmail(
    { post: sender.post, env: CONFIGURED },
    { ...input, to: null },
  );

  assert.equal(outcome.status, "skipped");
  assert.equal(sender.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test("a configured send posts once, to the racer, from EMAIL_FROM", async () => {
  const sender = stub();

  const outcome = await sendStartEmail({ post: sender.post, env: CONFIGURED }, input);

  assert.equal(outcome.status, "sent");
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].to, "ada@example.com");
  assert.equal(sender.sent[0].from, "races@raceto10.lol");
  assert.equal(sender.keys[0], "re_test_key");
});

test("the subject is the one the spec names", () => {
  const message = composeStartEmail(input, "races@raceto10.lol");

  assert.equal(message?.subject, "Your race has started");
});

test("the body carries the product, the window, the count and the link", () => {
  const message = composeStartEmail(input, "races@raceto10.lol");
  assert.ok(message);

  assert.match(message.text, /Ledgerly/);
  assert.match(message.text, /7 days/);
  assert.match(message.text, /0 of 10/);
  assert.match(message.text, /https:\/\/www\.raceto10\.lol\/r\/ada/);
  assert.match(message.text, /joined a race on raceto10\.lol/);
});

test("a one-day window is singular", () => {
  const message = composeStartEmail({ ...input, daysLeft: 1 }, "a@b.c");
  assert.match(message?.text ?? "", /1 day to reach/);
});

test("an unknown window does not print a number", () => {
  // `daysLeft` is null when the end of the race could not be read. "null days"
  // would be the string a founder reads.
  const message = composeStartEmail({ ...input, daysLeft: null }, "a@b.c");

  assert.doesNotMatch(message?.text ?? "", /null/);
  assert.match(message?.text ?? "", /your race/);
});

test("a failed send is reported as failed, with a category and no address", async () => {
  const sender = stub({ status: "failed", reason: "http_401" });

  const outcome = await sendStartEmail({ post: sender.post, env: CONFIGURED }, input);

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.reason, "http_401");
    assert.equal(outcome.reason.includes("@"), false);
  }
});

test("a sender that throws becomes a failed outcome, not an exception", async () => {
  // Activation has already committed by the time this runs. A throw here would
  // propagate into a batch that has a running clock to report.
  const outcome = await sendStartEmail(
    {
      post: async () => {
        throw new TypeError("socket hang up");
      },
      env: CONFIGURED,
    },
    input,
  );

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.equal(outcome.reason, "TypeError");
});

// ---------------------------------------------------------------------------
// What goes into the HTML
// ---------------------------------------------------------------------------

test("a founder-supplied product name is escaped into the HTML", () => {
  // The HTML is the one place founder text becomes markup. A product genuinely
  // called `<script>` is unlikely; a product whose name contains an ampersand is
  // not, and the same escaping covers both.
  const message = composeStartEmail(
    { ...input, productName: '<img src=x onerror="alert(1)">' },
    "a@b.c",
  );

  assert.ok(message);
  assert.equal(message.html.includes("<img"), false);
  assert.match(message.html, /&lt;img/);
  // The plain-text part is not markup, so it keeps the name as typed.
  assert.match(message.text, /<img src=x/);
});
