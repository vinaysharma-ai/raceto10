import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The session client — reads and writes as the signed-in founder.
 *
 * Typed with `Database` so every query is checked against the real schema. This
 * is the client the RLS policies are written for: a query through it is subject
 * to `auth.uid()`, which is what makes an ownership mistake a compile error or a
 * refusal rather than a silent cross-account write.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components can't always write cookies.
          }
        },
      },
    }
  );
}