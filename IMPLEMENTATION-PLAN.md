# raceto10 — implementation plan (V1)

Companion to `DESIGN-SYSTEM.md` (how it looks) and `SYSTEM-ARCHITECTURE.md` (what it does).
Those two remain authoritative; this file records **how it gets built** and **in what order**.
Where this file and either spec disagree, the spec wins and this file is a bug.

Status: **approved scope, no code written.** Nothing in this document has been implemented.
No packages have been installed. No tables, migrations, or routes exist.

---

## 1. Finalized V1 scope

### In scope — three pages, two payment systems, one race

| Area | V1 |
|---|---|
| `/` landing | Nav, hero with live founder count, sponsor bars, globe + activity, how-it-works (3 steps), waitlist signup, footer |
| `/join` | Racer registration: 3-field form → provider connection → race starts |
| `/sponsor` | 10-slot grid, term purchase modal, Stripe Checkout |
| **Racer verification** | **Provider-agnostic.** Stripe **and** Lemon Squeezy adapters behind one interface |
| Racer lifecycle | Baseline snapshot, derived counting, `registered → racing → won \| expired` |
| **Sponsor payments** | **Stripe Checkout only.** Completely separate from racer verification |
| Sponsor lifecycle | Fixed-price terms of 1, 3, or 7 days; expires back to open. **No bidding in V1** |
| Sponsor metrics | Real impressions and clicks per sponsorship. Never fabricated, never guessed |
| Real-time | Sponsor slots and race events push; all reads re-derive from Postgres |
| Globe | Real visitor geo from the `visit` table. Empty is acceptable; fake is not |

### Two payment systems, never one

This is the single most important structural rule in the build, and it is easy to blur because
both involve Stripe:

| | **Racer verification** | **Sponsor payments** |
|---|---|---|
| Who moves money | nobody — we only read | sponsor → **us** |
| Stripe product | **Connect / OAuth** | **plain Checkout** |
| Providers in V1 | Stripe, Lemon Squeezy | Stripe only |
| Credential | read-only scope (Stripe); full-access key (Lemon Squeezy) | none of theirs; platform key |
| Webhook secret | `STRIPE_CONNECT_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` |
| Engine | provider-agnostic (§7) | Stripe-specific |

Lemon Squeezy is a **future fallback for sponsor payments only**, not implemented in V1.

### Explicitly out of scope for V1

Leaderboard, public race pages, admin surface, email of any kind, dispute handling,
sponsorship-history UI, sponsor self-service, racer accounts/login, multi-currency, mobile
apps, Lemon Squeezy sponsor payments, Stripe Managed Payments — and, explicitly,
**bidding, auctions or slot takeover of any kind**. Those are a future possibility contingent
on demonstrated demand, not a V1 feature that is merely switched off.

### Resolved decisions carried in from the audit

1. Baseline stored as a **customer-id set**, not a counter.
2. Customer count **derived**, never incremented.
3. `race_start_at` written **before** the baseline snapshot.
4. Public data exposed via **views**, not column-level grants.
5. Sponsor positions carry **no payment identifier** (Realtime broadcasts whole rows).
6. A **`pending` hold** stops two sponsors buying the same position at the same moment.
7. Sponsorship is **fixed-price and one-time**, with a **1, 3, or 7 day** term.
   **No bidding, no takeover, no recurring billing in V1.**
8. Prices live in **their own table**. Never in UI copy, never in business logic.
9. A sponsor may only buy a position that is **free right now**. No delayed booking,
   no reservation of an occupied position, in V1.
10. **Liveness is derived from time, never stored.** An expired sponsorship frees its
    position without anything having to be written. More than ten lifetime sponsors come
    from expiry and replacement over time.
11. **No cash refunds after activation.** A platform-side failure that prevented display
    is compensated with equivalent **time extension or account credit** — not cash, and
    not pro-rata arithmetic.
12. Sponsor metrics are **measured, never fabricated**. If a number cannot be established,
    it is not displayed.
13. Race length is **14 × 24h** — timezone-independent. *(That is the racer race window;
    it is unchanged and unrelated to sponsor terms.)*
14. Refunds do **not** remove a counted customer.
15. Guest checkouts **do not count** (flagged, §24).
16. Status derived on read; scheduled jobs persist transitions only.
17. **Race engine is provider-agnostic**; providers are adapters (§7).
18. Short-description cap is **60 characters**, derived from the card geometry.

---

## 2. Route architecture

Next.js 16 App Router. Every dynamic API awaits `params`.

```
src/app/
  layout.tsx                          root — fonts, viewport, metadata. No sponsor bars.
  page.tsx                            /          landing
  join/page.tsx                       /join      racer registration
  sponsor/page.tsx                    /sponsor   10-slot grid, term purchase
  (marketing)/layout.tsx              sponsor bars wrap / and /sponsor ONLY

  api/
    webhooks/
      stripe/platform/route.ts        sponsor Checkout + refunds
      stripe/connect/route.ts         racer verification events (Stripe)
      lemonsqueezy/route.ts           racer verification events (Lemon Squeezy)
    connect/
      stripe/callback/route.ts        Stripe OAuth redirect URI (GET)
      lemonsqueezy/route.ts           Lemon Squeezy credential submission (POST)
    cron/
      race-lifecycle/route.ts         persist won/expired
      reconcile/route.ts              re-derive counts, sweep stale pending slots
```

Three webhook endpoints, three secrets. `lemonsqueezy` is the only endpoint whose signature
scheme differs (`X-Signature`, HMAC-SHA256) — and it is also the only one that may never
receive a single event (§8).

**Why `/join` is outside the sponsor-bar layout:** `SYSTEM-ARCHITECTURE.md` §5 says that page
has one job and the bars are a distraction. A route group makes this structural rather than a
conditional inside the layout.

**`proxy.ts`, not `middleware.ts`.** Next.js 16 renamed the convention; the exported function
is `proxy`, the runtime is Node.js, and setting `runtime` in the file **throws**. The matcher
must exclude every `/api/*` webhook and callback path:

```ts
// src/proxy.ts  (shape, not final)
export const config = {
  matcher: ['/((?!api/webhooks|api/connect|api/cron|_next/static|_next/image|favicon.ico).*)'],
}
```

The exclusion is not cosmetic. **When `proxy.ts` exists, Next.js buffers request bodies in
memory with a 10 MB cap and silently truncates beyond it** — a truncated webhook payload fails
signature verification, and the failure looks like a Stripe or Lemon Squeezy problem rather
than a proxy configuration problem.

---

## 3. Frontend architecture

Server-first. Everything a visitor sees is rendered from Postgres on the server. Realtime only
triggers a re-render; it never supplies the data.

| Concern | Approach |
|---|---|
| Rendering model | Server Components everywhere; Client Components only for the modal, globe, subscription hooks, and form controls |
| Cache Components | **Off.** Live counters must never serve a stale prerender — a cached count is a correctness bug under the honesty rule, not a perf trade-off |
| Data freshness | Default (uncached) reads. No `use cache`, no `unstable_cache`, no ISR on counters |
| Streaming | `<Suspense>` around live sections so the hero paints before counters resolve |
| Styling | Tailwind v4 with design tokens as CSS variables in `globals.css`. No raw hex below the token layer |
| Theme | **Dark only.** The scaffold's `prefers-color-scheme` block is removed |
| Fonts | Space Grotesk (sans) + JetBrains Mono (data) via `next/font/google`, replacing Geist |
| Icons/logo | Inline SVG component. No icon package |
| Motion | CSS keyframes on live elements only |

