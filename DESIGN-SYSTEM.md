# raceto10 — design system & build instructions

Give this whole file to Claude Code (DeepSeek v1 Flash) as the design source of truth for
every page and component in the app, not just the landing page. Nothing here should be
reinterpreted per-page — one system, applied everywhere.

## Direction

Dark, technical, quietly confident — the register of a tool built by someone who ships, for
people who ship. Think Vercel/Linear/Raycast-class dark UI: restrained, high-contrast,
almost no decoration, every pixel doing a job. Same weight class as TrustMRR, not a clone of
it — TrustMRR leans full-monospace and purple; we lean mostly-sans with monospace reserved
for numbers and data, and a warm amber accent instead of purple. The site should look like
it was designed once, carefully, not generated and left alone.

## Color tokens

| Token | Hex | Use |
|---|---|---|
| bg | #0B0B0D | page background |
| surface | #17171A | cards, panels |
| surface-raised | #1E1E22 | hovered/active surface |
| border | #2A2A2F | all dividers and card borders |
| text | #F2F1ED | primary text |
| text-muted | #8C8B85 | secondary text, captions |
| accent | #FF7A1A | primary actions, links, key numbers |
| accent-dim | #4A2E14 | accent backgrounds (badges, subtle fills) |
| live | #34C77B | verification/live/success signals only |
| danger | #E5484D | errors only — do not use elsewhere |

Only two colors carry meaning beyond neutral UI: accent (action/emphasis) and live (verified/
real-time). Never introduce a third meaningful color. Never use gradients. Never use purple.

## Typography

Two families only:
- **Sans** (headings, body, UI): a geometric/grotesk sans with real character — Space Grotesk
  or General Sans, loaded via `next/font`. Never default to plain Inter everywhere.
- **Mono** (numbers, stats, timestamps, race data only): JetBrains Mono or IBM Plex Mono.
  Using mono specifically for data is what nods at "developer tool" without going
  full-terminal the way TrustMRR does.

Three sizes, no more, anywhere in the product:
- Large — headlines, hero text (36–56px depending on context)
- Medium — section titles, card titles (18–22px)
- Small — body copy, labels, captions (13–15px)

Weight rules: 600–700 only on the headline and primary CTA. Everything else 400–500.
If a screen has more than three font sizes or more than two bold elements, that's a bug —
fix it before shipping the page.

## Spacing & shape

- 4px base unit. All spacing in multiples of 4 (8, 12, 16, 24, 32, 48, 64).
- Border radius: 8px on inputs/small elements, 12px on cards, 999px (pill) on buttons and
  badges only. No other radius values.
- Borders are 1px, `border` token, always — no heavier borders, no colored borders except
  on focus states (accent) or error states (danger).

## Core components

**Button (primary):** accent background, `bg` colored text (dark text on the bright accent,
for contrast — not white), pill radius, medium weight, sentence case. "Join the race," never
"JOIN THE RACE" or "Join Now!!"

**Button (secondary):** transparent, 1px border, text color, same radius/case rules.

**Card:** `surface` background, 1px `border`, 12px radius, 24–32px internal padding. No
shadow — depth comes from the border and background-shift, not drop shadows. Shadows are
another AI-slop tell; skip them entirely.

**Pill/badge:** used only to hold real, specific information (a live count, a status like
"Open" or "Verified") — never decorative, never a number that doesn't mean anything.

**Input:** `surface` background, 1px `border`, accent border on focus, no glow/shadow on
focus, just the color change.

## The sticky sponsor bar system

This is a structural rule, not a suggestion — get this exactly right, it's the one piece
we've watched work on a real, live competitor.

- **Desktop (≥1024px):** two vertical columns, fixed position, one on each side of the
  centered main content column. They do not move on scroll — `position: sticky; top: 0` with
  the correct container height, or `position: fixed` with the right offsets, whichever
  actually holds them still through testing. 5 slots per side. Each slot: icon/logo, name,
  one-line description, sized to match a small card — roughly 170–190px wide, ~90px tall.
- **Mobile (<1024px):** two horizontal bars, one pinned to the very top of the viewport, one
  pinned to the very bottom, both `position: fixed`. Cards inside scroll horizontally within
  their bar. Main page content scrolls vertically underneath both, completely independent of
  them.
- Every slot shows real state only: "Open · from $50" for unsold slots, real sponsor info
  once sold. Never a placeholder that looks like a real, filled slot.

## The globe / live-activity module

A real world map (not an abstract wireframe circle), dark-tinted, with actual visitor
location markers placed at real approximate coordinates, plus a scrolling feed underneath
of real recent activity ("amaranth finch from Canada visited"). This is a DataFast-style
live-data visualization, not a static illustration — it should be wired to real visit data
from day one, even if that means very few dots at first. An empty-but-real globe is fine.
A fake, populated one is not — see honesty rule below.

