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

  // Server-side secret key (see config.ts). This client never signs a user in,
  // so no auth session is persisted or refreshed.
  _client = createClient(config.supabase_url, config.supabase_secret_key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return _client;
}

/** Reset client (for testing). */
export function resetSupabaseClient(): void {
  _client = null;
}
