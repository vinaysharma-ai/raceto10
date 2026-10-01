# raceto10 — full redesign pass

Supersedes the color/type sections of DESIGN-SYSTEM.md and the globe section of
LANDING-PAGE-CORRECTION.md. Everything below is the current instruction — build against this.

## Color: monochrome, one functional exception

Drop the orange entirely — agreed, it was reading as decoration, not signal.

| Token | Value | Use |
|---|---|---|
| bg | #0A0A0A | page background |
| surface | #161616 | cards, panels |
| border | #2C2C2C | dividers |
| text | #F5F5F3 | primary text |
| text-muted | #8A8A85 | secondary text |
| live | #34C77B | verified/real-time signals **only** — this is the one exception, and it stays because it carries real meaning (something is actually live or actually verified), not decoration |

Buttons: white fill, black text, pill or slightly rounded — not orange, not outlined-only.
This is the single highest-contrast element on the page now, so it should look considered,
not like a leftover.

## Typography: lean into monospace, this is what "built for builders" actually looks like

Headline, nav, buttons, and all data (counts, leaderboard numbers, timestamps) in monospace
— JetBrains Mono or IBM Plex Mono. This is the concrete thing that makes a page read as
"made by developers" instead of "made about developers." Reserve a plain sans only for
longer body copy if any exists; there mostly isn't any on this page once the explanatory
lines are cut. Three sizes, same rule as before, just applied to a mono-first system now.

## Logo

Keep the concept — the 10-with-progress-ring was the one thing that already worked — but
execute it in pure white stroke on black, no fill color. Simple, technical, matches the new
palette instead of fighting it.

## Header

Logo + wordmark, left, standard position. Search bar, center or directly beside the logo —
placeholder "Search a founder or startup." A "Join the race" button, right. Remove whatever
stray divider is currently rendering oddly below the header — a single clean 1px border at
the very bottom of the nav row, nothing else.

## The globe — Mapbox, not an SVG outline

Use Mapbox GL JS (`react-map-gl` as the React wrapper) with a dark custom style — start from
Mapbox's `dark-v11` base and strip labels/roads/POIs down to just landmass and country
borders, quiet and technical, matching the border token above. This gives real zoom and pan
out of the box, and real country boundaries natively — nothing hand-drawn.

Requires a free Mapbox account and API key (generous free tier, tens of thousands of loads/
month — not a blocker at current scale, but note it's a real signup, not zero-config).

Markers: simple, monochrome dots (not illustrated avatars — that's DataFast's own custom
character art, distinctive to them; ours should feel equally real and alive without
borrowing their specific illustration style). A dot per real racer location, subtle pulse
per the existing motion rule. Click a dot to reveal name/handle in a small tooltip.

Recent-activity feed: a small floating card overlaid on the map itself (bottom-left), not a
separate section below it — real events only ("[handle] joined," "[handle] hit customer
#4"), same pattern as what you saw on the reference site just now.

Empty state stays exactly as it is conceptually (honest, no fake dots) — just render it on
the real map now instead of a flat outline.

## Leaderboard (below the globe)

Columns: X handle, SaaS name, customer count (progress toward 10), MRR. MRR is informational
context, not part of the race mechanic itself — the race is still decided by customer count,
MRR just gives a spectator more real texture, the same way TrustMRR shows multiple real
numbers per row rather than just one.

## `/join`

Fields: name, SaaS name, public X handle, email, Connect Stripe. Be precise in the copy that
Stripe is the only connection actually wired right now, even if the product will eventually
support more than one processor — don't promise something that isn't built yet, that's the
same honesty rule as the rest of the page.

## Sponsor slots

Small bordered cards, TrustMRR's sidebar shape — quiet and uniform while empty (no color
variation yet, that comes with real sponsors and their own logos later). Clicking any empty
slot routes to a `/sponsor` page using the exact same honest "not open yet" pattern already
built for `/join` — same component, reused, not rebuilt from scratch.

## Final pass — check the whole site against this, not just what's new

No color anywhere except the single `live` green. No shadows. No gradients. Every number
real or absent, never placeholder. Nothing on the page that would look identical on a
generic SaaS template — the map, the monospace data, and the real leaderboard are what
should make that untrue here.
