/**
 * SqlExecutor — the only surface CloudRepository/CloudAdminRepository use to
 * reach Postgres. Every access (reads included) goes through `rpc()`; there
 * is deliberately no raw `.from().select()` path, so there is exactly one
 * code path to reason about regardless of which RPC's security mode
 * (INVOKER vs DEFINER) is in play.
 *
 * Two implementations:
 *   - supabase-executor.ts (this package): real Supabase over HTTPS.
 *   - packages/core/test/harness/pglite-harness.mjs (WP-P2 test-only): real
 *     Postgres semantics via @electric-sql/pglite, no PostgREST, no network.
 */

export type SqlExecutorErrorKind = "network" | "timeout" | "pg";

export class NetworkError extends Error {
  readonly kind: SqlExecutorErrorKind = "network";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends Error {
  readonly kind: SqlExecutorErrorKind = "timeout";
  constructor(message: string, readonly operationId?: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A Postgres/PostgREST error that was actually delivered (not a transport failure). */
export class PgError extends Error {
  readonly kind: SqlExecutorErrorKind = "pg";
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PgError";
  }
}

export interface SqlExecutor {
  /** Calls RPC `fn` with `args`, returning its (already-JSON) result. Throws NetworkError | TimeoutError | PgError. */
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
}
