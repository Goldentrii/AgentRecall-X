// packages/core/src/supabase/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot, isTenantScoped } from "../types.js";

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
  /**
   * DOUBLE OPT-IN guard for corrections sync.
   *
   * /corrections/ is a PERSONAL_PATH_MARKER (classification.ts) — a deliberate
   * privacy-tier decision, not an oversight. Corrections carry the raw behavioral
   * layer (rules, context, tags) and are gated by default.
   *
   * To sync corrections to Supabase you must set BOTH:
   *   1. sync_personal=true  (existing cloud opt-in, Decision #6)
   *   2. sync_corrections=true  (this flag / AR_SYNC_CORRECTIONS=1)
   *
   * The synced payload is NEVER raw CorrectionRecord — it is always the
   * scrubbed CorrectionExport projection (exportCorrections) routed through
   * the existing doSync egress chokepoint. No new egress path is created.
   *
   * Env override: AR_SYNC_CORRECTIONS=1|true.
   */
  sync_corrections: boolean;
}

function configPath(): string {
  return path.join(getRoot(), "config.json");
}

export function readSupabaseConfig(): SupabaseConfig | null {
  // Hosted multi-tenant mode: Supabase is OFF. The client, remote recall backend
  // and embedding provider are process-wide singletons, and env overrides apply
  // to every tenant, so any of them would route one tenant's data through
  // another's project/key. Per-tenant backends are a later phase.
  if (isTenantScoped()) return null;
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
  // Corrections sync second opt-in (AR_SYNC_CORRECTIONS=1|true). Independent of
  // sync_personal — both must be true before corrections leave the machine.
  if (process.env.AR_SYNC_CORRECTIONS !== undefined) {
    config.sync_corrections = process.env.AR_SYNC_CORRECTIONS === "1" || process.env.AR_SYNC_CORRECTIONS === "true";
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
    sync_corrections: config.sync_corrections ?? false,
  };
}

export function writeSupabaseConfig(config: SupabaseConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
}
