/**
 * supabase-executor.ts — real-Supabase SqlExecutor over @supabase/supabase-js.
 *
 * ADR rev2 R2.8 / R2.9: the client is created PER RUNTIME (never a module-
 * level singleton — that was D2 in adr/contracts.md, the root-leak class
 * this whole ADR replaces) and is loaded with an AGENT credential only.
 * Owner actions require a real owner JWT that agent runtimes never hold
 * (`ar login --owner`, CLI-only, out of this package's scope); this
 * executor does not special-case that — it just forwards whatever JWT the
 * runtime gives it, and the RPCs themselves enforce owner-trust server-side.
 *
 * NEVER contacted by tests (ASSERT_INVARIANT: no real network host, no
 * service_role in repoFor() paths under test) — packages/core/test/harness/
 * pglite-harness.mjs supplies a structurally-identical SqlExecutor backed by
 * an in-process PGlite instead. This file's correctness rests on matching
 * supabase-js's documented `.rpc()` contract; it is not exercised by the
 * acceptance suite (see WP-P2-report.md "what remains unverifiable").
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NetworkError, PgError, TimeoutError, type SqlExecutor } from "./sql-executor.js";

export interface SupabaseExecutorConfig {
  /** Project URL, e.g. https://<ref>.supabase.co */
  url: string;
  /** Project anon (public) key — required by supabase-js as the `apikey` header even when a user JWT is also set. */
  anonKey: string;
  /** The calling principal's own Supabase Auth access token (agent credential; never an owner token from this path). */
  accessToken: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class SupabaseExecutor implements SqlExecutor {
  private readonly client: SupabaseClient;
  private readonly timeoutMs: number;

  constructor(cfg: SupabaseExecutorConfig) {
    this.client = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
    });
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const { data, error } = await this.client.rpc(fn, args, { signal: controller.signal } as never);
      if (error) {
        // PostgrestError shape: { message, details, hint, code }. A network-
        // level failure (fetch threw before a response arrived) surfaces
        // here as a plain Error from the underlying fetch, not this shape —
        // supabase-js normalizes it into the same `error` field, so detect
        // by the absence of a Postgres error `code`.
        if (!("code" in error) || !error.code) {
          throw new NetworkError(error.message ?? "network error calling Supabase RPC", error);
        }
        throw new PgError(error.message, error.code, error.details, error.hint);
      }
      return data;
    } catch (e) {
      if (e instanceof PgError || e instanceof NetworkError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new TimeoutError(`RPC ${fn} timed out after ${this.timeoutMs}ms`);
      }
      throw new NetworkError(e instanceof Error ? e.message : String(e), e);
    } finally {
      clearTimeout(timer);
    }
  }
}