**Typography is a build constraint.** The design system caps the product at three sizes and two
bold elements per screen. Enforced by defining exactly three text utilities and one heading
weight — a component needing a fourth size is a component that's wrong.

---

## 4. Component hierarchy

```
app/layout.tsx
├─ <Logo />                        inline SVG, shared with favicon
└─ {children}

app/(marketing)/layout.tsx
├─ <SponsorRail side="left" />     fixed, ≥1024px
├─ <SponsorRail side="right" />
├─ <SponsorBar position="top" />   fixed, <1024px
├─ <SponsorBar position="bottom" />
└─ {children}

app/page.tsx
├─ <Nav />                         logo + "How it works"
├─ <Hero>
│   ├─ <LiveFounderCount />        large type, real number
│   ├─ headline                    LOCKED COPY — see §23
│   └─ <Button href="/join">Join the race</Button>
├─ <GlobeModule>
│   ├─ <Globe />                   client — real coordinates
│   └─ <ActivityFeed />            client — real visits
├─ <HowItWorks />                  3 numbered steps
├─ <WaitlistForm />                email + qualifying question
└─ <Footer />

app/join/page.tsx
├─ <RulesRecap />
├─ <ProviderChoice />              Stripe | Lemon Squeezy  (§7)
├─ <StripeConnectPanel />          consent flow — redirect
└─ <LemonSqueezyConnectPanel />    credential flow — paste, with disclosure

app/sponsor/page.tsx
├─ <SlotGrid />                    10 × <SponsorSlotCard />
└─ <SlotClaimModal />              client — the whole pick-a-term-and-pay loop

shared
├─ ui/{Button,Card,Badge,Input}    the only primitives
└─ SponsorSlotCard                 ONE component, all four placements
```

**`SponsorSlotCard` must be a single component** consuming one `sponsor_slot_public` shape at
all four placements. Two implementations is how the rails drift from the bars — the failure the
design system's size rules exist to prevent.

**`StripeConnectPanel` and `LemonSqueezyConnectPanel` are deliberately two components.** They
are not one component with a prop. A consent screen and a paste-your-key form are different
acts with different consequences, and `SYSTEM-ARCHITECTURE.md` §15 requires that difference be
visible rather than abstracted away.

---

## 5. Supabase schema

Full field lists live in `SYSTEM-ARCHITECTURE.md` §2. This is the build view.

| Table | Purpose | Realtime | Public read |
|---|---|---|---|
| `racer` | registration + race state + provider | no | via view |
| `race_baseline_customer` | customer ids at connect | no | **never** |
| `race_customer` | distinct post-start payers | no | no |
| `race_event` | real feed events | **yes** | via view |
| `waitlist_signup` | landing capture | no | count only |
| `sponsor_slot` | the ten positions. Fixed inventory, no holder and no price | **yes** | **yes** (no secrets) |
| `sponsorship` | a booked term on a position | **yes** | via view |
| `sponsor_pricing` | price per term. Editable without a deploy | no | via view |
| `sponsor_daily_stat` | impressions and clicks, per booking per day | no | no |
| `sponsor_payment` | payment records, one per booking | no | no |
| `provider_event` | webhook ledger, all providers | no | no |
| `visit` | visitor geo | no | via view |

**Provider-neutral by construction.** `race_baseline_customer` and `race_customer` key on
`external_customer_id`, and `racer` carries `verification_provider`. Neither table has a
provider-specific column, which is what makes the portability claim real rather than nominal.

### Constraints that carry correctness

```sql
unique (racer_id, external_customer_id)   -- race_customer
unique (racer_id, external_customer_id)   -- race_baseline_customer
unique (stripe_payment_intent_id)         -- sponsor_payment
unique (stripe_session_id)                -- sponsor_payment
unique (slot_number)                      -- sponsor_slot
unique (email)                            -- racer
primary key (id)                          -- provider_event  (provider's event id)

exclude using gist (slot_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status <> 'cancelled')           -- sponsorship
```

These allow every handler to be written without a "has this already happened?" query, and are
why a replayed webhook cannot corrupt state. They are the load-bearing part of the schema.

**The exclusion constraint is the sponsor-side equivalent of those unique constraints.** It
makes two sponsors holding one position at overlapping times *impossible in the database*,
rather than something application code has to remember to check. It replaces the `version`
concurrency token entirely: with fixed prices there is no stale-price race left to detect.
Requires `btree_gist`.

### Credential storage

Lemon Squeezy hands over a **full-authority** credential that we cannot scope down, so it is
encrypted at rest in **Supabase Vault** and referenced from `racer.provider_credential_ref`.
Vault keeps the encryption key inside Postgres rather than in an environment variable, and
reading a secret requires service-role privileges — which the server-only boundary already
holds. (`pgsodium` is deprecated in Vault's favour, so Vault is also the forward-looking
choice.) `PROVIDER_CREDENTIAL_KEY` covers the app-level envelope step before Vault.

Stripe needs none of this: OAuth gives us a platform-held token, not a merchant credential.

### Sponsor schema — the shape

Positions and bookings are **separate tables**. That split is what makes "ten visible, more
than ten lifetime" expressible at all; one table holding both cannot rotate.

```
sponsor_slot          -- the ten positions. Fixed inventory. No holder, no price, no status.
  id, slot_number (1..10, unique), placement, created_at

sponsorship           -- one booked term. Many per position, over time.
  #  PUBLISHED TO REALTIME. Nothing that cannot be broadcast may live here.
  id, slot_id → sponsor_slot
  status              pending | confirmed | cancelled
  term_days           1 | 3 | 7
  starts_at, ends_at
  price_cents         what THIS booking cost, captured at purchase
  sponsor_name, sponsor_description, sponsor_logo_url, sponsor_link
  created_at
  ==== exclusion constraint on (slot_id, [starts_at, ends_at)) ====
  #  NOT here, and this is deliberate:
  #    sponsor_email      — a sponsor's address must never be broadcast
  #    hold_expires_at    — operational, not display
  #  Both live on sponsor_payment, which is never published. `sponsor_payment`
  #  already carried `sponsor_email`; the hold joins it there, because a hold is
  #  really "this booking is awaiting payment".

sponsor_pricing       -- the price list. The only place a price is written down.
  term_days (pk), price_cents, updated_at

sponsor_daily_stat    -- measured, not estimated.
  sponsorship_id, day, impressions, clicks      pk (sponsorship_id, day)
```

**A position is free when no `confirmed` sponsorship covers the current instant.** That is a
query, not a column — nothing to expire, nothing to go stale if a job does not run.

### Seed data

Ten `sponsor_slot` rows — positions 1–10 with their placements, **and nothing else**. A
position carries no price and no status.

`sponsor_pricing` is seeded with the three launch prices:

| Term | Launch price |
|---|---|
| 1 day | $5 (500 cents) |
| 3 days | $12 (1200 cents) |
| 7 days | $25 (2500 cents) |

Labeled founding prices and expected to change. Because they live in a table, changing them is
an `UPDATE` — no deploy, and no copy to hunt down.

### Visitor identity — the one thing `visit` cannot currently answer

`visit` stores geo and path but **deliberately no visitor identifier**, which means
*page views today* is `count(*)` but *visitors today* is not computable at all. Five page
views by one person are indistinguishable from one page view by five.

The fix is a **daily-rotating hash** — `hash(ip + user-agent + per-day salt)` — stored as
`visit.visitor_hash`. Comparable within a day, meaningless across days, never an IP. The
migration's existing note already says no per-visitor identifier survives past 24 hours;
this makes that concrete and bounded rather than aspirational.

Without it, "visitors today" cannot be displayed. It is not a number we can approximate
honestly, so either the column exists or the metric does not.

---

## 6. RLS / security strategy

Two trust zones, one boundary.

**Zone 1 — browser.** Publishable key only. Reads through public views. **No write path to any
table exists for `anon`.**

**Zone 2 — server.** Service key in `src/lib/supabase/admin.ts`, guarded by
`import 'server-only'` so an accidental client import is a build error rather than a leak.

| View | Exposes | Withholds |
|---|---|---|
| `sponsorship_live` | the currently-live sponsorship per position — what the bars render. Absent rows mean a free position, not a hidden one | `sponsor_email`, `hold_expires_at`, payment linkage |
| `racer_public` | name, handle, status, progress | email, `provider_account_id`, `provider_credential_ref`, baseline, connect state |
| `race_event_public` | feed | — |
| `visit_public` | geo + time | — |
| `waitlist_stats` | `count(*)` | all emails |

`waitlist_stats` must use owner's-rights semantics (the default, `security_invoker = false`).
An invoker-rights view would be RLS-filtered to `0` and the landing page would quietly display
a false number — a defect the honesty rule is written against.

Additional rules:

- `sponsor_payment`, `racer`, `waitlist_signup`, `sponsor_daily_stat` and
  `sponsorship_adjustment` are **never** added to the Realtime publication. Only
  `sponsorship` and `race_event` are published.
- `waitlist_signup` is written by a Server Action, never a browser insert.
- `provider_credential_ref` is a reference. The credential itself is only ever decrypted inside
  the Lemon Squeezy adapter, and never leaves the server.
- Secrets are never logged or returned in an error body.

---

## 7. Verification provider adapter architecture

The race engine is provider-agnostic. Providers are adapters behind one interface
(`SYSTEM-ARCHITECTURE.md` §14). Stripe and Lemon Squeezy are both supported; **they are not
equivalent** and the product must not imply they are.

```
src/lib/verification/
  types.ts              VerificationProvider, ProviderPayment, ProviderCapabilities
  registry.ts           resolve(providerId) -> VerificationProvider
  stripe/
    adapter.ts          Connect OAuth + Connect webhook verification
    client.ts           API reads on a connected account
  lemonsqueezy/
    adapter.ts          credential validation + X-Signature verification
    client.ts           API reads + newest-first customer paging
  engine/
    baseline.ts         provider-agnostic — consumes ExternalCustomer
    count.ts            provider-agnostic — consumes ProviderPayment
    reconcile.ts        provider-agnostic — drives both of the above
```

**The rule, stated once and enforced in review:** nothing under `engine/` may import from
`stripe/` or `lemonsqueezy/`, or branch on `verification_provider`. If the engine needs
something the interface does not express, the interface is extended — the engine does not
reach around it.

### Capability differences the code must respect

| | Stripe | Lemon Squeezy |
|---|---|---|
| Connection | OAuth + consent screen | pasted credential |
| Scope | `read_only` | **none available — full authority** |
| Credential lifetime | platform-managed | **~1 year, no refresh** |
| Webhooks | we register the endpoint | **merchant must configure it** |
| Date-range query | supported | **not supported** |
| Baseline cost | cheap | **scales with store size** |

These are declared as data on each adapter (`capabilities`) and read by the UI and the
reconciliation job — so the differences drive behaviour instead of living in a comment.

### Adapter test contract

Every adapter passes the same suite against a fake provider, so a third provider can be added
without touching the engine. This is what keeps the abstraction honest rather than aspirational.

---

## 8. Provider connection flows

### Stripe — consent-based, read-only

```
/join ──► create racer (status 'registered', verification_provider='stripe',
                         connect_state, expires +30m)
      ──► 302 → connect.stripe.com/oauth/authorize
                ?response_type=code&client_id=<STRIPE_CONNECT_CLIENT_ID>
                &scope=read_only
                &redirect_uri=<APP_URL>/api/connect/stripe/callback
                &state=<connect_state>
      ◄── 302 back ?code=…&state=…        (or ?error=access_denied)
          verify state (single-use, unexpired)
      ──► exchange code → provider_account_id
      ──► §9 ordered baseline write
```

`read_only` is confirmed valid and is the **default** for Standard accounts, but it is passed
explicitly anyway — silently defaulting into right behaviour is how it later defaults into the
wrong one.

**The authorization code is single-use and expires in 5 minutes.** A racer who pauses on the
consent screen and returns later gets a dead code. Expiry must produce a clean, recoverable
"start again" outcome — not a stuck row. `access_denied` is a normal user choice, not a failure.

### Lemon Squeezy — credential-based, full access

```
/join ──► create racer (status 'registered', verification_provider='lemonsqueezy',
                         connect_state, expires +30m)
      ──► instructions: Settings » API → generate key → paste here
          + an explicit statement of what the key can do   ← required, not optional
      ──► validate against the API; resolve the store id
      ──► encrypt → Vault; store only the reference on the racer row
      ──► §9 ordered baseline write
```

**There is no consent screen because Lemon Squeezy has no OAuth.** The racer is not
authorizing us through any provider-mediated flow; they are copying a credential and handing
it over. That fact is why this cannot be built as the Stripe flow with a different logo.

**Disclosure before the paste** — required, in plain language, on the form itself: the key
grants full access to their store including refunds and subscription cancellation; we cannot
request less; we use it only to read customers and payments; it is encrypted and deletable; it
expires in about a year.

**Webhooks are merchant-configured.** We cannot register an endpoint on their behalf without
using the very credential we are trying to constrain. The flow gives them a URL and secret to
add in their own dashboard and treats it as optional — reconciliation is primary either way.

**Baseline cost is O(store size).** Lemon Squeezy has no date-range filter, so the snapshot
pages the customer list newest-first against a 300 req/min cap. The race must **not** start on
a partial baseline; large stores need visible progress and a resumable snapshot.

**Store scoping is undocumented** — the docs never confirm whether a key is limited to one
store. Until confirmed, "connect one store" is not a promise the product can make.

---

## 9. Customer-baseline architecture

The premise of the whole product. Build it before anything else that touches a racer.

**The ordered write**, executed once, in one server-side function, in this exact sequence:

