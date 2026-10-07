# RaceTo10 runbook

Read-only unless marked **WRITE**. Run with `npx supabase db query --linked "<sql>"`.
Local and production share one database: a local query reads real racers.
## Launch, close signups

`JOIN_OPEN` (Vercel env) is closed unless exactly `true`; changing it needs a redeploy.
**Open**: set `JOIN_OPEN=true`, redeploy. **Close**: set anything else or delete it,
redeploy. Signed-in founders stay signed in and running races keep running; only the
Stripe connect step becomes "Signups aren't open yet". Neither stops reconcile or activate.
## Racers and statuses

```sql
select status, count(*) from racer group by status order by status;
select r.public_slug, r.status, r.current_customer_count, r.race_end_at,
       c.connection_status, c.key_last4
from racer r left join provider_connections c on c.racer_id = r.id
order by r.created_at desc;
```

`registered` no key · `ready` verified, not started · `racing` · `finished` · `expired` ·
`ineligible` · `verification_failed` · `withdrawn` · `disqualified`
## Start the waiting

`npm run activate -- --local` (fixture testing) · `npm run activate -- --prod` (the real
deployment). Refuses localhost without `--local`, because a local server reads the real
rows. Returns `{activated, skipped, emailed, emailSkipped, emailFailed}`; each skip names
its reason.
## The last reconcile

`npm run reconcile` — safe locally, because it is idempotent. Recent runs:

```sql
select started_at, status, customer_count, error_code
from reconciliation_runs order by started_at desc limit 10;
```
## Stuck

`ready`, not starting: `npm run activate -- --prod`. The skip reason names why, usually
`not_verified` (no passing eligibility snapshot) or `connection_not_ready`.

`racing` and the count has not moved: check `count_reconciled_at` on the racer row. If it
is old the connection is broken. A `broken` connection is never read again, so the count
stays frozen until the racer reconnects — deliberate, no retry storm.
## Freeze a racer (**WRITE**)

No freeze button; the status is what the code reads.

`update racer set status='withdrawn' where public_slug='<slug>';`

This drops them from the board (which shows only `racing`, `finished`, `expired`) and
reconcile skips them (it reads only `racing`). The key is **not** deleted.
## Delete a key by hand (**WRITE**)

```sql
delete from provider_credentials where provider_connection_id in (
  select id from provider_connections where racer_id = '<uuid>');
```

The connection still says `connected`, a lie until updated. Prefer Disconnect on `/join`,
which does both. Revoke the key at Stripe too.
## A wrong count is reported

`count(*)` over `race_customer`, recomputed each run and never incremented, so it cannot
drift. A customer drops out only if the charge is refunded, unpaid, zero, or has no
customer id; a payment after `race_end_at` is never counted. Then `npm run reconcile` —
re-running cannot double-count. Detail:

`select external_customer_id, first_paid_at from race_customer where racer_id='<uuid>';`
`select event_type, milestone_customer_count, occurred_at from race_event where racer_id='<uuid>';`
