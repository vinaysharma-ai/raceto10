# RaceTo10 — Backend + Data Spec
## Version: 28 Sept 2026

Minimum secure backend for the first real launch. Database is source of truth; public views expose only public race data.

## 1. Stack / separation
- Next.js App Router + Supabase Auth/Postgres/RLS.
- Server routes/server actions for all sensitive operations.
- Mapbox globe, Resend email, Stripe restricted read-only key first.
- Lemon Squeezy behind a flag until its key scope/security model is verified.
- Never expose credential tables to the browser.

## 2. Core states
`registered` → `ready` → `racing` → `finished`

Optional operational states: `verification_failed`, `withdrawn`, `disqualified`.

- registered = authenticated/profile created, provider not verified.
- ready = provider verified at 0 paying customers and $0 MRR.
- racing = assigned to started batch and baseline captured.
- finished = 10 verified race customers or 14-day window ended.

Provider connection never starts the race clock.

## 3. Schema
Use deltas over the existing migration history; do not duplicate existing tables.

### profiles
- id uuid PK → auth.users
- name, email
- x_handle nullable
- avatar_url nullable
- created_at, updated_at, deleted_at
- email/private identity is not public.

### racers (reuse current project naming if different)
- id uuid PK
- profile_id uuid FK
- product_name text
- status
- public_slug unique
- public_consent_at nullable
- approximate_location nullable
- approx_lat / approx_lng nullable
- created_at, updated_at

A user-submitted customer count is never authoritative.

### race_batches
- id uuid PK
- name
- status `forming|active|finished`
- starts_at
- ends_at
- created_at
- started_at nullable
- finished_at nullable

One authoritative start time. Current window: 14 days. Starting twice is idempotent.

### race_entries
- id uuid PK
- batch_id FK
- racer_id FK
- status `waiting|racing|finished|withdrawn`
- joined_at
- activated_at nullable
- baseline_customer_count nullable
- current_customer_count default 0
- reached_ten_at nullable
- race_end_at nullable

Unique `(batch_id, racer_id)`. Counts cannot be negative.

### provider_connections
- id uuid PK
- racer_id FK
- provider `stripe|lemon_squeezy`
- external_account_ref nullable
- connection_status
- connected_at
- last_verified_at nullable
- last_reconcile_at nullable
- error_code nullable
- created_at, updated_at

No raw secret here.

### provider_credentials
Private vault:
- id uuid PK
- provider_connection_id unique FK
- encrypted_secret
- key_version
- created_at, rotated_at nullable

Only trusted server/service context may access it. Encrypt with application key. Never log, return, or echo plaintext credentials.

### verification_snapshots
- id uuid PK
- racer_id FK
- provider_connection_id FK
- captured_at
- customer_count integer
- mrr_minor bigint nullable
- currency text nullable
- verification_status
- source `registration|activation|reconcile`
- error_code nullable

Authoritative history of what RaceTo10 observed.

### reconciliation_runs
- id uuid PK
- provider_connection_id FK
- started_at
- completed_at nullable
- status
- customer_count nullable
- mrr_minor nullable
- error_code nullable

Private only.

### race_events
Public-safe events:
- id uuid PK
- racer_id, race_entry_id
- event_type `joined|activated|customer_milestone|finished`
- milestone_customer_count nullable
- occurred_at, created_at

No raw provider payload.

### waitlist
Retain current waitlist implementation. Private.

## 4. Public projections
Create views/RPCs rather than broad table access.

### public_racers
Expose only public_slug, public name/identity, X handle, product name, approximate map location, public status.

### public_race_entries
Expose racer, batch, status, current verified customer count, appropriate race timing, reached-ten timestamp.

### public_race_events
Expose public identity, safe event type, milestone, occurred_at.

### public_search
Search founder name, X handle, product name. Return public fields only.

Never expose email, auth IDs, credential material, provider secrets, raw verification history, or precise location.

## 5. RLS requirements
Anon may read public projections/search/events only.

Anon may not:
- read private profile/provider/snapshot/reconciliation tables
- insert/update/delete racers
- change status/counts
- trigger batch start

Authenticated users may manage only their permitted own profile/registration data, preferably through server-controlled operations.

Required security test: anon cannot read any private column.

## 6. Auth
- Google enabled in Supabase.
- X OAuth 2.0 enabled.
- `/auth/callback` handles provider return.
- Supabase manual identity linking enabled.
- Google + X accounts must map to one RaceTo10 profile when deliberately linked.
- Never merge accounts based only on an untrusted client-submitted email.
- If X lacks email, collect it manually after OAuth.

Redirect allowlist:
- `http://localhost:3000/**`
- `https://raceto10.lol/**`

## 7. Provider contract
Provider-neutral server interface should cover:
- validateCredentials()
- identifyAccount()
- getCustomerCount()
- getMRR() where supported
- healthCheck()

### Stripe V1
- Racer supplies a restricted read-only API key.
- Validate server-side.
- Eligibility requires 0 paying customers AND $0 MRR.
- Never trust a claimed count.
- Do not rely on Stripe Connect OAuth or inbound provider webhooks in this V1 because the current architecture deliberately uses restricted keys + polling.

