// packages/core/src/tools-logic/recall-backend.ts
import type { SmartRecallResultItem } from "./smart-recall.js";
import { readSupabaseConfig } from "../supabase/config.js";
import { LocalVectorRecallBackend } from "../vector/local-vector-backend.js";

/**
 * RecallBackend — thin read abstraction for recall search.
 * LocalRecallBackend wraps current keyword + RRF logic.
 * SupabaseRecallBackend adds pgvector semantic search (Task 8).
 */
export interface RecallBackend {
  search(
    query: string,
    project: string | undefined,
    limit: number
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
    limit: number
  ): Promise<SmartRecallResultItem[]> {
    // Import lazily to avoid circular dependency.
    // localRecallSearch is added to smart-recall.ts in Task 7.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("./smart-recall.js") as any;
    return mod.localRecallSearch(query, project, limit) as Promise<SmartRecallResultItem[]>;
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
let _consecutiveRemoteFailures = 0;
let _breakerTripped = false;

/** Record a remote search failure. Returns true if the breaker just tripped. */
export function recordRemoteFailure(): boolean {
  _consecutiveRemoteFailures += 1;
  if (!_breakerTripped && _consecutiveRemoteFailures >= BREAKER_THRESHOLD) {
    _breakerTripped = true;
    process.stderr.write(
      "[agent-recall] recall circuit breaker tripped: remote backend failed " +
      `${_consecutiveRemoteFailures}x in a row — using local backend for this process\n`
    );
    return true;
  }
  return false;
}

/** Record a successful remote search (resets the consecutive counter). */
export function recordRemoteSuccess(): void {
  _consecutiveRemoteFailures = 0;
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

/** Cached backend instance. Reset via resetRecallBackend() in tests. */
let _cachedBackend: RecallBackend | null = null;

/**
 * Get the configured RecallBackend.
 * Returns SupabaseRecallBackend if configured, available, and circuit not tripped.
 * Falls back to LocalVectorRecallBackend or LocalRecallBackend otherwise.
 * The function is async because the SupabaseRecallBackend module is loaded
 * via dynamic import (avoids pulling Supabase client when not configured).
 */
export async function getRecallBackend(): Promise<RecallBackend> {
  // If the breaker is tripped, always return local immediately.
  if (_breakerTripped) {
    return new LocalRecallBackend();
  }

  if (_cachedBackend) return _cachedBackend;

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
        _cachedBackend = backend;
        return backend;
      }
    }
  } catch {
    // Supabase not configured or module not yet available (Task 8).
  }

  // If OPENAI_API_KEY is set and no Supabase config, use local vector backend.
  const vectorBackend = new LocalVectorRecallBackend();
  if (vectorBackend.available()) {
    _cachedBackend = vectorBackend;
    return vectorBackend;
  }

  _cachedBackend = new LocalRecallBackend();
  return _cachedBackend;
}

/** Reset cached backend instance and circuit breaker (for testing). */
export function resetRecallBackend(): void {
  _cachedBackend = null;
  _consecutiveRemoteFailures = 0;
  _breakerTripped = false;
}
