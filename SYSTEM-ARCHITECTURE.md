# raceto10 — system architecture & build spec

Paste this whole file into Claude Code alongside DESIGN-SYSTEM.md. This one covers what to
build and how it works end to end; the other covers how it looks. Together they should be
enough to implement without back-and-forth.

---

## 1. Site map

| Route | Purpose |
|---|---|
| `/` | Landing page — hero, globe, how-it-works, waitlist signup |
| `/join` | Dedicated registration page for racers — the "Join the race" button goes here, not to an in-page anchor |
| `/sponsor` | The bid page — browse all 10 slots, claim or take one over |

Leaderboard and individual race pages come after launch, once races are actually running —
not part of this build.

---

## 2. Data model

**racer**
`id, name, handle, email, verification_provider (stripe | lemonsqueezy), provider_account_id, provider_credential_ref, provider_credential_expires_at, connection_state (pending | connected | revoked | unavailable), baseline_customer_count, baseline_captured_at, race_start_at, race_end_at, current_customer_count, count_reconciled_at, won_at, connection_revoked_at, connect_state, connect_state_expires_at, status (registered | racing | won | expired)`

**The racer model is provider-agnostic.** `verification_provider` selects which adapter owns
the connection; `provider_account_id` holds the connected account identifier in whatever form
that provider uses. Nothing downstream of the adapter — baseline capture, qualifying-customer
logic, the race engine, the lifecycle — may branch on this value. See §14.

`provider_credential_ref` is a **reference**, never a raw credential. Stripe grants us a
platform-held token, so it is unused there; Lemon Squeezy hands over nothing but a
full-authority API key, which is encrypted at rest in Supabase Vault and referenced by id.
No credential of any kind is ever stored in a column, a log, or a client payload.

`baseline_customer_count` is captured the instant the connection completes and is never shown
publicly — it exists purely so only customers gained *after* joining count toward the race.
Without this, someone with an existing business could join and instantly show 10/10, which
breaks the entire premise.

`baseline_customer_count` is a **denormalised convenience for display and auditing**. The
authoritative baseline is the `race_baseline_customer` row set below, and the integer must
always equal `count(*)` of that set. An integer alone cannot answer the question the premise
actually requires: when an *already-existing* customer pays again after the race starts, a
count cannot distinguish them from a genuinely new one, and they would be counted. Only the
set of customer IDs present at connect time can make that distinction. This is the single
most important integrity decision in the system.

`connect_state` carries the pending registration through the connection step. For Stripe it is
the OAuth `state` (single-use, 30 minutes, the CSRF guard on the callback); for Lemon Squeezy
there is no redirect, so it guards the credential-submission step instead. Either way it is
single-use and time-bounded — see §4 and §15.

`connection_revoked_at` and `connection_state = 'unavailable'` record that we lost the ability
to read a racer's data mid-race — the racer revoked Stripe access, or their Lemon Squeezy key
expired. This is a timestamp plus a connection sub-state rather than a `status` value, so the
four product-level statuses (`registered | racing | won | expired`) keep the exact meaning the
copy gives them, while the UI can still disclose that a connection was lost.

**race_event**
`id, racer_id, type (started | milestone | won), customer_number (nullable), created_at`
Powers both the live feed and each racer's own timeline. One row per real event, nothing
synthetic.

**race_baseline_customer**
`id, racer_id, external_customer_id, created_at`
One row per distinct customer already present on the connected account at the moment the race
started — that is, per customer the provider reports as having existed **before**
`race_start_at`. Written once, **before** `race_start_at` is set, and never modified. Unique on
`(racer_id, external_customer_id)`.

`external_customer_id` is the provider's own customer identifier, namespaced by the racer's
`verification_provider`. It is opaque to us: the race engine stores and compares it, and never
parses it or assumes a format across providers.

**race_customer**
`id, racer_id, external_customer_id, first_paid_at, provider_payment_id, created_at`
One row per distinct customer whose first successful payment landed at or after
`race_start_at`. Unique on `(racer_id, external_customer_id)`. That constraint — not a counter
— is what makes webhook replay harmless: inserting the same customer twice is a no-op, so
`current_customer_count = count(*)` is always safe to recompute from scratch.

**provider_event**
`id (the provider's event id, primary key), provider, type, account_id, received_at, processed_at`
Webhook ledger, shared by every provider and every endpoint. `id` is prefixed by provider
where the two could ever collide. `processed_at` is set **only after** the handler's work
succeeds, so a crash in between leaves it NULL and the provider's retry re-processes rather
than a real event being silently dropped. A duplicate event id is a no-op returning 200.

Both `race_baseline_customer` and `race_customer` are deliberately provider-neutral: the same
two tables serve Stripe and Lemon Squeezy racers, which is what makes the race engine
genuinely portable rather than portable in name only.

**visit**
`id, country, city, latitude, longitude, path, created_at`
Real visitor data for the globe and activity feed. Geo only — **no raw IP address is ever
stored**, and no per-visitor identifier survives past 24 hours. Bots and our own traffic are
excluded at write time, not filtered at read time.

**waitlist_signup**
`id, email, customers_now (0 | 1-5 | 6+), created_at`

