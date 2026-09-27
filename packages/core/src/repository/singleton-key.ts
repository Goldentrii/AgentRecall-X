/**
 * Shared key helper for the root-derived process singletons G1 flagged as
 * unkeyed (S2 supabase client, S3/S4 recall backend + breaker, S5 embedding
 * provider, S6 memory backend). Each of those modules swaps its single
 * cached value for a `Map<string, T>` keyed by this function's return value,
 * with exported function signatures UNCHANGED (their callers — smart-recall
 * .ts, session-start.ts, etc. — are frozen/owned by WP-P3 and must not be
 * touched here).
 */
import { getRoot } from "../types.js";
import { currentSingletonKey } from "./context-store.js";

/** Current effective singleton-cache key: runtime ctx.key if inside one, else a root-only legacy key. */
export function singletonKey(): string {
  return currentSingletonKey(getRoot());
}
