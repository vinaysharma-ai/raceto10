# RaceTo10 — start here (28 Sept 2026, revised)

Read this file first, then `01-SITE-AND-JOIN-SPEC.md` and `02-BACKEND-SPEC.md`.
These three files are the current source of truth. Where they conflict with older docs, these win.

## Latest decision overrides

These points supersede any older batch/start-duration assumptions elsewhere in the repository:

- **Anyone may join an active race at any time** as long as they pass the current eligibility gate.
- The eligibility gate is still **0 paying customers and $0 MRR** at the time RaceTo10 verifies them.
- A qualifying racer **does not wait for a future batch just because the public race is already active**.
- A new racer becomes active when their payment account is successfully verified and their baseline is captured.
- Each active racer gets an **individual race window** beginning at activation.
- The race duration is **not finalized yet**. Architect it as configurable; **7 days is the current preferred candidate**, while 14 days remains a possible alternative until the product decision is locked.
- Do not hardcode 7 or 14 days into UI copy, database constraints, or business logic. Use a configurable race-duration value.
- The initial 20–50-person launch can still be treated as a launch cohort for operations/marketing, but the product must not require batch-only entry once the race is live.
- Because late entry is allowed, the authoritative timing fields belong to each race entry/racer participation (`activated_at`, `race_end_at`) while the public leaderboard can still rank the active racers by verified progress.

## Where we are

**Working locally:** dark monochrome design with mono type, header + hero, real Mapbox globe,
waitlist form, `/join` placeholder that honestly says signups are closed, sponsor-bar component,
logo, honest failure copy ("We couldn't load the race just now").

**Written but NOT applied:** database migrations. They were verified locally and never pushed to
the hosted Supabase project. That is why the globe feed says "couldn't load the race" — the tables
don't exist remotely. Expected, not a bug. Do not push without Vinay's go-ahead (see build order).

**Done by Vinay (manual, outside the repo):** Google OAuth and X OAuth 2.0 configured in
Supabase; Mapbox token in `.env.local`. Resend: a prompt exists, account/domain status unconfirmed.

**Not built yet:** login, the real join flow, payment-credential verification, racer activation,
count reconciliation, emails, leaderboard data, search, empty sponsor slots and the `/sponsor` page.

## Document precedence

1. `00-START-HERE.md`, `01-SITE-AND-JOIN-SPEC.md`, `02-BACKEND-SPEC.md` (this set)
2. `RACETO10-REDESIGN-V2.md` — colors, type, header, globe, sponsor-slot shape
3. `DESIGN-SYSTEM.md` — tokens and anti-slop rules, except where REDESIGN-V2 replaced them
4. `SYSTEM-ARCHITECTURE.md` and the 25 Sept sponsor update — only for anything not covered above.
   Its Stripe Connect OAuth, webhook, takeover/bidding and "start immediately on connect" sections
   are SUPERSEDED.

## Decisions that changed (do not build the old versions)

| Old | Now | Why |
|---|---|---|
| Stripe Connect OAuth | Racer pastes a **restricted read-only API key** | OAuth needs a Stripe platform account with a Connect client ID. Stripe India is invite-only, so we cannot create one. Restricted keys need nothing from us. |
| Webhooks drive counts | **Polling reconcile every ~30 min** | Restricted keys cannot deliver webhooks to us. |
| Race starts the moment Stripe connects | **Activation**: verify, snapshot baseline, then start that racer's clock. Late entry is allowed. | Keeps entry open while preserving a clear start boundary for each racer. |
| Baseline could be any number of customers | Eligibility gate: **zero paying customers, $0 MRR** at registration. Baseline set still snapshotted at activation as protection | Simpler premise, still safe. |
| Race payments via Stripe only | Stripe first, Lemon Squeezy second behind a flag | Widens the pool, but Lemon Squeezy key scope is unverified. |
| Visitor tracking on the globe | Globe shows **racers** at approximate location. No visitor tracking in V1 | Removes PII and disclosure problems. |
| MRR column on leaderboard | **Deferred** | Needs currency normalization to be honest. |

## Hurdles that will actually bite

1. **Stripe platform account impossible.** This is the biggest one and it changes the Stripe design.
   HitMRR's own leaderboard says every startup "connected a read-only Stripe key", and TrustMRR
   started from "ask for a Stripe API key". Follow that model.