**sponsor_slot**
`id, slot_number (1-10), placement (sidebar-left | sidebar-right | bar-top | bar-bottom), status (open | pending | held), current_price_cents, holder_name, holder_description, holder_logo_url, holder_link, held_since, version, pending_until, pending_session_id`

**No payment identifier or secret may live on this table.** It is published to Supabase
Realtime, and Realtime broadcasts *entire rows* to every subscriber — a `stripe_payment_id`
column here would be readable by any browser on the site. Payment identifiers belong on
`sponsor_payment` only, which is never published.

`status` gains a third value, `pending`: set the moment a Checkout Session is created and
released by a sweep once `pending_until` passes. It exists so two sponsors cannot both buy
the same slot at the same price. `pending` never blocks a takeover — a `held` slot stays
biddable at all times, exactly as the spec requires.

`version` increments on every holder change and is the concurrency token the webhook uses to
detect a payment that was priced against slot state which has since moved.

**sponsor_payment**
`id, slot_id, sponsor_email, amount_cents, price_expected_cents, stripe_payment_id, stripe_payment_intent_id, stripe_session_id, status (pending | paid | abandoned | superseded), refund_status (none | pending | refunded | failed), stripe_refund_id, refund_amount_cents, refunded, refunded_at, created_at`
One row per attempt at a slot, including ones that later got taken over — this is the full
history of who's held each slot and for how much, and it's worth keeping even after a slot
changes hands, since "this slot has changed hands 4 times, current price $280" is itself
good, real content for the page later.

`refund_status` is load-bearing, not bookkeeping. `stripe.refunds.create` is **not**
idempotent — a retried webhook will happily refund the same payment twice. The refund is read
and written under the same row lock that guards the takeover, is skipped unless the status is
`none`, and carries a Stripe idempotency key derived from the payment intent so concurrent
duplicates collapse. Failed refunds land in `failed` and require a human — see §10.

`status = 'superseded'` marks a payment refunded **in full, with no fee**, because the slot
was re-priced underneath it. That is a different situation from being outbid and is treated
differently — see §3.

---

## 3. Sponsor / bid mechanics (`/sponsor`)

**Payment provider: Stripe Checkout, and only Stripe Checkout, in V1.** Sponsors pay *us*
directly for inventory we own — this is an ordinary one-time payment into our own account, not
a connected-account flow and not a verification flow. It shares no code path, no credential, and
no webhook endpoint with racer verification (§4, §14).

Lemon Squeezy is retained as a **future fallback sponsor processor** only, for the case where
Stripe onboarding is unavailable to us. It is not implemented in V1. If it is ever added it
becomes a second adapter on the *same* sponsor interface, and the same rule applies: sponsor
payments stay strictly separate from racer verification.

**Starting price:** $49 per slot, first claim.

**Takeover pricing:** each time someone takes an already-held slot, the new price is the
current price **+50%**, rounded to the nearest dollar. Not a full double — Vanshika's
dress auction doubled ($350→$700→$1,400) because the audience and stakes were crypto-event
scale; ours starts much smaller, so a full double would price out a second bidder almost
immediately and kill the mechanic instead of creating a real bidding story. +50% keeps it
climbing fast enough to be genuinely interesting to watch without being a one-shot novelty.

**All 10 slots full — what happens:** nothing extra needs building. Every slot is always
biddable — "open" just means the starting price applies, "held" means the current price is
the takeover price. A business that wants in when all 10 are held simply pays to take over
whichever slot they want. This is the entire answer to "what if it's all booked" — the
takeover mechanic already covers it, no waitlist or 11th slot needed.

**Refund on takeover:** the outbid sponsor is refunded automatically, minus a 10% fee (same
shape as the dress auction: "if outbid, you're refunded minus the fee"). Triggered by the
Stripe webhook the instant a new payment for that slot succeeds. At $49 that is a $44.10
refund; note that Stripe's own processing fee is **not** returned on a refund, so the retained
$4.90 nets roughly $3.18. The mechanic is sound, the margin is thin, and it improves at higher
takeover prices.

**Refunds must be exactly-once.** The whole takeover — insert the new payment, refund the
incumbent, flip the holder — runs inside a single transaction holding a row lock on the slot.
The refund is issued only when `refund_status = 'none'`, is written back as `refunded` with
its `stripe_refund_id` before the transaction commits, and carries an idempotency key derived
from the payment intent. A retried or duplicated webhook therefore cannot produce a second
refund. A refund that *fails* (insufficient balance, expired refund window, dispute already
filed) lands in `refund_status = 'failed'` and needs a human — see §10.

**Claim flow:**
1. Sponsor picks an open or held slot on `/sponsor`
2. Form: product/company name, a two-line description (**hard cap 60 characters**, enforced
   server-side and shown as a live counter in the form), logo upload, destination link, email.
   The cap is 60, not 120, because it has to physically fit the card `DESIGN-SYSTEM.md`
   specifies: ~170–190px wide, ~90px tall, carrying an icon, a name, and the description. At
   the small type size that is roughly two lines of about 24–28 characters. A 120-character
   string would run to four or five lines and overflow the card the design system has already
   fixed. The cap is derived from the card, not chosen freely — if the short description ever
   needs to be longer, the card has to change first.
