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
// Backend factory
// ---------------------------------------------------------------------------

/** Cached backend instance. Reset via resetRecallBackend() in tests. */
let _cachedBackend: RecallBackend | null = null;

/**
 * Get the configured RecallBackend.
 * Returns SupabaseRecallBackend if configured and reachable, else Local.
 * The function is async because the SupabaseRecallBackend module is loaded
 * via dynamic import (avoids pulling Supabase client when not configured).
 */
export async function getRecallBackend(): Promise<RecallBackend> {
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
  } catch (err) {
    // Supabase not configured or module not yet available (Task 8).
    process.stderr.write(`[agent-recall] backend load error: ${err}\n`);
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

/** Reset cached backend instance (for testing). */
export function resetRecallBackend(): void {
  _cachedBackend = null;
}
