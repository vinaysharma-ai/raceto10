import "server-only";

import type { ConnectionStore, ExistingConnection, StoredCredential } from "@/lib/verification/connect.ts";
import { sealForConnection } from "@/lib/vault/server";

/**
 * The Supabase-backed connection store.
 *
 * `src/lib/verification/connect.ts` holds the ordering and the rules; this is
 * the half that knows about tables. Same split as `readRaceBoard` and its
 * reader, and for the same reason: the rules are testable without a database.
 *
 * ## Which client, and why it matters
 *
 * Writes use the **service role**, because neither table grants anything to
 * `authenticated`: `provider_connections` and `provider_credentials` are
 * server-only by design, and a racer has no business writing either directly.
 *
 * That makes `currentRacerId()` load-bearing. It is the only thing establishing
 * who the write is for, and it reads the session — `getUser()`, re-validated
 * against the auth server — rather than anything a request supplies. Every
 * scoped query below takes that id as an argument from the caller, and no
 * exported function here accepts a racer id from outside.
 *
 * ## Why `provider_credentials` is never selected for return
 *
 * Nothing in this module reads `encrypted_secret` except the vault resolver in
 * `stripe/restricted-client.ts`, which returns plaintext only into an outbound
 * provider call. Keeping that the single read means there is one place to audit.
 */

/**
 * The racer for the authenticated session, or null.
 *
 * Walks session → `profiles` → `racer`. A founder who has signed in but has not
 * yet been given a racer row has no race to connect a provider to, and null is
 * the honest answer rather than creating one here.
 */
export async function getCurrentRacerId(): Promise<string | null> {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // Service role for the read: `racer` grants nothing to `authenticated`
    // either, and the filter below is what scopes it.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient();

    const { data } = await db
      .from("racer")
      .select("id")
      .eq("profile_id", user.id)
      .maybeSingle();

    return data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The connection row for the signed-in racer, without its credential.
 *
 * Used by `/join` to render the current state. Deliberately never joins to
 * `provider_credentials`: a page has no reason to touch the vault, and a
 * function that cannot reach it is one fewer place to get that wrong.
 */
export async function getOwnConnection(provider: string): Promise<{
  id: string;
  accountId: string | null;
  accountLabel: string | null;
  status: string;
} | null> {
  try {
    const racerId = await getCurrentRacerId();
    if (!racerId) return null;

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient();

    const { data } = await db
      .from("provider_connections")
      .select("id, external_account_ref, connection_status")
      .eq("racer_id", racerId)
      .eq("provider", provider)
      .maybeSingle();

    if (!data) return null;

    return {
      id: data.id,
      accountId: data.external_account_ref,
      // There is no label column on the table; the id is what we have.
      accountLabel: null,
      status: data.connection_status,
    };
  } catch {
    return null;
  }
}

/**
 * The real store.
 *
 * Every scoped method takes the racer id from `currentRacerId()` — which the
 * orchestration calls once, first — so the ownership check cannot be skipped by
 * a caller that forgets it.
 */
export function connectionStore(): ConnectionStore {
  return {
    currentRacerId: getCurrentRacerId,

    async findOwnConnection(racerId, provider): Promise<ExistingConnection | null> {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("provider_connections")
        .select("id, external_account_ref, connection_status")
        .eq("racer_id", racerId)
        .eq("provider", provider)
        .maybeSingle();

      if (!data) return null;
      return {
        id: data.id,
        accountId: data.external_account_ref,
        status: data.connection_status,
      };
    },

    async findConnectionByAccount(provider, accountId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data } = await db
        .from("provider_connections")
        .select("id, racer_id")
        .eq("provider", provider)
        .eq("external_account_ref", accountId)
        .maybeSingle();

      if (!data) return null;
      return { id: data.id, racerId: data.racer_id };
    },

    async insertConnection(row) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { data, error } = await db
        .from("provider_connections")
        .insert({
          racer_id: row.racerId,
          provider: row.provider,
          external_account_ref: row.accountId,
          connection_status: row.status,
          connected_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error || !data) throw new Error(error?.message ?? "insert failed");
      return { id: data.id };
    },

    async updateConnection(id, patch) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("provider_connections")
        .update({
          ...(patch.accountId !== undefined ? { external_account_ref: patch.accountId } : {}),
          ...(patch.status !== undefined ? { connection_status: patch.status } : {}),
          ...(patch.errorCode !== undefined ? { error_code: patch.errorCode } : {}),
          ...(patch.status === "connected" ? { connected_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw new Error(error.message);
    },

    async putCredential(connectionId, sealed: StoredCredential) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      // Upsert on the unique `provider_connection_id`: one credential per
      // connection, so reconnecting replaces rather than accumulating.
      const { error } = await db
        .from("provider_credentials")
        .upsert(
          {
            provider_connection_id: connectionId,
            encrypted_secret: sealed.ciphertext,
            key_version: sealed.keyVersion,
            rotated_at: new Date().toISOString(),
          },
          { onConflict: "provider_connection_id" },
        );

      if (error) throw new Error(error.message);
    },

    async clearCredential(connectionId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("provider_credentials")
        .delete()
        .eq("provider_connection_id", connectionId);

      if (error) throw new Error(error.message);
    },

    /**
     * Records the entry-gate verdict.
     *
     * `source: "registration"` is a value the check constraint already allows,
     * so the gate leaves an audit trail without a schema change. The count is a
     * floor when the probe short-circuited — see `verification/probe.ts` — and
     * `error_code` carries that distinction into the row.
     */
    async insertSnapshot(row) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db.from("verification_snapshots").insert({
        racer_id: row.racerId,
        provider_connection_id: row.connectionId,
        customer_count: row.customerCount,
        mrr_minor: row.mrrMinor,
        currency: row.currency,
        verification_status: row.status,
        source: row.source,
        error_code: row.errorCode,
      });

      if (error) throw new Error(error.message);
    },

    /**
     * `registered` (or a previous failure) becomes `ready`.
     *
     * The `.in(...)` is the whole safety of this: the update can only ever move
     * a racer who has not started. A reconnect by somebody already racing, or
     * already finished, matches nothing and changes nothing — which matters
     * because activation's precondition is `status = 'ready'` and a stray write
     * here would reopen a closed race.
     */
    async markReady(racerId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const db = createAdminClient();

      const { error } = await db
        .from("racer")
        .update({ status: "ready" })
        .eq("id", racerId)
        .in("status", ["registered", "verification_failed"]);

      if (error) throw new Error(error.message);
    },

    seal: (plaintext, connectionId) => sealForConnection(plaintext, connectionId),
  };
}
