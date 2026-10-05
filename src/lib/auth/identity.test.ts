import assert from "node:assert/strict";
import { test } from "node:test";

import { missingProfileFields, profileFromUser, safeRedirectPath } from "./identity.ts";

/**
 * Deriving a profile from an authenticated user.
 *
 * The tests that matter here are the ones about what is NOT taken: an email
 * from a token payload is a claim, not a proof, and treating it as one is how
 * account takeover starts.
 */

const google = {
  provider: "google",
  identity_data: {
    email: "ada@example.com",
    email_verified: true,
    full_name: "Ada Lovelace",
    avatar_url: "https://lh3.googleusercontent.com/a/ada",
  },
};

const xAccount = {
  provider: "x",
  identity_data: {
    user_name: "ada",
    preferred_username: "ada",
    full_name: "Ada Lovelace",
    picture: "https://pbs.twimg.com/ada.jpg",
  },
};

test("a Google user yields a name, an address and an avatar", () => {
  const draft = profileFromUser({
    email: "ada@example.com",
    identities: [google],
  });

  assert.equal(draft.name, "Ada Lovelace");
  assert.equal(draft.email, "ada@example.com");
  assert.equal(draft.avatarUrl, "https://lh3.googleusercontent.com/a/ada");
  assert.equal(draft.xHandle, null);
});

test("an X user yields their handle", () => {
  const draft = profileFromUser({ email: "ada@example.com", identities: [xAccount] });

  assert.equal(draft.xHandle, "ada");
  assert.equal(draft.name, "Ada Lovelace");
});

test("X omitting the email yields no email, rather than a guess", () => {
  // The common case. `01` §7 says to ask for one manually rather than to
  // invent or infer it.
  const draft = profileFromUser({ email: null, identities: [xAccount] });

  assert.equal(draft.email, null);
  assert.deepEqual(missingProfileFields(draft), ["email"]);
});

test("an email inside a token payload is not treated as the account address", () => {
  // The rule from `02` §6. A provider can put any address it likes in
  // identity_data; only Supabase's own `user.email` is the account's.
  const draft = profileFromUser({
    email: null,
    identities: [
      { provider: "x", identity_data: { user_name: "ada", email: "someone@else.com" } },
    ],
  });

  assert.equal(draft.email, null);
});

test("a linked X handle survives signing in with Google", () => {
  // Otherwise linking X and then using Google would silently drop the handle
  // that identifies the founder on the board.
  const draft = profileFromUser({
    email: "ada@example.com",
    identities: [google, xAccount],
  });

  assert.equal(draft.xHandle, "ada");
});

test("the handle is found however X spells it", () => {
  for (const key of ["user_name", "preferred_username", "screen_name"]) {
    const draft = profileFromUser({
      identities: [{ provider: "x", identity_data: { [key]: "ada" } }],
    });
    assert.equal(draft.xHandle, "ada", `${key} should be read`);
  }
});

test("a handle from X is held to the same rules as a typed one", () => {
  // A provider payload is still untrusted input. A handle containing a slash or
  // a query would rewrite the `x.com/${handle}` link the board builds.
  const draft = profileFromUser({
    identities: [{ provider: "x", identity_data: { user_name: "a/b" } }],
  });

  assert.equal(draft.xHandle, null);
});

test("an over-long handle from X is refused rather than truncated", () => {
  // Truncating would store a handle belonging to somebody else.
  const draft = profileFromUser({
    identities: [{ provider: "x", identity_data: { user_name: "a".repeat(20) } }],
  });

  assert.equal(draft.xHandle, null);
});

test("a user with no identities at all does not crash", () => {
  const draft = profileFromUser({ email: "ada@example.com", identities: [] });

  assert.equal(draft.email, "ada@example.com");
  assert.equal(draft.name, null);
  assert.equal(draft.xHandle, null);
});

test("metadata fills in a name when no identity carries one", () => {
  const draft = profileFromUser({
    email: "ada@example.com",
    user_metadata: { full_name: "Ada Lovelace" },
    identities: [],
  });

  assert.equal(draft.name, "Ada Lovelace");
});