```
1. race_start_at = now()
2. list the connected account's existing customers   ← via the adapter
3. insert one race_baseline_customer row per external customer id
4. baseline_customer_count = count of rows inserted in step 3
5. baseline_captured_at = now()
6. race_end_at = race_start_at + 14 days
7. status = 'racing'
8. insert race_event(type='started')
```

**Why the order is the mechanism:** if the snapshot were taken first and `race_start_at` set
afterwards, any customer created during the snapshot would fall into a gap — counted neither as
baseline nor as new — and the racer's number would be wrong from day one with no way to detect
it. Writing the start time first makes such a customer unambiguously *after* the start.

**Why a set, not a count:** an existing customer who pays again during the race has a payment
timestamp after `race_start_at`. A counter cannot distinguish them from a genuinely new
customer and would count them. Membership in `race_baseline_customer` is the only available
disambiguator. `baseline_customer_count` is retained for display and must always equal the
set's size — a denormalisation, never the source of truth.

**Not publicly readable.** `racer_public` withholds both the count and the set. The baseline is
never rendered anywhere, by anyone, at any point.

**Provider-neutral.** The adapter returns `ExternalCustomer { externalId, createdAt }` and the
baseline writer consumes only that. Stripe supplies it via a date-filtered cursor list; Lemon
Squeezy via newest-first paging with early termination. The writer cannot tell which.

---

## 10. Customer-count derivation

One function, used by both the webhook path and reconciliation, so they cannot drift:

```
count(racer) =
  SELECT count(*) FROM race_customer rc
   WHERE rc.racer_id = $1
     AND rc.first_paid_at >= racer.race_start_at
     AND rc.first_paid_at <  racer.race_end_at
     AND NOT EXISTS (SELECT 1 FROM race_baseline_customer b
                      WHERE b.racer_id = rc.racer_id
                        AND b.external_customer_id = rc.external_customer_id)
```

In practice the insert already applies the baseline and time filters, so the read is
`count(*)`. The full predicate is stated because it is the **definition** — if the two ever
disagree, the insert is wrong, not the definition.

**No code path increments a counter.** Recomputing is always safe, so:

- a replayed event is absorbed by the unique constraint
- a crashed handler is repaired by the next reconciliation run
- out-of-order delivery is irrelevant, because nothing depends on order
- a bug in one handler corrupts one row at worst, never the total

**Reconciliation is the source of truth for both providers.** It lists payments since
`race_start_at` via the adapter, upserts qualifying customers, stamps `count_reconciled_at`,
then applies the lifecycle transition if the count crossed 10.

This design is what makes Lemon Squeezy viable at all. Its webhooks are merchant-configured and
can be absent or removed; because correctness never rests on them, a Lemon Squeezy racer with
no webhooks is slower to update and **never wrong**. Webhooks — from either provider — are a
latency optimisation on top of a system that is already correct without them.

---

## 11. Race lifecycle / state machine

| From | Trigger | To | Guard |
|---|---|---|---|
| — | `/join` submitted | `registered` | unique email; provider chosen |
| `registered` | connection verified | `racing` | `connect_state` valid; §9 write completes in order |
| `registered` | state expires | `registered` (stale) | recoverable; row re-claimable |
| `racing` | count reaches 10 | `won` | `UPDATE … WHERE id=? AND status='racing'` |
| `racing` | `race_end_at` passes, count < 10 | `expired` | same conditional shape |

**Connection sub-state**, independent of `status`: `pending → connected → unavailable →
connected`. It never changes `status`, applies identically to a revoked Stripe connection and
an expired Lemon Squeezy key, and the second of those is **expected, not exceptional** — it
needs a real re-connect path, not an error page.

**Derived on read.** Pages compute effective status from `race_end_at`. Scheduled jobs only
persist the transition and write the `race_event` row. A late or missed job produces a late
event, never a wrong page.

**Deadline semantics.** 14 × 24 hours, so no timezone edge. A payment at or after `race_end_at`
does not count, even by a second. If the 10th customer and the deadline collide, the
conditional update resolves it — whichever transaction commits first wins, once.

---

## 12. Sponsor lifecycle / state machine

Two different things live here, and conflating them is what made the previous model unable to
rotate.

**A position has no lifecycle.** It is one of ten, permanently. It is *free* when no confirmed
sponsorship covers the current instant, and *occupied* otherwise — both derived from a query,
neither stored. There is nothing to expire and nothing to go stale.

**A sponsorship moves through four states:**

```
   ——— start checkout ———►  pending  ——— payment confirmed ———►  confirmed
                              │                                      │
                              │  hold expires (30 min), unpaid       │  ends_at passes
                              ▼                                      ▼
                           cancelled                              expired
                        (position released)                 (position free again)
```

| From | Event | To | Guard |
|---|---|---|---|
| — | sponsor starts checkout | `pending` | the position is free right now (§13) |
| `pending` | payment confirmed | `confirmed` | webhook; idempotent on the session id |
| `pending` | hold expires, unpaid | `cancelled` | sweep; releases the position |
| `confirmed` | `ends_at` passes | `expired` | sweep; releases the position |

**Visibility never reads `status`.** It is `now() >= starts_at AND now() < ends_at`. `expired`
is written by the cron job so Realtime subscribers receive an event — but no correctness
depends on it. A job that never ran would leave the flag stale and the display still right.
Same principle as race status.

**Every transition is an idempotent conditional update**, so re-running the sweep changes
nothing.

**What is gone:** `held`, `version`, takeover pricing, and the whole stale-price refund path.
There is no incumbent to displace, so there is no displacement to compensate — which removes
the most delicate money-handling code in the previous design rather than porting it.

---

## 13. Pending payment hold

**Problem it solves:** two sponsors both start checkout on the same free position at the same
moment. Without a hold they both pay, and one has bought a term on a position someone else is
already holding.

Note what changed: this is no longer about shielding anyone from a *takeover penalty*. It is
plain first-come-first-served on a fixed-price booking.

**Mechanism.** The hold is a `pending` sponsorship row, not a flag on the position. The
exclusion constraint does the work — a second overlapping booking simply cannot be inserted:

```sql
insert into sponsorship
  (slot_id, status, term_days, starts_at, ends_at, hold_expires_at, price_cents, …)
values
  ($slot, 'pending', $term, now(), now() + term_interval,
   now() + interval '30 minutes', $price, …);
-- exclusion violation (SQLSTATE 23P01) ⇒ the position is not free right now.
-- Nothing else needs checking: the constraint has already settled it.
```

No `SELECT … FOR UPDATE`, no read-then-write. The database refuses the second booking, which
is a stronger guarantee than application code remembering to look.

**Release paths.** The sweep in `cron/reconcile` cancels expired holds. The webhook confirms
on success. An abandoned Checkout expires on Stripe's side and the sweep catches it next pass.

**One rough edge, stated plainly.** A stale `pending` row still blocks a genuine buyer until
the sweep runs, because the exclusion constraint cannot reference `now()` (it is not
immutable, so it cannot appear in a partial index). So the Server Action cancels stale holds
on that position inside the same transaction, immediately before inserting — rather than
relying on the sweep being prompt. Without that, a sponsor who abandoned checkout at 10:00
could block a real customer until the next cron tick.