2. **Migrations unapplied.** Nothing persists until they are. Apply only after review.
3. **Scheduler.** Vercel Hobby cron is daily at best. Use Supabase `pg_cron` + `pg_net` (check the
   extensions are available on the plan) or a GitHub Actions schedule calling a secret-protected route.
4. **Resend.** Needs the sending domain verified with DNS records before it can email real users;
   until then it typically only sends to the account owner's address.
5. **Google OAuth consent screen.** If left in "Testing", only listed test users can sign in. Publish it
   (basic profile/email scopes should not need verification — confirm).
6. **X may not return an email.** Ask for one manually when missing.
7. **Supabase manual identity linking** must be enabled (Auth settings → "Enable Manual Linking") or
   Google→X linking fails.
8. **Self-purchase gaming.** A racer can buy their own product with several cards. Cannot be fully
   prevented; mitigations are in the backend spec. Accepted V1 risk.
9. **Fresh-account gaming.** Someone with customers elsewhere can connect a brand-new empty Stripe
   account. Mitigation is public visibility of the product URL plus one race per provider account.
10. **Lemon Squeezy key scope.** Not confirmed whether keys can be limited to read-only. If not, treat
    them as high-sensitivity or ship Stripe only.
11. **Privacy.** Name, product, handle, approximate location and count become public. A consent
    checkbox plus a short privacy note are required before launch. Deletion is manual at this scale.

## Vinay's checklist (no code, only he can do these)

- [ ] Supabase → Auth → URL Configuration: add `http://localhost:3000/**` and `https://raceto10.lol/**`
- [ ] Supabase → Auth → enable **Manual Linking**
- [ ] Google Cloud consent screen set to production
- [ ] X app: OAuth 2.0 on, email access on, Supabase callback URL added
- [ ] Resend account, API key, `raceto10.lol` domain added and DNS records verified
- [ ] Generate an encryption key: `openssl rand -base64 32`
- [ ] Generate a cron secret: `openssl rand -hex 32`
- [ ] Put all secrets in `.env.local` and Vercel env. Never paste them into chat.
- [ ] Create one **Stripe test-mode restricted key** for local testing (only if a Stripe account exists; otherwise Claude Code uses mocked fixtures)

## Build order for Claude Code

Do these in order. Stop where it says STOP.

1. **Frontend pass** (`01`): logo, search placement, waitlist copy fix, leaderboard shell, empty sponsor
   slots, `/sponsor` page. Real empty states only.
2. **Schema V2** (`02` §2): write migrations as deltas over what exists, add RLS and public views, write a
   test proving anon cannot read any private column, generate types. **STOP.** Report the diff and wait
   for approval before `supabase db push`.
3. **Auth**: `/auth/callback`, sign-in buttons, profile row from identity data, X linking.
4. **Credential vault** and provider adapters (Stripe restricted key first).
5. **`/join` flow** end to end to status `registered` or `active`.
6. **Activation + configurable race duration + Resend emails.**
7. **Reconcile endpoint + scheduler.**
8. **Wire real data** into leaderboard, globe, feed, search.
9. **Tests** listed in `02` §10.
10. **Local end-to-end** with a test-mode key or fixtures. **STOP** before pointing anything at live keys.

## Do not

- Change design tokens, layout, or the locked headline.
- Add packages beyond `resend` (and `zod` if absent).
- Log, return, or echo any credential.
- Show a number that is not real. Empty stays empty.
- Add analytics, visitor tracking, or a public admin endpoint.

## Done means

A stranger can sign in with X or Google, connect a read-only key, be verified as zero-customer/$0 MRR,
become active immediately (even when the public race is already running), receive a race-start/activation
email, and appear on the board with a live verified count that updates within ~30 minutes of a real
payment. Each racer has a configurable race window; 7 days is the current preferred candidate but is not
yet locked. Anything less is not launch-ready.


## Current product rule to preserve during implementation

RaceTo10 is an open race, not a closed tournament. Once the public race is running, a qualifying founder
can still join. Their timer starts from their own successful verification/activation, and their baseline is
captured at that same activation boundary. Do not make a newly qualified founder wait for a later global
batch just to enter the product.

The first 20–50 founders can still be recruited as a launch cohort, but that is an operational launch
strategy rather than a permanent product restriction.
