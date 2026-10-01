import { createBrowserClient } from "@supabase/ssr";

import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The browser client.
 *
 * Typed with `Database`, generated from the hosted project by
 * `supabase gen types`. Without the generic every query result is `any`, which
 * means a column that does not exist — or one renamed by a migration — reads as
 * fine until it returns `undefined` at runtime.
 */
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}