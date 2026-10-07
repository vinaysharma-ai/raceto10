-- When the start email was sent, so a failed send can be retried.
--
-- ## Why a timestamp and not a boolean
--
-- A boolean answers "has this been sent"; a timestamp answers "has this been
-- sent, and when". The second is strictly more useful and costs the same, and it
-- is the one the retry rule needs: the batch sends to racers whose column is
-- null, and logs when each one actually went.
--
-- ## Why null is the retry state
--
-- Sending is attempted after activation, and activation has already committed by
-- then. So a send that fails, or that is skipped because no mail provider is
-- configured, must leave this column null rather than write a failure into it.
-- Null means "not yet sent" and the next batch run tries again; writing a
-- failure marker would mean the racer never gets the email even after the
-- provider is configured.
--
-- That is also why the column is not part of activation's compare-and-set. The
-- race starts exactly once; the email is best-effort and may be attempted many
-- times.
--
-- ## Additive
--
-- One nullable column. No default, no backfill: an existing racer has never been
-- sent this email, and null is the truthful value for them. Nothing else is
-- touched.

alter table racer
  add column if not exists email_sent_at timestamptz;

comment on column racer.email_sent_at is
  'When the start email was sent. Null means not yet, including after a failed or skipped attempt, so the next batch run retries.';