## Motion

One deliberate animation system: live indicators (the globe dots, the "X founders" counter,
new activity-feed entries) pulse or fade in gently. Nothing else animates — no hover-lift on
every card, no scroll-triggered reveals on every section. Motion is reserved for things that
are actually changing in real time, so it stays meaningful instead of decorative.

## Copy voice

Hopkins rules, applied everywhere, not just the hero:
- Every sentence addresses one reader, not a crowd. "You," not "founders" or "users."
- State specific facts and real numbers. Never "best," "revolutionary," "the ultimate."
- Never describe the product in the abstract — describe what happens for the person reading.
- Sentence case always, including buttons, nav labels, and headings.

**Locked headline (do not change without explicit approval):**
"You said you'd get customers. Now prove it — in public, for free."
Subline: "raceto10 — connect Stripe, race to your first 10 customers."
Hero has exactly one CTA: "Join the race." No form fields in the hero itself.

**The live founder count is a headline-level element, not a small badge** — large type,
high in the page, same visual weight as a stat would get on Outbid. Whatever the real number
is, that's the number shown, rendered big.

## Non-negotiable honesty rule

Every number, name, and location anywhere in the product is real or it does not appear —
this applies to every future page, not just the ones specified here. No seeded founders, no
fake visitor dots, no placeholder testimonials dressed up as real ones. If a section would
look empty with real data, it stays empty rather than being filled with anything invented.

## Page structure (landing/waitlist page, build this first)

1. Nav — logo mark + wordmark, one link ("How it works")
2. Hero — live count (large), headline, subline, single CTA
3. Sponsor bars (per spec above) flanking everything from here down
4. Globe / live-activity module
5. How it works — 3 numbered steps (this is the one place numbering is earned, it's a real
   sequence): join free → connect Stripe → race to 10, verified
6. Signup — email + one qualifying question ("How many paying customers do you have right
   now?"), only here, not in the hero
7. Footer — domain, one honest line, nothing else

## Anti-patterns — reject any output that has these

Purple or gradient anywhere. More than 3 font sizes on one screen. Bold on more than the
headline and CTA. Drop shadows on cards. All-caps tracked-out labels. Decorative numbers or
icons that don't carry real information. More than one accent color. A stat, name, or
location that isn't backed by real data. Generic "AI slop" defaults — check every screen
against this list before calling it done.

## Still open (do not build yet — spec these together first)

Payment/Stripe connection flow, how a race actually starts once someone registers, the
registration-to-race-start mechanic end to end. Landing page above is the complete, buildable
scope for right now.

> **Resolution note (added 2026-09-17).** Everything listed above has since been specified in
> `SYSTEM-ARCHITECTURE.md` §3–4, and the buildable scope is now all three pages (`/`, `/join`,
> `/sponsor`) — see §1 of that file and `IMPLEMENTATION-PLAN.md`. Nothing in this design
> system changed; this note exists only so the contradiction isn't discovered mid-build.
>
> One copy example in this document is stale rather than normative: the sponsor slot label
> `"Open · from $50"` under **The sticky sponsor bar system**. The real starting price is $49
> (`SYSTEM-ARCHITECTURE.md` §3), and in any case **that string must render from the
> `current_price_cents` in the database, never from a literal** — the honesty rule makes a
> hardcoded price a defect, not a placeholder.
>
> **Recorded 2026-09-17, after the multi-provider decision. Nothing below has been changed
> here — these are noted so they are decided deliberately rather than discovered mid-build.**
>
> - **The locked hero subline and how-it-works step both name Stripe.** Line 121
>   ("raceto10 — connect Stripe, race to your first 10 customers") and line 142
>   ("join free → connect Stripe → race to 10, verified") are marked *do not change without
>   explicit approval*, and racer verification now supports Lemon Squeezy as well as Stripe.
>   That copy is therefore conditionally false for one class of racer. **It has deliberately
>   not been edited.** `SYSTEM-ARCHITECTURE.md` §13 records this as blocking the racer flow.
> - **A third sponsor slot state exists with no copy.** The rules above cover two states —
>   "Open · from $50" and real sponsor info once sold. The concurrency fix adds `pending`
>   (someone is completing a purchase right now). It needs its own true label; it must not
>   reuse "Open".
> - **The mobile top bar collides with the nav.** This document pins a sponsor bar to the very
>   top of the mobile viewport, where the nav already sits. Their stacking is unspecified.
> - **The short-description cap is now a number: 60 characters.** This document says the card
>   is ~170–190px wide and ~90px tall carrying an icon, a name, and a description, and §3 of
>   the architecture derives the cap from that geometry. A longer string overflows the card
>   size fixed here, so changing the cap means changing the card.
> - **Slots per mobile bar is unspecified** — 5 per side is fixed for desktop, nothing is said
>   for mobile. The current assumption is 5 and 5.
