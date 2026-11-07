// packages/core/src/supabase/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

/**
 * Supabase mirror configuration.
 *
 * SECURITY (2026-11-07): AgentRecall is a single-owner, server-side client, so
 * it authenticates with the project's SECRET key (`sb_secret_…`, or the legacy
 * `service_role` JWT). That key maps to Postgres role `service_role`, which has
 * BYPASSRLS. The `ar_*` tables have Row Level Security enabled with NO policies
 * and no anon/authenticated grants (migration.sql,
 * migrations/2026-11-07-enable-rls.sql), so the anon/publishable key — which
 * Supabase designs to be public — can read and write nothing.
 *
 * Key resolution order: AGENT_RECALL_SUPABASE_KEY env → config.json
 * `supabase_secret_key` → config.json `supabase_anon_key` (deprecated field
 * name, still honoured). A recognisably public key still works (so an install
 * that has not applied the RLS migration keeps syncing) but triggers a one-time
 * stderr warning. Key values are never logged.
 */
export interface SupabaseConfig {
  supabase_url: string;
  /** Server-side secret key: `sb_secret_…` or the legacy `service_role` JWT. Never the anon/publishable key. */
  supabase_secret_key: string;
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

/** On-disk shape: `supabase_anon_key` is the pre-2026-11 field name, read as a fallback only. */
type StoredSupabaseConfig = Partial<SupabaseConfig> & { supabase_anon_key?: string };

export type SupabaseKeyKind = "secret" | "public" | "unknown";

/**
 * Classify a Supabase API key WITHOUT ever echoing it.
 *   secret  — `sb_secret_…`, or a legacy JWT whose payload role is `service_role`
 *   public  — `sb_publishable_…`, or a legacy JWT whose role is `anon`/`authenticated`
 *   unknown — anything else (test fixtures, malformed values)
 */
export function classifySupabaseKey(key: string): SupabaseKeyKind {
  const k = key.trim();
  if (k.startsWith("sb_secret_")) return "secret";
  if (k.startsWith("sb_publishable_")) return "public";
  if (isJwtSupabaseKey(k)) {
    try {
      const payload = JSON.parse(Buffer.from(k.split(".")[1], "base64url").toString("utf-8")) as { role?: unknown };
      if (payload.role === "service_role") return "secret";
      if (payload.role === "anon" || payload.role === "authenticated") return "public";
    } catch {
      // not a decodable JWT — fall through
    }
  }
  return "unknown";
}

/** True for legacy JWT-format keys, which (unlike `sb_…` keys) are also valid as `Authorization: Bearer`. */
export function isJwtSupabaseKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key.trim());
}

const PUBLIC_KEY_WARNING =
  "[agent-recall] WARNING: the configured Supabase key is a PUBLIC anon/publishable key. " +
  "Until Row Level Security is enabled, anyone with your project URL and that key can read and write your synced memory; " +
  "once it is enabled (migrations/2026-11-07-enable-rls.sql), that key can no longer sync at all. " +
  "Set your project's SECRET key (sb_secret_..., Supabase dashboard -> Settings -> API Keys) as " +
  "\"supabase_secret_key\" in config.json or AGENT_RECALL_SUPABASE_KEY. See docs/supabase.md.\n";

const LEGACY_FIELD_WARNING =
  "[agent-recall] config.json field \"supabase_anon_key\" is deprecated: rename it to \"supabase_secret_key\". " +
  "It must hold your project's SECRET key (sb_secret_...), not the anon/publishable key. See docs/supabase.md.\n";

const emittedWarnings = new Set<string>();

function warnOnce(message: string): void {
  if (emittedWarnings.has(message)) return;
  emittedWarnings.add(message);
  try {
    process.stderr.write(message);
  } catch {
    // stderr unavailable — a warning must never break config resolution
  }
}

const INSECURE_URL_WARNING =
  "[agent-recall] Supabase sync DISABLED: supabase_url must use https:// (plain http:// is allowed only for " +
  "localhost / 127.0.0.1 / [::1]). The configured key is a secret and is never sent over an unencrypted or " +
  "non-HTTP transport. Fix supabase_url in config.json or AGENT_RECALL_SUPABASE_URL.\n";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The secret key travels with every request, so refuse a well-formed URL whose
 * transport would expose it: anything but https, except http to loopback for
 * local dev. An UNPARSABLE url is left alone: it cannot carry the key anywhere,
 * and the client's own error path (sync-errors.log) already reports it.
 */
export function isAllowedSupabaseUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return true;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/** Reset the once-per-process warning guard (tests only). */
export function resetSupabaseConfigWarnings(): void {
  emittedWarnings.clear();
}

export function readSupabaseConfig(): SupabaseConfig | null {
  let config: StoredSupabaseConfig = {};

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
  // Key resolution: env → supabase_secret_key → legacy supabase_anon_key.
  let key = config.supabase_secret_key;
  let fromLegacyField = false;
  if (process.env.AGENT_RECALL_SUPABASE_KEY) {
    key = process.env.AGENT_RECALL_SUPABASE_KEY;
  } else if (!key && config.supabase_anon_key) {
    key = config.supabase_anon_key;
    fromLegacyField = true;
  }
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

  if (!config.supabase_url || !key) return null;
  if (config.sync_enabled === false) return null;
  if (!isAllowedSupabaseUrl(config.supabase_url)) {
    warnOnce(INSECURE_URL_WARNING);
    return null;
  }

  if (classifySupabaseKey(key) === "public") warnOnce(PUBLIC_KEY_WARNING);
  else if (fromLegacyField) warnOnce(LEGACY_FIELD_WARNING);

  return {
    supabase_url: config.supabase_url,
    supabase_secret_key: key,
    embedding_provider: config.embedding_provider ?? "openai",
    embedding_api_key: config.embedding_api_key ?? "",
    sync_enabled: config.sync_enabled ?? true,
    sync_personal: config.sync_personal ?? false,
    sync_corrections: config.sync_corrections ?? false,
  };
}

/**
 * Persist the config. The file holds a secret key, so it is written owner-only
 * (0600; best-effort — Windows ignores POSIX modes) and the deprecated
 * `supabase_anon_key` field is never written.
 */
export function writeSupabaseConfig(config: SupabaseConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const { supabase_anon_key: _legacy, ...toWrite } = config as SupabaseConfig & { supabase_anon_key?: string };
  fs.writeFileSync(p, JSON.stringify(toWrite, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort (filesystems without POSIX modes)
  }
}