3. **Slot is held for 30 minutes** while the sponsor completes payment: a single conditional
   update flips `open → pending` and stamps `pending_until` and `pending_session_id`. If that
   update affects zero rows, another session already holds the slot and the sponsor is told so
   before reaching Stripe. A sweep returns expired `pending` slots to `open`. This is what
   stops two sponsors paying $49 for the same slot simultaneously — a case the takeover
   refund rule would otherwise punish with a 10% fee for doing nothing wrong.
4. Stripe Checkout for the current price — this is a normal one-time payment, **not** a
   Stripe Connect/OAuth flow. Sponsors are paying us; they are not granting us access to
   anything of theirs. Don't build this as a connection — it's a checkout.
5. On webhook success: the slot's current `version` is compared against the `version` the
   session was priced at. If they match, the slot flips to held, the previous holder (if any)
   is refunded per above, and the sponsor bar on every page updates from the same real data
   instantly.
6. **If the versions do not match**, the slot was re-priced or taken while this sponsor was
   paying. They are refunded **in full with no fee** and recorded as `superseded`. They were
   not outbid — they were unlucky — and charging them 10% for it would be wrong.

**Abuse guard:** a sponsor cannot take over their own slot to fake a price run-up — check
email/payment-method against the current holder's record and block it. Card fingerprint
(`payment_method_details.card.fingerprint`) is the reliable comparison, since it is stable
across a card even when the email address changes; email is a fallback, not the primary check.

---

## 4. Racer registration & race mechanics (`/join`)

**Verification providers.** A racer connects whichever payment provider they actually sell
through. Stripe and Lemon Squeezy are both supported, via adapters behind one interface (§14).
The two are **not** equivalent, and the product must never imply they are — see §15.

**Claim flow:**
1. Name, handle, email, and **choice of provider**. A `racer` row is created with status
   `registered`, `verification_provider` set, and a single-use, 30-minute `connect_state`
   token **before** any connection work begins.
2. Connect the provider. Racers are letting us read their data and paying nothing, so this is
   the opposite direction from the sponsor flow above — keep the two visually and technically
   distinct so it is never ambiguous which kind of "connect" a button means. What actually
   happens here differs per provider: Stripe redirects to a consent screen and returns a
   read-only authorization code; Lemon Squeezy has no consent screen at all and the racer
   pastes a credential instead. The adapter owns that difference; the page must describe it
   honestly rather than showing one generic "Connect" button.
3. **The connection result is verified against the pending `registered` racer and consumed; a
   mismatch or an expired token aborts.** For Stripe this is the OAuth `state` on the callback
   — mandatory, and it is the CSRF guard. For Lemon Squeezy it guards credential submission.
4. The connection is exchanged for a `provider_account_id` (and, for Lemon Squeezy, an
   encrypted credential stored in Vault). Then, **in this exact order**:
   - `race_start_at = now()` is written **first**
   - the baseline is snapshotted into `race_baseline_customer`, one row per existing customer,
     and `baseline_customer_count` is set from it
   - `race_end_at = race_start_at + 14 days`, status → `racing`
   - a `race_event` row of type `started`

   The ordering is the mechanism, not a style choice. Writing `race_start_at` before listing
   means a customer created *during* the snapshot is still captured correctly as a new
   customer. Writing it after would leave them in neither the baseline nor the counted set.
   No payment may be processed between these steps, and nothing else may write to the racer
   row until they complete.
5. Payment events arrive from the provider (where the provider supports webhooks at all — see
   §15), and a scheduled reconciliation job re-derives the count from scratch by reading the
   provider's API. The reconciliation job is the source of truth for both providers; webhooks
   are only an accelerator.

**What counts as a customer.** A distinct customer on the connected account whose **first
successful, non-zero payment lands at or after `race_start_at` and strictly before
`race_end_at`**, and whose customer id is **not** in `race_baseline_customer`. Written in
provider-neutral terms on purpose — this definition is identical for Stripe and Lemon Squeezy,
and is defined once, here, so the webhook and the reconciliation job can never disagree:

- **A customer already in the baseline never counts**, no matter how many times they pay
  during the race. This is the case an integer baseline cannot handle and the reason the
  baseline is stored as a set.
- **A customer counts once.** Repeat payments, renewals, upgrades and additional purchases do
  not add to the count — `first_paid_at` is what matters, and `race_customer` is unique on
  `(racer_id, external_customer_id)`.
- **Payments at or after `race_end_at` do not count**, even by seconds. The race is 14×24
  hours from `race_start_at`, which makes it timezone-independent — there is no local
  midnight to argue about.
- **Refunds and chargebacks do not remove a counted customer.** The count is a record of a
  real customer who really paid. A refund afterwards is a business outcome, not an erasure of
  the event, and the rule that a finished race "stays visible permanently as their proof" only
  holds if the number cannot move backwards afterwards.
- **Guest checkouts — a successful payment with no customer record on the provider — do not
  count.** They have no stable identity to deduplicate on, so counting them risks counting the
  same person repeatedly. This is a real product decision and is flagged in §13. It applies to
  both providers, though the frequency differs substantially between them.

