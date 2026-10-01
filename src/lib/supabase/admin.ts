import "server-only";

import { createClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { supabaseServiceEnv } from "@/lib/env.server";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * The `server-only` import above is the guard: importing this from a client
 * component is a build error, not a leak. That matters more here than anywhere
 * else in the codebase — this key can read every racer's email and every
 * baseline, and write to any table.
 *
 * Session persistence is off because there is no user session; this client
 * authenticates as the service role and nothing else.
 */
export function createAdminClient() {
  const { SUPABASE_SECRET_KEY } = supabaseServiceEnv();

  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
