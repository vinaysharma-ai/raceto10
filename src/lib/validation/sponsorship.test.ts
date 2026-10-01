import assert from "node:assert/strict";
import { test } from "node:test";

import { SPONSOR_DESCRIPTION_MAX, SPONSOR_NAME_MAX, SPONSOR_TERMS } from "../sponsors/limits.ts";
import { sponsorshipHoldSchema } from "./sponsorship.ts";

/**
 * Validation for buying a position.
 *
 * The form mirrors these rules, but the server is the boundary — so every rule
 * is checked here against the schema the Server Action actually runs.
 */

/** What `formData.get()` hands over: strings, always. */
function form(overrides: Record<string, unknown> = {}) {
  return {
    slotNumber: "4",
    termDays: "3",
    sponsorName: "Ada's Bakery",
    sponsorDescription: "Sourdough, baked Thursdays",
    sponsorLink: "https://example.com",
    ...overrides,
  };
}

const messageFor = (input: unknown) => {
  const parsed = sponsorshipHoldSchema.safeParse(input);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
};

test("a well-formed request passes", () => {
  const parsed = sponsorshipHoldSchema.safeParse(form());
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.slotNumber, 4);
  assert.equal(parsed.success && parsed.data.termDays, 3);
});

test("values arrive as strings and are coerced", () => {
  // `formData.get()` never returns a number, so the schema has to coerce — and
  // coercing is exactly where a `"4abc"` would sneak through if it didn't.
  const parsed = sponsorshipHoldSchema.safeParse(form({ slotNumber: "10", termDays: "1" }));
  assert.equal(parsed.success && parsed.data.slotNumber, 10);
  assert.equal(parsed.success && parsed.data.termDays, 1);
});

test("only the three real terms are accepted", () => {
  for (const termDays of SPONSOR_TERMS) {
    assert.equal(
      sponsorshipHoldSchema.safeParse(form({ termDays: String(termDays) })).success,
      true,
      `${termDays} should be allowed`,
    );
  }

  for (const termDays of ["0", "2", "14", "30", "-1", "1.5", "seven", ""]) {
    assert.equal(
      sponsorshipHoldSchema.safeParse(form({ termDays })).success,
      false,
      `${termDays} should be refused`,
    );
  }
});

test("only positions 1 to 10 exist", () => {
  for (const slotNumber of ["0", "11", "99", "-1", "1.5", "", "four"]) {
    assert.equal(
      sponsorshipHoldSchema.safeParse(form({ slotNumber })).success,
      false,
      `${slotNumber} should be refused`,
    );
  }
});

test("the description is capped at 60 characters, in the schema and in the database", () => {
  assert.equal(
    sponsorshipHoldSchema.safeParse(
      form({ sponsorDescription: "x".repeat(SPONSOR_DESCRIPTION_MAX) }),
    ).success,
    true,
  );

  const tooLong = messageFor(
    form({ sponsorDescription: "x".repeat(SPONSOR_DESCRIPTION_MAX + 1) }),
  );
  assert.ok(tooLong?.includes(String(SPONSOR_DESCRIPTION_MAX)), "the message states the cap");
});

test("the name is capped too, so a card cannot be overrun", () => {
  assert.equal(
    sponsorshipHoldSchema.safeParse(form({ sponsorName: "x".repeat(SPONSOR_NAME_MAX) }))
      .success,
    true,
  );
  assert.notEqual(
    messageFor(form({ sponsorName: "x".repeat(SPONSOR_NAME_MAX + 1) })),
    null,
  );
});

test("blank names and descriptions are refused rather than trimmed to nothing", () => {
  assert.notEqual(messageFor(form({ sponsorName: "   " })), null);
  assert.notEqual(messageFor(form({ sponsorDescription: "   " })), null);
  assert.notEqual(messageFor(form({ sponsorName: "" })), null);
  assert.equal(sponsorshipHoldSchema.safeParse(form({ sponsorName: "  Ada  " })).success, true);
});

// ---------------------------------------------------------------------------
// The destination link
//
// Rendered into an `href` on a public page. A `javascript:` value executes in
// our origin for every visitor who clicks the card.
// ---------------------------------------------------------------------------

test("http and https destinations are accepted", () => {
  for (const link of ["https://example.com", "http://example.com/path?a=1"]) {
    assert.equal(
      sponsorshipHoldSchema.safeParse(form({ sponsorLink: link })).success,
      true,
      `${link} should be accepted`,
    );
  }
});

test("dangerous schemes and relative links are refused", () => {
  for (const link of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "jav\tascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com",
    "/sponsor",
    "example.com",
    "",
  ]) {
    assert.equal(
      sponsorshipHoldSchema.safeParse(form({ sponsorLink: link })).success,
      false,
      `${JSON.stringify(link)} should be refused`,
    );
  }
});

test("the message for a bad link tells the sponsor what to do", () => {
  const message = messageFor(form({ sponsorLink: "example.com" }));
  assert.ok(message?.includes("https://"), "the message names the fix");
  assert.ok(
    !message?.toLowerCase().includes("zod") && !message?.includes("invalid_string"),
    "the sponsor never sees a validator error",
  );
});

test("a missing field is an error, not a crash", () => {
  for (const field of [
    "slotNumber",
    "termDays",
    "sponsorName",
    "sponsorDescription",
    "sponsorLink",
  ]) {
    assert.notEqual(messageFor(form({ [field]: undefined })), null, `${field} is required`);
  }
});