**The count is derived, never incremented.** `current_customer_count = count(*)` of
`race_customer`, the set of distinct post-start customers not in the baseline. No code path
does `current += 1`. Re-running reconciliation any number of times, in any order, after any
crash, produces the same answer. A webhook handler that crashes mid-way is repaired by the
next reconciliation run rather than permanently corrupting the number — the failure mode an
incrementing counter cannot survive. Every write into `race_customer` is an insert guarded by
the unique constraint, so a replayed Stripe event is a no-op.

**At day 14:**
- `current_customer_count >= 10` any time before the deadline → status `won`, timestamp
  locked in, entry stays visible permanently (this is their proof, it doesn't get archived
  or hidden later). The transition is a single conditional update —
  `... where id = ? and status = 'racing'` — so if two customers land at the same instant the
  second is a harmless no-op rather than a double transition.
- Deadline passes under 10 → status `expired`, not "failed" — keep the language neutral,
  the data itself (X/10 in 14 days) tells the real story without needing a harsher label.

**Status is derived, not trusted.** Read paths compute the effective status from
`race_end_at`; the scheduled job only *persists* the transition and writes the `race_event`
row. A job that runs late — or not at all — therefore produces a late event, never a wrong
page. This matters because scheduled-job frequency is a hosting-plan constraint, and
correctness must not depend on it.

**If we lose the ability to read a racer's data** — the racer revokes Stripe access, or their
Lemon Squeezy credential expires — `connection_revoked_at` is stamped,
`connection_state` becomes `unavailable`, and the racer's page states plainly that the
connection was lost and the count stopped. It must never render a frozen number as though it
were live — that is exactly the kind of quiet fiction the honesty rule exists to prevent.

**Note that this failure is routine for Lemon Squeezy, not exceptional.** Lemon Squeezy
credentials expire after a year and only the merchant can replace them, so `unavailable` is a
state that will genuinely occur. It needs a real re-connection path, not an error page.

---

## 5. Page-by-page build notes

### `/` — landing page
Exactly the structure already locked in DESIGN-SYSTEM.md. One addition: the "Join the race"
button in the hero links to `/join`, it does not scroll to an in-page form — there is no
form on the homepage anymore, signup there is only the waitlist email capture, further down,
clearly distinct from the real `/join` flow.

Add a second, smaller entry point somewhere in the nav or near the sponsor bars: a "Get a
sponsor slot" link to `/sponsor`, so businesses have an obvious way in without needing to
find it by accident.