### Lemon Squeezy
Keep behind feature flag until API key scope, privacy, and security model are confirmed. Same provider-neutral contract.

## 8. Registration flow
1. Authenticate with Google or X.
2. Create/load profile.
3. Collect product name and optional/public X handle where needed.
4. Create registration record.
5. Connect provider.
6. Validate provider server-side.
7. Capture eligibility snapshot.
8. If customer_count = 0 and MRR = 0 → `ready`.
9. Otherwise → not eligible for current batch.

The user stays registered/ready without a race clock until batch activation.

## 9. Batch activation + baseline
At manual batch start:
1. Lock the batch/start operation.
2. Set one `starts_at`.
3. Re-verify every ready racer.
4. Exclude anyone who is no longer eligible.
5. Write baseline snapshot at activation time.
6. Set `current_customer_count` from the baseline.
7. Mark entry `racing`.
8. Create activated event.
9. Send one start email.
10. Make reruns safe/idempotent.

This is critical: a founder may connect days before the start; customers gained before the batch begins belong in the activation baseline rather than giving that founder an artificial head start.

## 10. Reconciliation
Because V1 uses restricted keys + polling:
- reconcile active racers about every 30 minutes.
- fetch verified customer count server-side.
- compute `race_customer_count = max(0, verified_customer_count - baseline_customer_count)`.
- cap display at 10.
- on 10: mark finished, set reached_ten_at, emit finished event, stop normal reconciliation if appropriate.

Any downward correction must be explicit, auditable, and handled conservatively rather than silently producing negative progress.

## 11. Scheduler
Preferred: Supabase `pg_cron` + `pg_net` if available.
Fallback: GitHub Actions schedule calling a secret-protected route.

Protected scheduled routes require a secret, method validation, safe input handling, and no arbitrary public racer selection. Never expose a public admin endpoint.

## 12. Batch start operator
Create `scripts/start-batch.ts`.

It must:
- select a startable batch
- authenticate using server-only secret/config
- lock against duplicate execution
- re-verify ready racers
- set shared start/end time
- establish baselines
- send start email idempotently
- create safe events
- print only safe summary information

Never print credentials or raw provider responses.

## 13. Email
Resend, server-side.

Required V1 email:
`Your RaceTo10 race has started.`

Include founder name, batch start/end, public leaderboard URL, and concise verification context.

Make delivery idempotent so a rerun does not duplicate the same start email.

## 14. Search + globe data
Search only public projections.

Globe consumes the same public race source as leaderboard/activity:
- one marker per real public racer
- approximate lat/lng only
- no precise addresses
- no fake markers/events
- empty globe remains empty

## 15. Sponsors
Sponsor layer must not block the race.

V1:
- existing sponsor position/booking schema may remain
- empty slots are display-only
- `/sponsor` informational
- no checkout
- no bidding/takeover
- no impressions/click analytics

## 16. Security
- Server-only secrets.
- Never use `NEXT_PUBLIC_` for private credentials.
- Encrypt provider secrets at rest.
- Redact Authorization headers/provider secrets from logs/errors.
- Validate user input with existing Zod tooling if present.
- Rate-limit auth/credential verification endpoints.
- Protect scheduler/batch start.
- Public APIs return only explicitly public fields.

## 17. Tests
Authentication:
- Google callback loads/creates one profile.
- X callback loads/creates one profile.
- identity linking cannot hijack another user.

Eligibility:
- 0 customers + $0 MRR → eligible.
- 1+ customer → not eligible.
- non-zero MRR → not eligible.
- provider failure → safe failure state.

Activation:
- one shared batch start time.
- duplicate start idempotent.
- baseline captured at activation, not provider connection.
- pre-start growth included in baseline.

Reconciliation:
- baseline 0/current 0 → 0.
- baseline 0/current 4 → 4.
- baseline 0/current 10 → finished.
- never negative race progress.

RLS/security:
- anon cannot read private columns.
- users cannot read other users' private data.
- credentials never returned.
- cron/batch endpoints reject unauthorized calls.

Search:
- public name/handle/product searchable.
- private fields never returned.

## 18. Environment
Public:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_MAPBOX_TOKEN`
- `NEXT_PUBLIC_APP_URL`

Server-only:
- Supabase server/service credential(s)
- `CREDENTIAL_ENCRYPTION_KEY`
- `CRON_SECRET`
- `RESEND_API_KEY`

Use the repository's existing env utility and exact naming conventions before adding variables.

## 19. Safe migration procedure
1. Inspect existing migration history.
2. Write only required deltas.
3. Test locally.
4. Generate database types.
5. Run RLS/security tests.
6. Show Vinay the migration diff.
7. STOP for explicit approval before pushing to hosted Supabase.
8. Verify live tables/views/policies.
9. Regenerate live types if needed.
10. Probe public reads and private-read rejection.

## 20. Launch definition
A stranger can authenticate with Google/X, create one identity, add product data, securely connect Stripe, be verified as 0 customers/$0 MRR, become `ready`, and wait without the clock starting.

Vinay can start one batch, activate eligible racers at one shared time, capture baselines, and send the start email once.

An active racer receives real provider-derived customer progress roughly every 30 minutes and can reach 10, while the same real data powers the public leaderboard, globe, and activity feed.
