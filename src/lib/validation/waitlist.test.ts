import assert from "node:assert/strict";
import { test } from "node:test";

import { waitlistSchema } from "./waitlist.ts";

/**
 * Waitlist input rules. Server-side is the boundary; the form mirrors these for
 * helpfulness only.
 */

test("accepts a well-formed submission and normalises the email", () => {
  const parsed = waitlistSchema.safeParse({
    email: "  Ada@Example.COM  ",
    customersNow: "1-5",
  });

  assert.equal(parsed.success, true);
  // Stored lowercase and trimmed, so the unique constraint catches duplicate
  // signups regardless of how someone capitalised their address.
  assert.equal(parsed.success && parsed.data.email, "ada@example.com");
});

test("accepts every band the database enum allows", () => {
  for (const band of ["0", "1-5", "6+"]) {
    const parsed = waitlistSchema.safeParse({ email: "a@b.co", customersNow: band });
    assert.equal(parsed.success, true, `band ${band} should be accepted`);
  }
});

test("rejects a band the enum does not allow", () => {
  // A value outside the enum would be rejected by the database anyway, but
  // failing here produces a message the visitor can act on.
  const parsed = waitlistSchema.safeParse({ email: "a@b.co", customersNow: "50" });
  assert.equal(parsed.success, false);
});

test("rejects a missing qualifying answer", () => {
  const parsed = waitlistSchema.safeParse({ email: "a@b.co" });
  assert.equal(parsed.success, false);
});

test("rejects malformed and non-string emails", () => {
  for (const email of ["", "not-an-email", "a@b", "@example.com", "a b@example.com"]) {
    const parsed = waitlistSchema.safeParse({ email, customersNow: "0" });
    assert.equal(parsed.success, false, `${email} should be rejected`);
  }
});

test("rejects a File submitted in the email field", () => {
  // FormData.get returns File for file inputs. Without this, a crafted
  // multipart post would reach the database layer as a non-string.
  const parsed = waitlistSchema.safeParse({
    email: new File(["x"], "x.txt"),
    customersNow: "0",
  });
  assert.equal(parsed.success, false);
});