**Visible state.** `pending` is real and user-visible, and it must not be shown as "Open" —
that would be false while a purchase is in flight. Its wording is **not yet specified by the
design system**; see §24.

---

## 14. Sponsor Checkout and term purchase flow

Stripe only. No adapter, no provider branching — one processor on our own account.

```
sponsor picks a term ──► Server Action
  1. validate input (§19) — including the destination link and logo URL
  2. read the price for that term from sponsor_pricing     ← never from code or copy
  3. cancel any stale pending holds on this position
  4. insert sponsorship (status 'pending', term, hold_expires_at = now + 30 min)
     └─ exclusion violation ⇒ the position is not free; stop and say so
  5. insert sponsor_payment (status 'pending', price_expected_cents = the price)
  6. stripe.checkout.sessions.create({
       mode: 'payment',
       line_items: [{ price_data: { unit_amount: price, currency: 'usd' } }],
       metadata: { sponsorship_id, sponsor_payment_id },
       success_url, cancel_url
     }, { idempotencyKey })
  7. redirect to session.url
```

**No `slot_version` in the metadata any more.** It existed to detect a payment priced against
stale takeover state. Prices are fixed and read from the table at purchase time, so there is
no stale price to detect.

**On payment confirmation**, one locked transaction:

```
1. look up the sponsorship from the session metadata
2. already confirmed? ⇒ return 200, nothing to do   (idempotent on the session id)
3. sponsorship → confirmed;   ends_at = starts_at + term
4. sponsor_payment → paid
5. commit
```

No incumbent, no refund, no version comparison. The "who was here first" question was settled
at step 4, by the exclusion constraint, **before any money moved** — which is the whole point
of settling it there.

### Refunds — what V1 does, and deliberately does not

**No cash refunds after activation.** A sponsor who bought a placement, received it, and
changed their mind is not refunded.

**A platform-side failure that prevented the placement being displayed is compensated in
kind:** a time extension covering the affected period, or account credit. Not cash, and no
pro-rata arithmetic.

Both are recorded rather than applied ad hoc, so there is a durable reason attached to any
window that moved:

```
sponsorship_adjustment
  id, sponsorship_id, kind ('extension' | 'credit'),
  days_added, credit_cents, reason, created_at
```

**An extension has one sharp edge.** It pushes `ends_at` later, and if the position has since
been booked by someone else, the extension would overlap their term — so the exclusion
constraint will *reject* it. That is the one place where the constraint blocks a legitimate
operation, and it means an extension must check for a following booking and either take the
remaining gap or move the compensation to credit. Not a bare `UPDATE`.

**Credit has nowhere to live yet.** A sponsor is not an account — they are an email address
and a payment. Recording that credit is owed is easy; *redeeming* it needs an identity to
redeem against, which V1 does not have. Flagged in §24 rather than invented.

**Provider disputes** remain with the provider's dispute system, as before. No cash-refund path
of our own means no refund racing, and no `refund_status` state machine to keep correct.

---

## 15. Webhook architecture

**Three endpoints, three secrets, two payment systems.**

| Endpoint | Secret | System | Handles |
|---|---|---|---|
| `webhooks/stripe/platform` | `STRIPE_WEBHOOK_SECRET` | sponsor payments | `checkout.session.completed`, `charge.refunded`, `charge.dispute.created` |
| `webhooks/stripe/connect` | `STRIPE_CONNECT_WEBHOOK_SECRET` | racer verification | payment events, `account.application.deauthorized` |
| `webhooks/lemonsqueezy` | merchant-supplied secret | racer verification | `order_created`, `subscription_created`, `subscription_payment_success`, `customer_updated` |

The sponsor and racer Stripe endpoints stay separate even though they share an account:
compromising the sponsor processor must not also expose every racer's connected-account events.

**Signature verification differs per provider** and the adapter owns it — `Stripe-Signature`
for both Stripe endpoints, `X-Signature` (HMAC-SHA256) for Lemon Squeezy. Both must be computed
over the **raw** body.

**Body handling.** Read the body **once**, as text — `await request.text()` yields exactly the
bytes that were signed. There is no `bodyParser` config in the App Router. Clone the request if
the body is needed twice.

**Three-layer idempotency:**

1. **Raw body** — verify the signature; mismatch ⇒ 400.
2. **Ledger** — `INSERT INTO provider_event … ON CONFLICT DO NOTHING`. No row returned ⇒
   duplicate ⇒ return 200 immediately. `processed_at` is set **only after** the work succeeds,
   so a crash mid-handler leaves it NULL and the retry re-processes rather than the event being
   silently dropped forever.
3. **Idempotent writes** — the unique constraints in §5 make re-processing *harmless*, not
   merely unlikely. This layer, not the ledger, actually guarantees correctness.

**Always return 200 for handled-and-irrelevant events.** A 4xx/5xx makes the provider retry for
days. Return non-2xx only when our own work failed.

**Never log full payloads.** Connect and Lemon Squeezy payloads both carry customer PII.

**The Lemon Squeezy endpoint may receive nothing, ever.** Its webhooks require the merchant to
configure them by hand, and they can be removed at any time. This is designed for: correctness
rests on reconciliation (§10), and this endpoint is an optimisation that may simply never fire.
It must not be treated as a required part of the system in code review or on-call.

**Matcher.** Every `/api/*` path is excluded from `proxy.ts` (§2) so bodies are never buffered
or truncated by the proxy's 10 MB cap.

---

## 16. Real-time update architecture

**Realtime is a signal, not a data source.** The client subscribes, then re-renders from
Postgres. It never patches local state from a pushed payload. One source of truth, and a
dropped socket self-heals on the next render rather than leaving the UI quietly wrong.

Published tables: `sponsorship`, `race_event`. Nothing else. `racer`, `waitlist_signup`,
`sponsor_payment`, `sponsor_daily_stat` and `sponsorship_adjustment` are never published.

`sponsorship` rather than `sponsor_slot`: the position row never changes after seeding, so
publishing it would push nothing. What changes is *which sponsorship is live* — and that
changes when a booking is confirmed, cancelled, or expires.

Realtime respects RLS, so `anon` needs `SELECT` on the subscribed table — another reason the
client reads views rather than base tables.

**Subscription shape.** A small client component subscribes, debounces, and calls
`router.refresh()`. Confirming a sponsorship writes the booking and the payment together, so
the debounce matters — two refreshes per event is wasteful on bars that appear on every page.

**An expiry pushes nothing by itself, and this is the one place the derived-liveness principle
is not self-sufficient.** A sponsorship ending changes no row, so Realtime emits nothing and
the bar would keep showing the old sponsor until something unrelated caused a refresh. The
cron sweep writing `expired` is what produces the event. Display stays correct either way —
the view filters on time — but *freshness* depends on that job running.

**Server-side revalidation.** Webhook handlers run outside React, so they revalidate with
`revalidateTag(tag, { expire: 0 })`. Note the Next.js 16 signature change: the single-argument
form is deprecated and the second argument is required. `updateTag` is **not** available in
Route Handlers.

---

## 17. Visitor globe / activity architecture

