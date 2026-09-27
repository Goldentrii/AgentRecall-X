// packages/core/src/supabase/client.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseConfig } from "./config.js";
import { singletonKey } from "../repository/singleton-key.js";
import { onRuntimeClose } from "../repository/context-store.js";

// G1 S2: was a single process-global `_client`, pinned to whichever root's
// config.json was read FIRST — every later root/context reused the first
// root's URL/anon-key for the rest of the process (credential/scope
// crossing). Keyed per runtime context (or per legacy root) instead;
// evicted on the owning runtime's close().
const _clients = new Map<string, SupabaseClient>();
onRuntimeClose((key) => { _clients.delete(key); });

/**
 * Get a Supabase client scoped to the calling context's root/config.
 * Returns null if not configured. One client per distinct context; reused
 * for the lifetime of that context (or the process, for legacy callers with
 * no active MemoryRuntime — same behavior as before when there is only ever
 * one root in the process).
 */
export function getSupabaseClient(): SupabaseClient | null {
  const key = singletonKey();
  const cached = _clients.get(key);
  if (cached) return cached;

  const config = readSupabaseConfig();
  if (!config) return null;

  const client = createClient(config.supabase_url, config.supabase_anon_key);
  _clients.set(key, client);
  return client;
}

/** Reset all cached clients (for testing). */
export function resetSupabaseClient(): void {
  _clients.clear();
}