### `/join`
Single-purpose page: short recap of the rules (14 days, connect Stripe, that's it), the
3-field form, the Connect Stripe button. No sponsor bars on this page — remove the
distraction, this page has one job.

### `/sponsor`
Grid of all 10 slots (desktop: 5x2 or 2x5, whatever reads cleanest at the sidebar card size
from DESIGN-SYSTEM.md; mobile: single column, scrollable). Each slot shows current
status/price live. Clicking an open or held slot opens the claim flow above in a modal, not
a separate page — keep the whole bid-and-pay loop in one place.

---

## 6. Logo

Concept: the digits "10" where the 0 is replaced by a circle with a partial progress arc
inside it, in the accent color — literally "racing toward 10," specific to this product
rather than a generic mark. Render as inline SVG (not an image asset), stroke-based, no
fill except the accent arc, so it stays crisp dark-mode and scales cleanly to favicon size.
This replaces the current placeholder triangle-in-circle everywhere it appears (nav, favicon,
any share-card image).

---

## 7. Integrity rules that touch the backend, not just the copy

- The baseline must be captured **as a set of customer ids**, and `race_start_at` must be
  written **before** that snapshot is taken — this is the single most important write in the
  whole system, since it's what makes "10 customers" mean "10 new customers," not "10
  customers, some of which existed already." A count alone cannot enforce that distinction;
  the set can.
- Every number rendered anywhere — waitlist count, sponsor slot price, race progress, globe
  visitor count — reads from these tables directly. No hardcoded placeholder ever ships to
  production, including during early testing with a small real user base.
- No counter is ever incremented. Every derived number is recomputed from immutable rows, so
  a replayed event, a retry, or a crash cannot make the number wrong.
- Money-moving operations (takeover refunds) are guarded by a row lock, a status check, and a
  Stripe idempotency key. A duplicated webhook must not be able to move money twice.

---

## 8. Security & row-level security model

RLS is **row**-level, not column-level. Several tables must be publicly readable in part while
withholding specific columns — `racer.email`, `racer.provider_account_id`,
`racer.provider_credential_ref`, `racer.baseline_customer_count`,
`sponsor_payment.sponsor_email`. Granting `SELECT` on the table would grant those columns too.

**Public views, not column-level grants.** Postgres column privileges are supported, but
Supabase's own guidance notes they are an advanced feature and that a restricted role then
loses the wildcard `*` — which breaks ordinary `.select('*')` calls. Views are simpler and
keep the query surface ordinary:

- `sponsor_slot_public` — every column except any payment identifier (§2 keeps that table
  clean anyway, because Realtime publishes whole rows to every subscriber)
- `racer_public` — id, name, handle, status, progress, timestamps. Never email, never
  `provider_account_id`, never `provider_credential_ref`, never any baseline value
- `race_event_public`, `visit_public` — feed data
- `waitlist_stats` — **`count(*)` only.** This view must use the default
  (`security_invoker = false`) owner's-rights behaviour; an invoker-rights view would be
  filtered by RLS and render `0`, which is a silent lie on the landing page

Rules:

- Every table has RLS enabled, and **no policy grants `anon` any write, on any table.**
- All writes happen server-side through the service key. The one exception is the waitlist,
  and even that goes through a server action rather than a browser insert — otherwise the
  publishable key is an open spam endpoint.
- The service key lives in one module guarded by `import 'server-only'`, which turns any
  accidental import from a client component into a build error rather than a leak.
- `service_role` bypasses RLS by design. The guard is the import boundary, not a policy.

---

## 9. State machines

**Racer**

| From | Event | To | Guard |
|---|---|---|---|
| — | form submitted | `registered` | unique email; `verification_provider` chosen |
| `registered` | connection verified | `racing` | `connect_state` valid + unexpired; `race_start_at` written before baseline |
| `registered` | `connect_state` expires / abandoned | `registered` (stale) | recoverable — the row is claimable again |
| `racing` | count reaches 10 | `won` | `where status = 'racing'` (concurrent-safe) |
| `racing` | `race_end_at` passes, count < 10 | `expired` | same conditional shape |

**Connection sub-state** (independent of `status`, applies to every racer):

| From | Event | To |
|---|---|---|
| `pending` | connection verified | `connected` |
| `connected` | revoked by racer, or credential expired | `unavailable` |
| `unavailable` | racer re-connects | `connected` |

`connection_state` never changes `status`. A racer whose connection dies is still `racing`;
they simply stop accumulating, and the page says so. This applies identically to a revoked
Stripe connection and an expired Lemon Squeezy key — the second of which is expected, not
exceptional.

**Sponsor slot**

| From | Event | To | Guard |
|---|---|---|---|
| `open` | checkout session created | `pending` | conditional update; 0 rows ⇒ slot already held |
| `pending` | `pending_until` passes | `open` | sweep; only if no payment landed |
| `pending` | payment succeeds, version matches | `held` | row lock |
| `held` | payment succeeds, version matches | `held` (new holder) | row lock; incumbent refunded |
| any | payment succeeds, version **mismatched** | unchanged | full refund, payment `superseded` |
| any | payment fails / abandoned | unchanged | payment `abandoned` |

No transition is triggered by a timer alone. Every one is either an idempotent conditional
update or a locked transaction, so re-running any of them is safe.

---

## 10. Failure modes and what must happen

These are the paths that lose money or credibility if unhandled. Each needs an explicit
recorded state, not a log line.

| Failure | Required behaviour |
|---|---|
| Duplicate provider event | Return 200, no state change. Ledger + unique constraints make it a no-op. |
| Handler crash mid-event | `processed_at` left NULL; the provider's retry re-processes; reconciliation repairs the count. |
| Two sponsors, same slot, same price | Second is stopped by the `pending` hold before reaching Stripe. |
| Payment lands after the slot moved | Full refund, `superseded`, **no** 10% fee. |
| Refund fails | `refund_status = 'failed'`, alert, human resolves. Never silently swallowed. |
| Webhook handler is down for hours | Reconciliation re-derives the count from the provider's API on its next run. |
| Racer revokes Stripe access | `connection_state = 'unavailable'`; page says the connection was lost. |
| **Lemon Squeezy key expires** | Same as above. **Expected annually, not exceptional** — needs a real re-connect path. |
| **Lemon Squeezy webhook never configured** | Reconciliation alone keeps the count correct. Slower to update; never wrong. |
| **Lemon Squeezy webhook removed later** | Identical outcome. Correctness never depended on it. |
| **Lemon Squeezy baseline is large** | Snapshot cost scales with store size against a 300 req/min cap. Surface progress; never start the race on a partial baseline. |
| Race ends while a job is late | Derived status is already correct; the job only writes the event row. |
| Self-takeover attempt | Blocked on card fingerprint, logged, payment refunded in full. |

**There is no admin surface in V1**, and several rows in that table require a human. Until
one exists, these are resolved by hand in the Stripe dashboard and the database. That is
acceptable while volumes are near zero and is **not** acceptable at volume — see §13.

---

## 11. Real-time, globe and activity

**Realtime is a signal, not a data source.** Components subscribe and then re-render from the
database; they never patch local state from a pushed payload. One source of truth, and a
dropped socket self-heals on the next render.

Only tables that are safe to broadcast in full are published: `sponsor_slot` and
`race_event`. `racer`, `waitlist_signup` and `sponsor_payment` are never published. Realtime
respects RLS, so `anon` needs `SELECT` on the subscribed table — which is another reason the
public views, not the base tables, are what the client reads.

**Globe and activity feed** are built from the `visit` table, written from `proxy.ts` using the
host's request geolocation (country, city, latitude, longitude). Coordinates are real, so the
markers are real. Bots and our own traffic are excluded at write time. **No raw IP is stored
and no per-visitor identifier survives past 24 hours.** An empty globe is correct; a populated
fake one is not.

The activity feed's identity wording is deliberately unresolved — see §13.

---

## 12. Environment variables and secrets

Public (safe to ship to the browser):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | RLS-constrained client reads |
| `NEXT_PUBLIC_APP_URL` | absolute URLs for OAuth redirect and Checkout return |

Server only. **These must never be prefixed `NEXT_PUBLIC_`, and must never be read from a
client component.** Names and purposes only — no values, no sample keys, and no real secret of
any kind belongs in this file or any other document in the repository.

**Platform / shared**

| Variable | Purpose |
|---|---|
| `SUPABASE_SECRET_KEY` | service-role writes; bypasses RLS |
| `CRON_SECRET` | authenticates scheduled jobs |

**Stripe — sponsor payments** (our own account; `SYSTEM-ARCHITECTURE.md` §3)

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Checkout Sessions and refunds on our account |
| `STRIPE_WEBHOOK_SECRET` | verifies the platform webhook endpoint |

**Stripe — racer verification** (Connect; `SYSTEM-ARCHITECTURE.md` §4)

| Variable | Purpose |
|---|---|
| `STRIPE_CONNECT_CLIENT_ID` | builds the OAuth authorize URL |
| `STRIPE_CONNECT_CLIENT_SECRET` | OAuth token exchange |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | verifies the connect webhook endpoint |

The sponsor and racer Stripe secrets are **four separate variables with two separate webhook
secrets**, even though three of them belong to the same Stripe account. Compromising the
sponsor processor must not also expose every racer's connected-account events, and vice versa.

**Lemon Squeezy — racer verification only** (`SYSTEM-ARCHITECTURE.md` §14–15)

| Variable | Purpose |
|---|---|
| `PROVIDER_CREDENTIAL_KEY` | app-level key for envelope-encrypting stored merchant credentials before they enter Vault |

There is deliberately **no `LEMONSQUEEZY_API_KEY` environment variable.** Lemon Squeezy
credentials are per-merchant, supplied at runtime by each racer, and never belong to us. A
platform-level Lemon Squeezy key in the environment would be a category error — and would mean
we were holding a credential that could act on a merchant's store without them.

No Lemon Squeezy variable exists for sponsor payments either, because Lemon Squeezy sponsor
payments are not implemented in V1 (§3).

`STRIPE_SECRET_KEY`, `SUPABASE_SECRET_KEY`, and `PROVIDER_CREDENTIAL_KEY` are never used in
the browser, are never logged, and are never included in an error message returned to a user.

---

## 13. Open decisions, deferred from V1

Flagged rather than silently decided. Nothing here blocks *starting*; two of them block the
racer flow, and four block going live.

**Blocking the racer flow — answer before `/join` is built:**

1. **Does Lemon Squeezy ship in the UI at V1?** Lemon Squeezy cannot offer read-only access,
   cannot present a consent screen, and requires the racer to hand over a full-authority
   credential (§14–15). The **adapter gets built either way**, because the whole point is a
   provider-agnostic race engine. What is undecided is whether it is *exposed* at launch.
   Offering it means telling racers plainly that they are handing over more access than the
   Stripe path requires — a product and liability decision, not an engineering one.
2. **`DESIGN-SYSTEM.md` locked copy names Stripe specifically.** The hero subline reads
   "raceto10 — connect Stripe, race to your first 10 customers" and the how-it-works step
   reads "join free → connect Stripe → race to 10, verified". Both are marked *do not change
   without explicit approval*. If more than one provider is offered, that copy becomes
   conditionally false for Lemon Squeezy racers. Either the copy is revisited by you, or V1 is
   Stripe-only at the UI layer while the adapter layer stays provider-agnostic.
   **The locked copy has not been touched pending this decision.**

**Must be resolved before going live:**

3. **No admin surface.** Failed refunds, stuck `pending` slots, and lost connections all need a
   human. V1 resolves them by hand; that does not scale. *(§10)*
4. **Guest checkouts do not count** *(§4)*. A product call, not a technical one — a racer whose
   customers check out without an account sees a lower number than their provider dashboard
   shows. That discrepancy will generate support questions and needs a position.
5. **Privacy disclosure for the globe.** Visitor country and coordinates are real
   personal-adjacent data. V1 stores geo only and no IP, which is the minimum that satisfies
   the honesty rule; whether a notice is required is a legal question, not an engineering one.
6. **Liability position on storing full-authority Lemon Squeezy credentials.** Even encrypted,
   a credential that can issue refunds and cancel subscriptions on a merchant's store is a
   materially larger commitment than holding nothing at all. Decide deliberately.

**Deferred, safe to ship without:**

7. **Dispute handling.** `charge.dispute.created` is not handled in V1.
8. **Activity-feed identity wording.** The spec's "amaranth finch from Canada visited" reads as
   a pseudonym, which sits uneasily beside an honesty rule requiring every name and location to
   be real. Country-only phrasing ("Someone from Canada visited") satisfies both rules without
   inventing an identity. **Recommend country-only.**
9. **Vercel plan and cron frequency.** Correctness deliberately does not depend on it (§4), so
   it is not a blocker — but the frequency sets how stale a count can get before reconciliation
   catches up.
10. **Bid history on the slot card** ("this slot has changed hands 4 times, current price
    $280"). Data is already retained in `sponsor_payment`; only the UI is deferred.
11. **Email notifications.** Out of scope; nothing in V1 sends mail.
12. **Leaderboard and public race pages**, per the original §8.

**Design-system gaps this build introduces** — needed before those screens ship, and recorded
here because they are additions to `DESIGN-SYSTEM.md`, not contradictions of it:

13. **The `pending` slot state has no specified label.** `DESIGN-SYSTEM.md` defines copy for
    two slot states ("Open · from $50" and real sponsor info once sold). The concurrency fix
    adds a third, and the honesty rule means it must say something true rather than reusing
    "Open". Needs design copy.
14. **The mobile top sponsor bar collides with the nav.** `DESIGN-SYSTEM.md` pins a bar to the
    very top of the viewport on mobile, where the nav already lives. Their stacking is
    unspecified. Needs a layout decision.
15. **The short-description cap is 60 characters, not the "two lines" the design system
    implies.** Derived from the card's fixed 170–190 × ~90px geometry (§3). Recorded because
    the number is now concrete and the form must enforce it.
16. **Slots per mobile bar is unspecified.** The design system fixes 5 per side on desktop but
    never says how many sit in each mobile bar. This document assumes 5 and 5.

**Resolved since the last revision:** the Stripe `read_only` scope is confirmed valid and is
the default for Standard accounts, so it is no longer an open item.

**Still not in this spec:** the "how it works" content deep-dive and email notification copy.

---

## 14. Verification provider adapters

Racer verification is **not** a Stripe feature. It is a capability, and Stripe is one way to
provide it. The race engine must never know which one is in use.

### The interface

Every adapter satisfies the same contract. Provider-specific shapes stop at this boundary:

```
VerificationProvider
  id                      'stripe' | 'lemonsqueezy'
  capabilities            ProviderCapabilities          // declared, not assumed

  // --- connection ---
  beginConnection(racer)      -> { kind: 'redirect', url }        // OAuth-style
                              |  { kind: 'credential', instructions }  // paste-style
  completeConnection(params)  -> ProviderConnection               // accountId + credentialRef
  validateConnection(conn)    -> { ok, accountLabel }             // health check
  revokeConnection(conn)      -> void                             // best-effort

  // --- reading (provider-neutral shapes, always newest-first) ---
  listCustomers(conn, { until })     -> Iterable<ExternalCustomer>
  listPayments (conn, { since, until }) -> Iterable<ProviderPayment>

  // --- events (optional capability) ---
  verifyWebhook(rawBody, headers)    -> ProviderEvent | null
```

| Neutral type | Shape | Notes |
|---|---|---|
| `ExternalCustomer` | `{ externalId, createdAt, email? }` | `externalId` is opaque and namespaced by provider |
| `ProviderPayment` | `{ externalCustomerId, externalPaymentId, paidAt, amountMinor, currency, kind }` | the only shape the race engine ever consumes |
| `ProviderConnection` | `{ provider, accountId, credentialRef?, expiresAt? }` | credential is a **reference**, never a value |

### Capability descriptor

Adapters **declare** what they can do, and the UI and the reconciliation job read those
declarations rather than assuming parity. This is the mechanism that keeps the product honest:
the differences between providers are data, not a comment someone has to remember.

```
ProviderCapabilities {
  connectionMethod        'oauth' | 'credential_paste'
  consentScreen           boolean      // does the merchant authorize us, or just hand over a key?
  credentialScope         'read_only' | 'full_access'
  credentialExpires       boolean      // does the credential need periodic re-consent?
  credentialRotatable     boolean      // can we rotate it without the merchant?
  webhookRegistration     'platform' | 'merchant' | 'none'
  webhookOptional         boolean      // is reconciliation the primary path?
  serverSideDateFilter    boolean      // can we query "created after T" directly?
  accountScoping          'documented' | 'unclear'
}
```

### The two adapters, side by side

| | **Stripe** (Connect OAuth) | **Lemon Squeezy** (API key) |
|---|---|---|
| Connection method | OAuth 2.0 authorization code with consent screen | merchant generates a key and pastes it in |
| Scope requested | `read_only` | **none available — full account authority** |
| Can we ask for less? | yes | **no. The concept of scopes does not exist.** |
| Credential we hold | none of the merchant's; a platform token | a bearer key that can also issue refunds, cancel subscriptions, and edit customers |
| Credential lifetime | platform-managed | **~1 year, no refresh token** |
| Revocation | merchant can revoke; we are notified | only by deleting our stored copy |
| Webhook delivery | we register the endpoint; events arrive automatically with `event.account` | **merchant must add the URL in their dashboard, or we create it using their key** |
| Webhook signature | `Stripe-Signature` | `X-Signature`, HMAC-SHA256 over the raw body |
| Date-range query | supported | **not supported — filters are exact-match only** |
| Baseline capture cost | cheap (date filter + cursor pagination) | **pages the customer list newest-first; cost scales with store size** |
| Rate limit | generous, documented | 300 req/min, documented |
| Native SDK | `stripe` | `@lemonsqueezy/lemonsqueezy.js` |

### What this means, stated plainly

**Portable, and genuinely so.** Both providers expose customer records with stable ids and a
creation timestamp, and payments referencing those customers. So the baseline set, the
qualifying-customer rule, the derived count, the race lifecycle, `race_event`, and the
reconciliation job are **identical for both**. That is real portability, not a claim.

**Not portable, and must not be described as such.** The connection step, the credential
scope, the trust relationship, and webhook delivery are fundamentally different:

- A Stripe racer grants **read-only** access through a consent screen they can revoke.
- A Lemon Squeezy racer hands over a key with **full account authority**, including the power
  to issue refunds and cancel subscriptions on their store, and cannot scope it down even if
  they want to.

**Four consequences that follow directly, and are not optional:**

1. **The race engine branches on nothing.** No `if (provider === 'stripe')` anywhere downstream
   of the adapter. The engine consumes `ProviderPayment` and nothing else.
2. **The UI must not use one generic "Connect" verb for both.** A consent flow and a
   paste-your-key flow are different acts with different consequences. Presenting them
   identically would misrepresent what the racer is agreeing to.
3. **Reconciliation is the primary path for Lemon Squeezy, not a safety net.** Its webhooks
   depend on the merchant configuring them correctly and can be removed at any time, so
   correctness cannot rest on them.
4. **The credential is a liability we are choosing to carry.** Storing a full-authority key is
   a materially larger commitment than storing nothing at all, and it must be encrypted at
   rest, disclosed to the racer in plain language, and deletable on request.

### Strategic risk, recorded

Stripe acquired Lemon Squeezy in 2024 and is publicly steering its users toward Stripe Managed
Payments. The Lemon Squeezy API is **not deprecated today and no shutdown date has been
announced** — but its owner's stated goal is migration elsewhere. The adapter boundary is the
mitigation: if Lemon Squeezy is retired, the Stripe adapter already exists and the race engine
does not move.

---

## 15. Provider connection flows, and the honesty requirement

### Stripe — consent-based, read-only

```
/join ──► create racer (status 'registered', verification_provider='stripe',
                         connect_state, expires +30m)
      ──► 302 → connect.stripe.com/oauth/authorize
                ?response_type=code&client_id=<STRIPE_CONNECT_CLIENT_ID>
                &scope=read_only
                &redirect_uri=<APP_URL>/api/stripe/connect/callback
                &state=<connect_state>
      ◄── 302 back ?code=…&state=…        (or ?error=access_denied)
          verify state (single-use, unexpired)
      ──► exchange code → provider_account_id
      ──► §4 ordered baseline write
```

**The authorization code is single-use and expires in 5 minutes.** This is not a theoretical
constraint: a racer who pauses on the consent screen and comes back later gets a dead code.
Expiry must produce a clean, recoverable "start again" outcome, not a stuck row, and the
`access_denied` error must be handled as a normal user choice rather than a failure.

`read_only` is also the **default** for Standard accounts, but it is passed explicitly anyway —
silently defaulting into the right behaviour is how it later defaults into the wrong one.

### Lemon Squeezy — credential-based, full access

```
/join ──► create racer (status 'registered', verification_provider='lemonsqueezy',
                         connect_state, expires +30m)
      ──► show instructions: open Settings » API, generate a key, paste it here
          — with an explicit, plain-language statement of what the key can do
      ──► validate the credential against the API; resolve the store id
      ──► encrypt and store in Vault; keep only the reference on the racer row
      ──► §4 ordered baseline write
```

**There is no consent screen, because Lemon Squeezy has no OAuth.** The racer is not
authorizing us through any provider-mediated flow; they are copying a credential and giving it
to us. That single fact is why this flow cannot be presented as the Stripe flow with a
different logo.

**What the racer must be told, before they paste anything:**

- the key grants full access to their store, not read access, and **we cannot request less**
- we will use it only to read customers and payments
- it is encrypted at rest and can be deleted at any time
- it expires in about a year and will need replacing

**Webhooks must be configured by the merchant.** Unlike Stripe, we cannot register an endpoint
on their behalf without using the very credential we are trying to constrain. The flow gives
them the URL and secret to add in their dashboard, treats it as optional, and relies on
reconciliation for correctness either way.

**Store scoping is undocumented.** Lemon Squeezy's docs do not state whether an API key is
limited to a single store or spans the whole account. Until that is confirmed, "connect one
store" is not a promise the product can make, and the connection UI must not imply it.

### The honesty requirement

`DESIGN-SYSTEM.md`'s honesty rule — *every number, name, and location is real or it does not
appear* — extends to capabilities. Anything that implies the two providers are equivalent is a
false claim about what a racer is agreeing to, and it is the kind of claim that only surfaces
when something goes wrong.

Concretely:

- No shared "Connect your payment provider" button that hides which flow is which.
- No copy stating or implying equivalent access, equivalent security, or equivalent setup.
- No claim that Lemon Squeezy provides read-only access. It does not.
- If the two cannot be described honestly and comparably in the same amount of space, they
  should not share a page treatment.

**This is the open question in §13 that most needs a product answer before the racer flow is
built**, because it decides whether Lemon Squeezy ships in V1 at all.

---