```
proxy.ts (Node runtime, excluding api/*, _next/*, static)
  ├─ read request geolocation headers (country, city, latitude, longitude)
  ├─ drop bots, our own traffic, and prefetches
  └─ event.waitUntil( insert into visit )      ← never blocks the response
        │
        ├─► <Globe />          markers at real coordinates
        └─► <ActivityFeed />   real recent rows
```

**Real coordinates, real country.** A static SVG world path with an equirectangular projection
computed in the component — no map library, since a dependency buys nothing here.

**Privacy.** Geo only. **No raw IP is ever stored**, and no per-visitor identifier survives past
24 hours. The minimum that satisfies the honesty rule without accumulating personal data.

**Empty is acceptable; fake is not.** A globe with three dots is correct. A globe with a hundred
invented ones is the exact failure the honesty rule names.

**Feed wording** is deferred (`SYSTEM-ARCHITECTURE.md` §13). The spec's pseudonymous phrasing
sits uneasily beside an honesty rule requiring real names; **country-only phrasing is the
recommendation** pending a product decision.

---

## 18. Environment variables and secrets

Public — safe in the browser bundle:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | RLS-constrained reads |
| `NEXT_PUBLIC_APP_URL` | absolute URLs for OAuth redirect + Checkout return |

Server only — **never** `NEXT_PUBLIC_`, never in a client component, never logged:

**Platform / shared**

| Variable | Purpose |
|---|---|
| `SUPABASE_SECRET_KEY` | service-role writes; bypasses RLS |
| `CRON_SECRET` | authenticates scheduled jobs |
| `PROVIDER_CREDENTIAL_KEY` | envelope-encrypts stored Lemon Squeezy credentials before Vault |

**Stripe — sponsor payments**

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Checkout Sessions and refunds on our account |
| `STRIPE_WEBHOOK_SECRET` | verifies the platform endpoint |

**Stripe — racer verification**

| Variable | Purpose |
|---|---|
| `STRIPE_CONNECT_CLIENT_ID` | builds the OAuth authorize URL |
| `STRIPE_CONNECT_CLIENT_SECRET` | OAuth token exchange |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | verifies the connect endpoint |

**Lemon Squeezy — racer verification**

None. There is deliberately **no `LEMONSQUEEZY_API_KEY`**. Lemon Squeezy credentials are
per-merchant, supplied at runtime by each racer, and never belong to us — a platform-level key
would mean holding a credential that can act on a merchant's store without them.

No Lemon Squeezy variable exists for sponsor payments either, because those are not in V1.

`src/lib/env.ts` parses and validates all of these at boot and **fails loudly on a missing or
malformed value**, rather than letting `undefined` reach a payment call at 2am. Today
`.env.local` holds only the two public Supabase values.

No real key, token, or secret — not even a placeholder that looks real — appears in this
document, in either spec, or anywhere else in the repository.

---

## 19. Validation strategy

Validate at the boundary, with `zod` schemas in `src/lib/validation/`, shared between the
Server Action and any form that mirrors them.

| Input | Rules |
|---|---|
| Waitlist email | valid, lowercased, unique, rate-limited, honeypot field |
| Racer name / handle | required, length-capped, trimmed |
| Racer email | valid, lowercased, unique; repeat submit returns "already joined", not an error |
| Verification provider | must be one of the registered adapters; unknown ⇒ reject |
| Lemon Squeezy credential | non-empty, validated against the provider API before being stored; **rejected if it cannot be validated**; encrypted before it touches the database; never echoed back, never logged, never included in an error response |
| Sponsor email | valid, lowercased. *(The old "must not match the current holder" guard existed only to stop a sponsor outbidding themselves to fake a price run-up. No escalation, nothing to game.)* |
| Company name | required, length-capped |
| Slot description | required, **hard cap 60 characters**, enforced server-side; live counter in the form |
| Destination link | must parse as an absolute `http(s)` URL — reject `javascript:` and protocol-relative |
| Logo upload | PNG / JPEG / WebP only. **SVG rejected outright** — XSS vector on a page rendering sponsor-supplied content. Magic-byte check, not just `Content-Type`. 512 KB cap. Storage path from a server-side UUID; a client filename is never trusted |
| Position id | must be one of the ten positions, **and free right now**. The second half is enforced by the exclusion constraint, not by this check — a validation rule that drifted would otherwise let a double-sale through |
| Term | must be one of 1, 3, or 7. The price is then **read from `sponsor_pricing`**, never sent by the client and never computed |

Validation is **server-side regardless of client validation**. Client validation is a
convenience, never the guard.

---

## 20. Error handling

The rule: **fail loudly server-side, vaguely client-side, never silently.**

| Layer | Behaviour |
|---|---|
| Server Action | Typed result (`{ ok: false, reason }`) for expected failures — **position not free**, invalid input, **credential rejected by the provider**. Throw only for genuine bugs |
| Stripe calls | Wrapped; on failure the payment row records the failure rather than vanishing |
| Connect callback | Expired or reused `code` ⇒ recoverable "start again", never a stuck racer row. `access_denied` ⇒ treated as a normal user choice |
| Lemon Squeezy validation | Invalid credential ⇒ rejected before storage, with a message the racer can act on |
| Webhook | Signature failure ⇒ 400. Handler failure ⇒ 5xx (retry wanted) with `processed_at` NULL. Handled-but-irrelevant ⇒ **200** |
| Platform failure | A placement that was paid for but not displayed ⇒ recorded in `sponsorship_adjustment` as time or credit. Never silently absorbed |
| Connection lost | `connection_state = 'unavailable'`; the page states it plainly and offers re-connect |
| Client | A short, honest message. Never a provider error, never a stack trace, never a secret |
| Missing env | Boot-time failure via `src/lib/env.ts`, not a runtime `undefined` |

**Never surface a raw provider error to a user** — it can leak account and configuration
detail, and Lemon Squeezy errors can echo credential context. Log server-side, show the user
plain language.

---

## 21. Testing strategy

Test-first for the money and counting paths; smoke tests elsewhere.

**Unit — pure logic, no network:**
- Prices are **read from `sponsor_pricing`, never computed**. A test asserts no price literal
  exists in UI or business logic — the launch prices are data
- Term arithmetic: `ends_at = starts_at + term` across 1, 3, and 7 days
- The "free right now" predicate: free, occupied, and both boundary instants
- The count predicate against fixtures: baseline member pays again, guest checkout, payment
  exactly at `race_end_at`, payment one second after `race_start_at`
- Description cap boundary at 60 characters

**Adapter contract tests — the same suite for every adapter, against a fake provider:**
- `beginConnection` / `completeConnection` round-trip
- `listCustomers` returns `ExternalCustomer` with stable ids and `createdAt`
- `listPayments` returns `ProviderPayment` ordered and bounded by the window
- `verifyWebhook` accepts a valid signature and rejects a tampered one
- Capability declarations match what the adapter actually does

This suite is what proves the portability claim. A third provider should be addable without
touching `engine/`.

**Integration — real provider test modes and a test database:**
- **Replay the same webhook three times**; assert the customer count and refund count are
  unchanged. Highest-value test in the suite.
- **Two overlapping bookings on one position ⇒ the second is refused by the exclusion
  constraint.** The sponsor-side counterpart of the replay test, and the one that protects
  the inventory from ever being double-sold