test("whitespace-only values are treated as absent", () => {
  const draft = profileFromUser({
    email: "   ",
    identities: [{ provider: "x", identity_data: { user_name: "   " } }],
  });

  assert.equal(draft.email, null);
  assert.equal(draft.xHandle, null);
});

// ---------------------------------------------------------------------------
// What a founder still has to supply
// ---------------------------------------------------------------------------

test("a complete profile has nothing missing", () => {
  const draft = profileFromUser({ email: "ada@example.com", identities: [google, xAccount] });
  assert.deepEqual(missingProfileFields(draft), []);
});

test("neither a name nor a handle is required — only an address is", () => {
  // A Google-only founder has no handle, and the board shows their display name
  // instead. Requiring one would make X mandatory to enter.
  const draft = profileFromUser({ email: "ada@example.com", identities: [google] });
  assert.equal(draft.name, "Ada Lovelace");
  assert.equal(draft.xHandle, null);
  assert.deepEqual(missingProfileFields(draft), []);

  const nameless = profileFromUser({
    email: "ada@example.com",
    identities: [{ provider: "x", identity_data: { user_name: "ada" } }],
  });
  assert.deepEqual(missingProfileFields(nameless), []);
});

// ---------------------------------------------------------------------------
// The post-callback redirect
// ---------------------------------------------------------------------------

test("a same-site path is allowed", () => {
  assert.equal(safeRedirectPath("/join"), "/join");
  assert.equal(safeRedirectPath("/leaderboard?q=ada"), "/leaderboard?q=ada");
});

test("an absolute URL is refused — an OAuth callback is not an open redirect", () => {
  assert.equal(safeRedirectPath("https://evil.example.com"), "/join");
  assert.equal(safeRedirectPath("http://evil.example.com/x"), "/join");
});

test("a protocol-relative URL is refused, because it looks like a path", () => {
  // `//evil.example.com` passes a naive `startsWith("/")` check and is a valid
  // navigation to another origin.
  assert.equal(safeRedirectPath("//evil.example.com"), "/join");
  assert.equal(safeRedirectPath("/\\evil.example.com"), "/join");
});

test("a path smuggled behind a control character is refused", () => {
  // The bypass that defeated a prefix check. The URL parser strips every tab
  // and newline *before* parsing, so `/\t/evil.com` is `//evil.com` by the time
  // anything navigates to it — protocol-relative, and off-site.
  //
  // These all passed the old `startsWith("//")` test, because that test was
  // reading a string the browser never sees.
  for (const attack of [
    "/\t/evil.example.com",
    "/\n/evil.example.com",
    "/\r/evil.example.com",
    "/\t\t/evil.example.com",
    "\t//evil.example.com",
    "/\u0000/evil.example.com",
    "/\u007f/evil.example.com",
  ]) {
    assert.equal(
      safeRedirectPath(attack),
      "/join",
      `${JSON.stringify(attack)} should be refused`,
    );
  }
});

test("a valid path keeps its query and fragment", () => {
  assert.equal(safeRedirectPath("/leaderboard?q=ada"), "/leaderboard?q=ada");
  assert.equal(safeRedirectPath("/join?next=/x#top"), "/join?next=/x#top");
});

test("the returned value is the parsed one, not the input echoed back", () => {
  // The caller receives what was validated rather than what was sent, so the
  // two can never be different strings.
  assert.equal(safeRedirectPath("/a/../join"), "/join");
});

test("a relative path is refused", () => {
  assert.equal(safeRedirectPath("join"), "/join");
  assert.equal(safeRedirectPath(""), "/join");
  assert.equal(safeRedirectPath(null), "/join");
});

test("the fallback is configurable and also guarded", () => {
  assert.equal(safeRedirectPath(null, "/"), "/");
  assert.equal(safeRedirectPath("//evil.example.com", "/"), "/");
});
