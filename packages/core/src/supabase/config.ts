// packages/core/src/supabase/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

export interface SupabaseConfig {
  supabase_url: string;
  supabase_anon_key: string;
  embedding_provider: "openai" | "voyage";
  embedding_api_key: string;
  sync_enabled: boolean;
  /**
   * Whether personal-tier data (corrections-derived awareness / Blind Spots,
   * `_global` palace) is allowed to leave the machine via Supabase. Defaults to
   * `false` — the privacy boundary (Decision #6). Flipping this to `true`
   * re-feeds the war-room dashboard's `ar_awareness` reads.
   * Env override: AGENT_RECALL_SYNC_PERSONAL=true|false.
   */
  sync_personal: boolean;
}

function configPath(): string {
  return path.join(getRoot(), "config.json");
}

export function readSupabaseConfig(): SupabaseConfig | null {
  let config: Partial<SupabaseConfig> = {};

  const p = configPath();
  if (fs.existsSync(p)) {
    try {
      config = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  // Env var overrides
  if (process.env.AGENT_RECALL_SUPABASE_URL) config.supabase_url = process.env.AGENT_RECALL_SUPABASE_URL;
  if (process.env.AGENT_RECALL_SUPABASE_KEY) config.supabase_anon_key = process.env.AGENT_RECALL_SUPABASE_KEY;
  if (process.env.AGENT_RECALL_EMBEDDING_PROVIDER) config.embedding_provider = process.env.AGENT_RECALL_EMBEDDING_PROVIDER as "openai" | "voyage";
  if (process.env.AGENT_RECALL_EMBEDDING_KEY) config.embedding_api_key = process.env.AGENT_RECALL_EMBEDDING_KEY;
  // Personal-data egress flag (default false). Present-but-any-value env wins over file.
  if (process.env.AGENT_RECALL_SYNC_PERSONAL !== undefined) {
    config.sync_personal = process.env.AGENT_RECALL_SYNC_PERSONAL === "true";
  }

  if (!config.supabase_url || !config.supabase_anon_key) return null;
  if (config.sync_enabled === false) return null;

  return {
    supabase_url: config.supabase_url,
    supabase_anon_key: config.supabase_anon_key,
    embedding_provider: config.embedding_provider ?? "openai",
    embedding_api_key: config.embedding_api_key ?? "",
    sync_enabled: config.sync_enabled ?? true,
    sync_personal: config.sync_personal ?? false,
  };
}

export function writeSupabaseConfig(config: SupabaseConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
}
