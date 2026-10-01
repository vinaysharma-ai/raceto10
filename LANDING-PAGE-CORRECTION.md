# raceto10 — landing page correction pass

This replaces the current landing page structure. Read fully before touching code — several
items below are removals, not additions.

## Remove entirely
- The "How it works" three-card section (Join free / Connect Stripe / Race to 10)
- The "Read-only. We can see your customers. We can never touch your money." line
- Any other explanatory copy whose only job is reassuring the reader the numbers are real —
  the globe and the live count do that job now, visually, and do it better than a sentence can.

## New page order, top to bottom
1. Nav — logo + wordmark, "How it works" link removed since that section no longer exists;
   replace with a link straight to `/join`
2. Hero — live count, headline, subline, single "Join the race" button (unchanged)
3. **The globe — see below, this is the section that was missing**
4. Five sponsor slots (not ten) — see below
5. Waitlist signup (email + qualifying question, unchanged)

## The globe — build this with a real mapping library, not hand-rolled SVG

Reversing my earlier instruction not to use a dependency — that instruction is why this kept
getting skipped or abstracted. Use it now:

- `react-simple-maps` for rendering, `world-atlas` (the `countries-110m.json` topojson file,
  a standard, widely-used package) for the actual map geometry. This is a common, well-
  documented pairing — a coding agent has many real examples to work from, which is exactly
  what "hand-roll it" didn't give it.
- Render the world outline in a muted single tone (`border` token, #2A2A2F), no fill
  gradients, no country borders drawn — just coastlines, quiet and technical.
- Plot real signup locations as small accent-colored dots (`accent`, #FF7A1A) using
  `Marker` at each racer's approximate lat/lng, pulsing gently per the motion rule already
  specified (only live elements animate).
- Underneath: the real recent-activity feed (name/handle, city or country, "joined" or
  "hit customer #4"), pulled from the same real event data, not separate from it.
- If zero real signups exist yet, render the empty map with no dots and no feed rows — an
  honest empty globe is fine, exactly like the honest-zero count. Do not seed it with
  placeholder dots to make it look populated.

## Sponsor section — five slots, framed as a signal, not a request

Small, quiet section — a label like "Sponsors" and five slot cards, matching the
sponsor-slot-card component already built, each showing "Open" and price. No headline
copy pitching sponsorship, no explanation of the benefit — just enough visible presence
that a visitor understands sponsorship exists here, without competing with the race for
attention. This section should read as noticeably smaller and quieter than the globe.

## `/join` page — new, and the fields are more than currently specced

Fields, in order:
1. Name
2. Handle
3. Product/SaaS name (what they're racing with)
4. Public X (Twitter) handle — stored and shown on their eventual leaderboard entry, this
   is part of what makes a race page shareable later
5. Email
6. Connect Stripe (unchanged mechanism — read-only OAuth)

On successful Stripe connection: baseline snapshot, race starts, redirect to the
leaderboard (`/` or a dedicated `/leaderboard` if one exists yet — redirect to whichever
is the current real leaderboard view) so the racer immediately sees themselves on the
board they just joined. That redirect is the actual payoff moment of the whole signup —
don't let it dead-end on a generic "thanks for joining" screen.

## Bar for "does this feel right," concretely

Not "does it follow the token list" — it already does and still felt wrong. The real test:
does the page have at least one thing on it that couldn't be swapped onto any other SaaS
landing page without noticing? Right now the answer should be the globe. If the globe ships
and the page still feels generic, that's the signal to come back and look harder — not to
add more standard sections on top of it.