- Concurrent checkout on one position ⇒ the second is told it is not free, and no second
  payment is taken
- An expired hold releases the position; a confirmed booking does not
- `ends_at` passing frees the position with **no row written** — the derived-liveness claim,
  tested rather than asserted
- Baseline ordering: a customer created *during* the snapshot is counted, not lost
- Race end: a payment after `race_end_at` does not count
- `won` transition twice ⇒ single transition
- Connection lost ⇒ `unavailable`, `status` unchanged; re-connect restores `connected`
- **Lemon Squeezy with webhooks never configured ⇒ counts still correct via reconciliation**
- Invalid Lemon Squeezy credential ⇒ rejected, nothing stored

**Manual, once, before launch:**
- End-to-end per provider: connect → race → win → expire
- Stripe CLI event resend against both Stripe endpoints
- Confirm no server secret appears in the client bundle
- Confirm no credential is recoverable from logs

**Not in V1:** E2E browser automation, visual regression, load testing.

---

## 22. Deployment architecture

| Concern | Approach |
|---|---|
| Host | Vercel. Next.js 16 with **Turbopack** — a webpack config fails the build, so none is added |
| Node | 20.9+ required by Next.js 16 |
| Functions | Default Node.js runtime. **No `runtime = 'edge'`** — deprecated and unsupported in `proxy.ts` |
| Scheduled jobs | `cron/race-lifecycle` and `cron/reconcile`, authenticated by `CRON_SECRET`. Correctness does **not** depend on their frequency |
| Migrations | Supabase CLI, versioned in `supabase/migrations/`, applied before the deploy that needs them |
| Types | Supabase type generation wired into the build so schema drift is a compile error |
| Secrets | Vercel env vars, server-scoped |
| Headers | CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS via `next.config.ts`. No inline styles required, so a strict CSP is achievable |
| Images | `images.remotePatterns` for the Supabase storage host. `images.domains` is deprecated in Next 16 |
| `next/image` | `priority` is deprecated — use `preload` |
| **Lemon Squeezy credential expiry** | An **operational** task, not just code: expiring credentials surface as `connection_state = 'unavailable'` and only the merchant can replace them. Needs a detection job and a re-connect path before launch |

---

## 23. Implementation order

Each step is independently verifiable before the next depends on it.

| # | Step | Verified when |
|---|---|---|
| 1 | **Resolve the two blocking decisions** (§24) | recorded before `/join` is built |
| 2 | Design tokens in `globals.css`; fonts; remove `prefers-color-scheme` | dark-only, no raw hex |
| 3 | `ui/` primitives + inline SVG logo + favicon | renders at 16px |
| 4 | `src/lib/env.ts` + `proxy.ts` with the correct matcher | boot fails loudly on a missing var; all `api/*` excluded |
| 5 | **Migrations**: tables, unique constraints, RLS, public views, 10 slot seeds | `anon` **verified** unable to read a private column |
| 6 | Supabase type generation in the build | types match schema |
| 7 | **`verification/types.ts` + adapter contract test suite** | the suite exists and fails for a stub adapter |
| 8 | **Stripe adapter** against the contract suite | passes with a fake provider |
| 9 | `/` landing: hero, live count, how-it-works, waitlist | renders a real `0` honestly |
| 10 | Sponsor bars + `SponsorSlotCard` (done) | all 10 render from live sponsorship data |
| 11 | **Sponsor schema rework** (done) — positions / `sponsorship` / `sponsor_pricing`, the exclusion constraint, then `/sponsor` grid + term modal + hold. **No payment provider** | two overlapping bookings on one position ⇒ the second is refused; prices come from the table |
| 12 | Impression and click tracking. **No payment provider** | a real impression and a real click each increment exactly once |
| 13 | Stripe Checkout Session creation + platform webhook + sponsorship confirmation | reaches Stripe **test** Checkout, and replay ×3 changes nothing |
| 14 | `/join` form + provider choice + Stripe OAuth with `state` | round-trips in test mode; expired code recovers cleanly |
| 15 | OAuth callback + the ordered baseline write (§9) | baseline set written before `race_start_at` |
| 16 | Connect webhook + reconciliation + count derivation | **replaying an event doesn't move the count** |
| 17 | Cron: lifecycle + reconcile + pending sweep | a cleared `processed_at` self-heals |
| 18 | **Lemon Squeezy adapter** against the same contract suite | passes unchanged — no `engine/` edits required |
| 19 | Lemon Squeezy connection flow + Vault storage | credential encrypted; never recoverable from logs |
| 20 | Lemon Squeezy reconciliation path | counts correct **with webhooks never configured** |
| 21 | Realtime wiring | the bar updates without a reload |
| 22 | Globe + activity feed from real `visit` rows | empty-but-real is acceptable |
| 23 | Security headers, rate limits | CSP passes |
| 24 | Full test-mode pass per §21, both providers | every failure mode exercised |

**Step 18 is the real test of the architecture.** If adding Lemon Squeezy requires changes
under `engine/`, the abstraction was not real and steps 7–8 need revisiting before proceeding.

Steps 12, 13, and 16 are tested by **deliberate replay**, not by happy path.

---

## 24. Consistency review — findings and resolutions

A full pass over all three documents. Findings are listed with what was done; the ones needing
a product decision are recorded in `SYSTEM-ARCHITECTURE.md` §13 and marked **OPEN**.

### Blocking — needs your decision

| # | Finding | Status |
|---|---|---|
| 1 | **Locked copy names Stripe specifically.** `DESIGN-SYSTEM.md` line 121 subline and line 142 how-it-works step both say "connect Stripe", and both are marked *do not change without explicit approval*. Multi-provider verification makes them conditionally false for Lemon Squeezy racers. | **OPEN** — copy deliberately untouched |
| 2 | **Does Lemon Squeezy ship in the V1 UI?** The adapter is built either way; exposing it means telling racers they hand over more access than the Stripe path. | **OPEN** |

### Resolved

