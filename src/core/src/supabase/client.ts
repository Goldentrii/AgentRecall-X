// packages/core/src/supabase/client.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseConfig } from "./config.js";

let _client: SupabaseClient | null = null;

/**
 * Get a Supabase client. Returns null if not configured.
 * Singleton — created once, reused for the process lifetime.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (_client) return _client;

  const config = readSupabaseConfig();
  if (!config) return null;

  _client = createClient(config.supabase_url, config.supabase_anon_key);
  return _client;
}

/** Reset client (for testing). */
export function resetSupabaseClient(): void {
  _client = null;
}
