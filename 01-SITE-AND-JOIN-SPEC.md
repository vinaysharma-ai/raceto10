# RaceTo10 — Site + Join Spec
## Version: 28 Sept 2026

This is the launch UX spec for the current RaceTo10 product. The race is the product; sponsorship is secondary.

## 1. Product feel
- Dark monochrome, mono-first, developer/builder vibe.
- White primary actions; green only for verified/live states.
- No gradients, shadows, purple, decorative orange, generic SaaS feature cards, fake activity, fake founders, fake counts, or fake sponsors.
- The globe, leaderboard, real data, and typography create the identity.
- Empty states are intentional and honest.

## 2. Header
- Logo + wordmark left.
- Search input beside logo, placeholder `Search a founder or startup.`
- `Join the race` button right.
- One clean bottom border only.
- Search covers public founder name, X handle, and SaaS/product name.
- Search must only expose public race data.

## 3. Landing page
Order:
1. Header
2. Hero
3. Search under the hero supporting line
4. Interactive Mapbox globe
5. Leaderboard
6. Empty sponsor slots / rails
7. Waitlist / launch state
8. Footer

Do not re-add the removed How-it-works cards or generic reassurance copy.

## 4. Hero
Headline (locked):
`You said you'd get customers. Now prove it — in public, for free.`

Supporting line:
`raceto10 — connect Stripe, race to your first 10 customers.`

CTA: `Join the race` → `/join`

## 5. Globe
- Use the existing Mapbox implementation.
- Real pan/zoom and country borders.
- Dark, quiet map styling.
- One subtle marker per real public racer location.
- Public location is approximate only; never expose an exact address.
- Marker click can show public founder identity.
- Recent activity is a small floating feed over the map.
- Only live/verified elements animate.
- Same public data source powers globe, leaderboard, and activity.
- Empty state: globe remains visible, zero markers and zero feed rows.
- Loading and error states must be distinguishable.

## 6. Leaderboard
V1 columns:
- X handle
- SaaS / product
- Customers
- Progress to 10

MRR is deferred until currency normalization is implemented honestly.

Sort:
- verified customer count descending
- tie-break by earlier verified milestone time

Finished racers remain public at 10/10. Waiting users are not mixed into the active board; they can appear in a small Waiting/Next race area.

Only public views are queried by the browser.

## 7. `/join`
The join page should feel like getting onto the starting line, not filling out SaaS onboarding.

Title:
`Join the race`

Subline:
`Start at 0 customers. Race to your first 10.`

Explicit eligibility copy:
`To enter, your product must currently have 0 paying customers and $0 MRR.`

### Identity
Buttons:
- `Continue with Google`
- `Continue with X`

Use OAuth identity data where safely available. Do not make users retype known information.

If X does not provide an email, ask for one manually.

### Founder fields
Collect only what is required:
- Name
- SaaS / Product name
- Public X handle (optional when X identity already supplies it; optional for Google users)
- Email when not already known

Do not collect passwords or exact address. Never collect raw payment secrets in client-side state.

### Payment provider
Primary: `Connect Stripe`
Secondary: `Connect Lemon Squeezy`

Current V1 Stripe connection:
- racer pastes a restricted read-only Stripe API key
- send only to a trusted server route
- never log/echo/store plaintext
- encrypt before persistence

Lemon Squeezy remains behind a feature flag until its credential scope/security model is verified.

### Eligibility result
Eligible:
`You're at 0 customers. You're in.`

Not eligible:
`You're not eligible for this race yet. Your connected account shows paying customers or non-zero MRR.`

Eligibility is server-verified, never a user claim.

### Ready state
After eligibility:
`You're in. Your clock hasn't started yet.`
`We'll email you when the next race begins.`

The connection must NOT start an individual timer.

## 8. Race/batch model
V1 uses cohorts.
- Registration happens before a batch starts.
- Founder may wait in `ready` for days.
- Vinay starts a batch manually with a protected operation.
- All active entries share one `starts_at` and 14-day window.
- Baseline customer count is captured at activation/start, not at initial provider connection.
- A newcomer during an active race goes into the next batch rather than getting a private 14-day clock.

This keeps the public leaderboard comparable.

## 9. Notification
Minimum launch email:
`Your RaceTo10 race has started.`

Include founder name, batch start/end time, public leaderboard link, and a concise verification note.

Do not build a large notification system before the first cohort.

## 10. Sponsor slots
Sponsors stay secondary.
- Desktop: 4–5 empty bordered slots per side where layout permits.
- Mobile: compact empty sponsor strip/slots.
- Dark/black empty surfaces with thin light border.
- No fake brands, pricing, impressions, clicks, or payment UI.
- Hover/focus/click reveals `Sponsor` or `Sponsor this space`.
- Click → `/sponsor`.

## 11. `/sponsor`
Minimal mono-first page:
`Sponsorship isn't open yet.`
`We're building the race first. Sponsor inventory will open once the public race is running.`

No fake availability or sponsor data.

## 12. Public founder/race page
A shareable public page is recommended from leaderboard rows.
Show:
- public identity / X handle
- SaaS name
- verified customer count
- progress to 10
- race status
- batch start/end
- public milestones

Never show email, auth IDs, provider keys, exact transactions, private financial data, or precise location.

## 13. Privacy and consent
Before public publication, require consent for the fields that become public. Link `/privacy` and `/terms` and explain public name/product/handle/approximate location/status/count.

## 14. Responsive behavior
- Preserve the globe as the main visual on mobile.
- Keep controls thumb-friendly.
- Keep sponsor UI secondary.
- Avoid oversized copy that buries the race.
- Leaderboard must remain readable without hiding the customer count.

## 15. Done
A stranger can authenticate, complete the minimum profile, connect a supported provider, be verified at 0 customers/$0 MRR, become ready, and understand their clock has not started. After batch start they receive the email and appear on the public race surfaces.