| # | Finding | Resolution |
|---|---|---|
| 3 | Racer model hard-coded Stripe (`stripe_account_id`, `oauth_state`, `stripe_deauthorized_at`, `stripe_event`) | Renamed provider-neutral: `verification_provider`, `provider_account_id`, `connect_state`, `connection_revoked_at`, `provider_event` |
| 4 | Baseline and count tables keyed on `stripe_customer_id` | Keyed on `external_customer_id`, opaque and namespaced by provider |
| 5 | Race engine implicitly Stripe-only | Adapter interface + capability descriptor; `engine/` forbidden from importing an adapter |
| 6 | Lemon Squeezy assumed equivalent to Stripe Connect | It is not. No OAuth, no consent screen, **no read-only scope**, merchant-configured webhooks, ~1-year credential, no date filtering. Documented in full |
| 7 | Short-description cap was 120 characters | **Changed to 60** — derived from the card's fixed 170–190 × ~90px geometry. 120 would overflow |
| 8 | Sponsor vs racer Stripe flows at risk of blurring | Capability table added; separate secrets, separate endpoints, separate adapters |
| 9 | Stripe `read_only` scope unverified | Confirmed valid, and the default for Standard accounts. **Also discovered: the `code` is single-use and expires in 5 minutes** — recovery path now specified |
| 10 | Credential storage unspecified for a full-access key | Supabase Vault; `PROVIDER_CREDENTIAL_KEY` for the envelope step; reference-only on the racer row |
| 11 | Webhook architecture assumed two endpoints | Three, with per-provider signature schemes; the Lemon Squeezy one designed to tolerate never receiving an event |
| 12 | Env vars were Stripe-only | Regrouped by provider and system; explicit note that no Lemon Squeezy platform key exists |
| 13 | `"Open · from $50"` in the design system vs a real price in the architecture | Superseded by finding 26. The label must render from `sponsor_pricing` regardless — a price literal anywhere is a defect, not a placeholder |
| 14 | Design system pinned a top mobile sponsor bar with no stacking rule against the nav | **OPEN** — recorded as a design-system gap |
| 15 | `pending` **sponsorship** state has no label — a purchase in flight, up to 30 minutes | **OPEN** — must not reuse "Open". The confirmed sponsor copy covers Open and Sponsored only |
| 16 | Slots per mobile bar unspecified (5/side fixed for desktop) | Assumed 5 and 5; recorded as a design-system gap |
| 17 | "One nav link" vs "add a sponsor entry point to the nav" | Entry point goes **near the sponsor bars**, preserving the single nav link the design system specifies |
| 18 | Waitlist described as "email capture" in one doc, "email + qualifying question" in another | Two fields; terminology aligned |
| 19 | `waitlist_stats` view semantics | Must be owner's-rights, or it renders `0` — a silent lie |

### Sponsor model reconciliation — 2026-09-25

Sponsorship was redefined as fixed-price, one-time terms instead of bidding and takeover.
Rechecked against the schema, the built components, and the design system.

| # | Finding | Resolution |
|---|---|---|
| 20 | **Positions and bookings were one row.** `sponsor_slot` held the ten positions *and* the current holder *and* the payment hold, so nothing could rotate and "more than ten lifetime sponsors" was inexpressible | Split: `sponsor_slot` is fixed inventory; `sponsorship` is a booked term. This is the load-bearing change |
| 21 | **No time dimension anywhere.** No `starts_at`, `ends_at` or term existed, so nothing could expire | `term_days` (1/3/7), `starts_at`, `ends_at` on the sponsorship |
| 22 | **The takeover machinery lost its purpose.** `version`, stale-price detection, `superseded`, refund-minus-10%, and the card-fingerprint guard all existed to arbitrate outbidding | All removed. Overlap is now impossible by an **exclusion constraint** on `(slot_id, [starts_at, ends_at))`, which settles who owns the position *before* money moves rather than trying to unwind it after |
| 23 | **Price was a mutable column on the slot**, conflating what was paid with what it costs | `price_cents` is captured on the booking; `sponsor_pricing` is the only place a price is written down |
| 24 | **No metrics of any kind** | `sponsor_daily_stat` — impressions and clicks per booking per day — incremented by a viewport beacon and a click redirect |
| 25 | **`visit` cannot answer "visitors today".** It stores no visitor identifier by design, so five views by one person are indistinguishable from one view by five | `visit.visitor_hash` — a **daily-rotating** `hash(ip + user-agent + per-day salt)`. Comparable within a day, meaningless across it, never an IP. Without it the metric must not be displayed at all |
| 26 | **The design system's sponsor copy is entirely superseded.** "Open · from $50" and "real sponsor info once sold" no longer describe the model | Confirmed copy: `Open · from $5`, `Sponsored · until {date}`, and `1 day — $5` / `3 days — $12` / `7 days — $25`. **Recorded here — the design system is not yet updated** |
| 27 | **"Online / active visitors" has no reliable source.** A `visit` row only proves someone was here when it was written | Two honest options, both flagged: derive "active in the last N minutes" from `visit` and **label it exactly that**, or use Supabase Realtime Presence for a true connected count. Presenting either as "online now" from a heartbeat-free source would be a fabricated number |
| 28 | **Refunds are gone, but platform failures are not.** A placement that was paid for and not displayed still needs making right | `sponsorship_adjustment` records an extension or credit. No cash refunds after activation |
| 29 | **"Account credit" has nothing to attach to.** A sponsor is an email and a payment, not an account | Recording that credit is owed is easy; **redeeming** it needs an identity V1 does not have. **OPEN** |
| 30 | **An extension can collide with a later booking.** Extending `ends_at` into a term someone has since bought is rejected by the exclusion constraint | An extension must check for a following booking and take the remaining gap, or fall back to credit. Not a bare `UPDATE` |
| 31 | **An expiry emits no Realtime event**, because it changes no row | The cron sweep writing `expired` supplies the event. Display stays correct without it; freshness does not |
| 32 | **A `pending` hold is invisible on the public board.** The policy publishes only `confirmed` rows — correctly, since an unpaid sponsor's name, description and link must not go live — so a held position still reads `Open · from $5` to everyone else. A second buyer who clicks it is refused honestly ("someone is buying that position right now"), so nothing is misreported, but the board does not *show* the hold §13 says it must | Making it visible needs finding 15's missing label **and** a view exposing availability without exposing the sponsor's content. Neither exists yet. **OPEN** |
| 33 | **Migrations are not applied to the live Supabase project.** Every table returns 404 to both the publishable and the secret key; the project is reachable and the keys are valid | `supabase login` + `supabase db push`. The CLI is unauthenticated, so this cannot be done from here. **BLOCKS GOING LIVE** |
| 34 | **A hold currently leads nowhere.** Step 11 creates a real reservation but there is no checkout and no contact detail is captured, so the reservation lapses 30 minutes later with no follow-up. Deliberate — checkout is step 13 — but it means the flow has no successful ending a sponsor can act on | Checkout (step 13) closes it. Until then the modal says so plainly rather than implying a purchase |

### Verified clean

- Site map, route purposes, and the `/join`-has-no-sponsor-bars rule agree across all three.
- Hero CTA, headline, and the no-form-in-hero rule agree.
- **Racer** race length (14 days) and the goal (10 customers) agree everywhere. Nothing in this
  reconciliation touched the racer model — the 14 days is the race window, not a sponsor term.
- Colour, typography, spacing, radius, and the no-shadow/no-gradient rules have no conflicts with
  anything specified here.
- The honesty rule is consistent across all three, and is what forced several of the findings
  above to be surfaced rather than smoothed over.

**Known remaining gaps**, none of which block starting:

- No decision on an admin surface, guest-checkout policy, or the globe privacy notice
  (`SYSTEM-ARCHITECTURE.md` §13).
- From this reconciliation: the `pending` sponsorship label (15), how account credit is
  redeemed (29), and whether "online visitors" is the labelled-window version or a Realtime
  Presence count (27).
- From building step 11: whether a hold is made visible on the board, and with what label
  (32), and that the live project has no schema until migrations are pushed (33).
- **`SYSTEM-ARCHITECTURE.md` §3 and the sponsor copy in `DESIGN-SYSTEM.md` still describe the
  bidding model.** They contradict this plan until updated. Left untouched deliberately, and
  listed in the accompanying report.
