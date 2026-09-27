// packages/core/src/tools-logic/recall-backend.ts
import type { SmartRecallResultItem } from "./smart-recall.js";
import { readSupabaseConfig } from "../supabase/config.js";
import { LocalVectorRecallBackend } from "../vector/local-vector-backend.js";
import { singletonKey } from "../repository/singleton-key.js";
import { onRuntimeClose } from "../repository/context-store.js";

/**
 * RecallBackend — thin read abstraction for recall search.
 * LocalRecallBackend wraps current keyword + RRF logic.
 * SupabaseRecallBackend adds pgvector semantic search (Task 8).
 */
export interface RecallBackend {
  search(
    query: string,
    project: string | undefined,
    limit: number,
    /** fix4b (2026-09-12): opt-in legacy hot-window boost — meaningful for
     *  the LOCAL keyword backend only (see SmartRecallInput.freshnessBias);
     *  remote/vector backends have their own scoring and may ignore it
     *  (their implementations simply omit the parameter). */
    opts?: { freshnessBias?: boolean }
  ): Promise<SmartRecallResultItem[]>;
  available(): boolean;
}

/**
 * LocalRecallBackend — delegates to the existing smartRecall internals.
 * This is a pass-through wrapper to satisfy the interface; the actual
 * logic stays in smart-recall.ts (no code duplication).
 */
export class LocalRecallBackend implements RecallBackend {
  available(): boolean {
    return true;
  }

  async search(
    query: string,
    project: string | undefined,
    limit: number,
    opts?: { freshnessBias?: boolean }
  ): Promise<SmartRecallResultItem[]> {
    // Import lazily to avoid circular dependency.
    // localRecallSearch is added to smart-recall.ts in Task 7.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("./smart-recall.js") as any;
    return mod.localRecallSearch(
      query, project, limit, undefined, opts?.freshnessBias,
    ) as Promise<SmartRecallResultItem[]>;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Module-level consecutive failure counter for the remote (Supabase) backend.
 * After BREAKER_THRESHOLD failures in a row the breaker trips and
 * getRecallBackend() returns the local backend for the rest of the process.
 * Logged once to stderr so operators can see it; reset with resetRecallBackend().
 */
const BREAKER_THRESHOLD = 2;

// G1 S3/S4: was a single process-global cache + breaker, pinned to whichever
// root/config was seen FIRST — failures against root A's cloud silently
// disabled remote recall for root B for the rest of the process, and A's
// cloud config served every later root's queries (privacy breach). Keyed per
// runtime context (or per legacy root); evicted on the owning runtime's close().
interface Breaker { consecutiveFailures: number; tripped: boolean }
const _breakers = new Map<string, Breaker>();

function breakerFor(key: string): Breaker {
  let b = _breakers.get(key);
  if (!b) {
    b = { consecutiveFailures: 0, tripped: false };
    _breakers.set(key, b);
  }
  return b;
}

/** Record a remote search failure. Returns true if the breaker just tripped. */
export function recordRemoteFailure(): boolean {
  const key = singletonKey();
  const b = breakerFor(key);
  b.consecutiveFailures += 1;
  if (!b.tripped && b.consecutiveFailures >= BREAKER_THRESHOLD) {
    b.tripped = true;
    process.stderr.write(
      "[agent-recall] recall circuit breaker tripped: remote backend failed " +
      `${b.consecutiveFailures}x in a row — using local backend for this context\n`
    );
    return true;
  }
  return false;
}

/** Record a successful remote search (resets the consecutive counter). */
export function recordRemoteSuccess(): void {
  const b = breakerFor(singletonKey());
  b.consecutiveFailures = 0;
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

/** Cached backend instances, keyed per context. Reset via resetRecallBackend() in tests. */
const _cachedBackends = new Map<string, RecallBackend>();

onRuntimeClose((key) => {
  _cachedBackends.delete(key);
  _breakers.delete(key);
});

/**
 * Get the configured RecallBackend.
 * Returns SupabaseRecallBackend if configured, available, and circuit not tripped.
 * Falls back to LocalVectorRecallBackend or LocalRecallBackend otherwise.
 * The function is async because the SupabaseRecallBackend module is loaded
 * via dynamic import (avoids pulling Supabase client when not configured).
 */
export async function getRecallBackend(): Promise<RecallBackend> {
  const key = singletonKey();

  // If this context's breaker is tripped, always return local immediately.
  if (breakerFor(key).tripped) {
    return new LocalRecallBackend();
  }

  const cached = _cachedBackends.get(key);
  if (cached) return cached;

  try {
    const config = readSupabaseConfig();
    if (config) {
      // Dynamic import so the Supabase client is only loaded when configured.
      // This module is created in Task 8; until then the import throws and we
      // fall through to LocalRecallBackend gracefully.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import("../supabase/recall-backend.js" as any) as any;
      const backend = new mod.SupabaseRecallBackend(config) as RecallBackend;
      if (backend.available()) {
        _cachedBackends.set(key, backend);
        return backend;
      }
    }
  } catch {
    // Supabase not configured or module not yet available (Task 8).
  }

  // If OPENAI_API_KEY is set and no Supabase config, use local vector backend.
  const vectorBackend = new LocalVectorRecallBackend();
  if (vectorBackend.available()) {
    _cachedBackends.set(key, vectorBackend);
    return vectorBackend;
  }

  const local = new LocalRecallBackend();
  _cachedBackends.set(key, local);
  return local;
}

/** Reset all cached backend instances and circuit breakers (for testing). */
export function resetRecallBackend(): void {
  _cachedBackends.clear();
  _breakers.clear();
}
