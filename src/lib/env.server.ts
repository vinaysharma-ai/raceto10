import "server-only";

import { z } from "zod";

/**
 * Server-only configuration — secrets, and never anything the browser can see.
 *
 * The `server-only` import above is the guard: importing this module from a
 * client component is a build error, not a leak.
 *
 * ## Why these validate on first use instead of at module load
 *
 * A module-level throw would require *every* provider to be provisioned before
 * the app could build or run at all — which is not the same thing as failing
 * loudly, and would block the landing page and sponsor flow on payment keys
 * they do not use. Instead each group validates the first time the code path
 * that needs it runs, and names exactly which variables are missing.
 *
 * The property that matters is preserved either way: a secret can never reach a
 * provider call as `undefined`. The failure happens immediately before the call
 * that needed it, with a message naming the variable.
 *
 * ## Why they are grouped
 *
 * So a partially provisioned environment still runs. The Supabase service key
 * is needed by migrations; the Stripe keys are needed by Checkout. Requiring
 * them together would mean you could not do either until you had both.
 */
function lazily<T>(
  label: string,
  keys: readonly string[],
  schema: z.ZodType<T>,
): () => T {
  let cached: T | undefined;

  return () => {
    if (cached !== undefined) return cached;

    const missing = keys.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing ${label} environment variable${missing.length > 1 ? "s" : ""}: ` +
          `${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} to ` +
          `.env.local for local development, or to the Vercel project settings for deploys.`,
      );
    }

    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n  ");
      throw new Error(`Invalid ${label} environment configuration:\n  ${detail}`);
    }

    cached = parsed.data;
    return cached;
  };
}

/** Service-role access. Bypasses RLS entirely — server use only. */
export const supabaseServiceEnv = lazily(
  "Supabase service-role",
  ["SUPABASE_SECRET_KEY"],
  z.object({ SUPABASE_SECRET_KEY: z.string().min(1) }),
);

/** Authenticates the scheduled jobs at `/api/cron/*`. */
export const cronEnv = lazily(
  "cron",
  ["CRON_SECRET"],
  z.object({ CRON_SECRET: z.string().min(1) }),
);

/** Envelope-encrypts stored merchant credentials before they reach Vault. */
export const credentialEnv = lazily(
  "credential encryption",
  ["PROVIDER_CREDENTIAL_KEY"],
  z.object({ PROVIDER_CREDENTIAL_KEY: z.string().min(1) }),
);

/**
 * Stripe, on our own account — sponsor Checkout and refunds.
 * Deliberately separate from the Connect keys below: compromising the sponsor
 * processor must not also expose every racer's connected-account events.
 */
export const stripeSponsorEnv = lazily(
  "Stripe sponsor payments",
  ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  z.object({
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
  }),
);

/**
 * Stripe Connect — racer verification. OAuth only; no money moves.
 *
 * `STRIPE_SECRET_KEY` appears in this group as well as the sponsor group, and
 * that is not a mistake: Connect and sponsor payments are the same Stripe
 * account, and reading a connected account still needs the platform's key.
 * What is kept separate is the thing that actually matters — the webhook
 * secrets. A leaked sponsor webhook secret cannot be used to forge connect
 * events, and vice versa.
 *
 * If the two ever need to be genuinely isolated, the platform key here can be
 * swapped for a Stripe *restricted* key scoped to the Connect permissions.
 * That is a dashboard change, not a code change.
 */
export const stripeConnectEnv = lazily(
  "Stripe racer verification",
  [
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_CLIENT_ID",
    "STRIPE_CONNECT_CLIENT_SECRET",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
  ],
  z.object({
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_CONNECT_CLIENT_ID: z.string().min(1),
    STRIPE_CONNECT_CLIENT_SECRET: z.string().min(1),
    STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1),
  }),
);
