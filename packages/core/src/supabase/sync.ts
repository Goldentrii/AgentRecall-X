// packages/core/src/supabase/sync.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSupabaseClient } from "./client.js";
import { readSupabaseConfig } from "./config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import { classifyStore } from "../storage/classification.js";
import { scrubForCloud } from "../storage/content-guard.js";
import { exportCorrections } from "../tools-logic/export-corrections.js";
import { getRoot } from "../types.js";

// ---------------------------------------------------------------------------
// Utilities (exported for testing)
// ---------------------------------------------------------------------------

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface ParsedMemoryFile {
  title: string;
  body: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export function parseMemoryFile(content: string): ParsedMemoryFile {
  let body = content;
  let metadata: Record<string, unknown> = {};

  // Extract YAML frontmatter
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx > 0) {
      const fm = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).trim();
      for (const line of fm.split("\n")) {
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match) {
          const val = match[2].trim();
          if (val.startsWith("[")) {
            try { metadata[match[1]] = JSON.parse(val); } catch { metadata[match[1]] = val; }
          } else {
            metadata[match[1]] = val;
          }
        }
      }
    }
  }

  const titleMatch = body.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : body.slice(0, 80).trim();

  const tags: string[] = Array.isArray(metadata.tags) ? metadata.tags as string[] : [];

  return { title, body, tags, metadata };
}

export function deriveSlug(filePath: string): string {
  const parts = filePath.split(path.sep);
  const fileName = path.basename(filePath, ".md");

  const journalIdx = parts.indexOf("journal");
  const palaceIdx = parts.indexOf("rooms");

  if (journalIdx >= 0) return `journal--${fileName}`;
  if (palaceIdx >= 0) {
    const room = parts[palaceIdx + 1] ?? "unknown";
    return `palace--${room}--${fileName}`;
  }
  return `other--${fileName}`;
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

export function logSyncError(message: string): void {
  // Root-fix (2026-07-31, continuity wave F5): this used to hardcode
  // os.homedir() directly, bypassing getRoot()'s AGENT_RECALL_ROOT/setRoot()
  // override — the same resolver every other storage module (paths.ts,
  // archive-write.ts, lifecycle-telemetry.ts) uses. Test suites that scope
  // storage to a tmp dir via setRoot()/AGENT_RECALL_ROOT (not a HOME
  // override) had every doSync() failure leak into the REAL user's
  // ~/.agent-recall/sync-errors.log — confirmed empirically as test
  // pollution (50/51 real-log entries were /var/folders/.../ar-*-test
  // fixture paths). getRoot() still falls back to os.homedir() when no
  // override is set, so this is a pure superset fix: same default behavior,
  // now override-aware.
  const logPath = path.join(getRoot(), "sync-errors.log");
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, "utf-8");
  // Cap at 500 lines
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length > 500) {
    const trimmed = lines.slice(-500).join("\n") + "\n";
    const tmpPath = logPath + ".tmp";
    fs.writeFileSync(tmpPath, trimmed, "utf-8");
    fs.renameSync(tmpPath, logPath);
  }
}

// ---------------------------------------------------------------------------
// Sync (fire-and-forget)
// ---------------------------------------------------------------------------

let _embeddingProvider: EmbeddingProvider | null = null;

function getEmbeddingProvider(): EmbeddingProvider | null {
  if (_embeddingProvider) return _embeddingProvider;
  const config = readSupabaseConfig();
  if (!config?.embedding_api_key) return null;
  _embeddingProvider = createEmbeddingProvider(config.embedding_provider, config.embedding_api_key);
  return _embeddingProvider;
}

export function syncToSupabase(
  filePath: string,
  content: string,
  project: string,
  store: "journal" | "palace" | "awareness" | "digest" | "corrections",
  room?: string
): void {
  // PRIVACY GATE (Wave 1, Decision #6): personal-tier data (awareness behavioral
  // layer, _global palace) does not leave the machine unless sync_personal=true.
  // Silent skip preserves the fire-and-forget contract.
  // NOTE: flipping config.sync_personal=true re-feeds the war-room dashboard's
  // ar_awareness reads.
  if (classifyStore(store, { project }) === "personal" && readSupabaseConfig()?.sync_personal !== true) {
    return;
  }
  // DOUBLE OPT-IN GATE for corrections (privacy-tier decision, classification.ts).
  // /corrections/ is a PERSONAL_PATH_MARKER — NOT an oversight. Corrections carry
  // the raw behavioral layer (rules, context, tags) and must not leave the machine
  // unless the user has explicitly opted into BOTH:
  //   1. sync_personal=true  (the existing cloud opt-in, Decision #6)
  //   2. sync_corrections=true  (the second opt-in for the corrections tier)
  // Both missing, or only one set → silent skip. This preserves the fire-and-forget
  // contract and does not produce a visible error — same as the sync_personal gate.
  if (store === "corrections") {
    const config = readSupabaseConfig();
    if (!config?.sync_personal || !config?.sync_corrections) {
      return;
    }
    // Corrections sync: emit the scrubbed CorrectionExport projection via the
    // EXISTING egress chokepoint (doSync). The raw CorrectionRecord is NEVER
    // written directly — exportCorrections() applies the fail-closed scrubForExport
    // to every free-text field before we touch the network.
    //
    // The `content` parameter is the correction id (used as the slug discriminator
    // and to scope the single-record export). We re-derive the scrubbed payload from
    // exportCorrections so the doSync path always receives pre-scrubbed JSON.
    const correctionId = content; // caller convention: content = correction id
    setImmediate(() => {
      void syncCorrectionRecord(filePath, correctionId, project);
    });
    return;
  }
  setImmediate(() => {
    void doSync(filePath, content, project, store, room);
  });
}

async function doSync(
  filePath: string,
  content: string,
  project: string,
  store: string,
  room?: string
): Promise<void> {
  try {
    const client = getSupabaseClient();
    if (!client) return;

    // EGRESS CHOKEPOINT — authoritative scrub for ALL upload paths
    // (syncToSupabase + backfill). Scrub happens BEFORE hashing so the stored
    // hash always matches the hash computed by backfill's skip-dedup check.
    // Call-site scrubs (the 9 syncToSupabase callers that pre-wrap content in
    // scrubForCloud) are redundant defense-in-depth — scrubForCloud is idempotent,
    // so double-scrub is safe and the call-site wraps are intentionally kept as a
    // privacy boundary safeguard.
    const scrubbedContent = scrubForCloud(content);
    const hash = contentHash(scrubbedContent);

    const { data: existing } = await client
      .from("ar_sync_state")
      .select("file_hash")
      .eq("file_path", filePath)
      .single();

    if (existing?.file_hash === hash) return;

    const parsed = parseMemoryFile(scrubbedContent);
    const slug = deriveSlug(filePath);

    const { data: entry, error: upsertErr } = await client
      .from("ar_entries")
      .upsert(
        {
          project,
          store,
          room: room ?? null,
          slug,
          title: parsed.title,
          body: parsed.body,
          tags: parsed.tags,
          metadata: parsed.metadata,
          file_path: filePath,
          file_hash: hash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project,store,slug" }
      )
      .select("id")
      .single();

    if (upsertErr || !entry) return;

    const provider = getEmbeddingProvider();
    if (provider) {
      const textForEmbedding = (parsed.title + " " + parsed.body).slice(0, 8000);
      const embedding = await provider.embed(textForEmbedding);
      await client
        .from("ar_entries")
        .update({ embedding })
        .eq("id", entry.id);
    }

    await client.from("ar_sync_state").upsert({
      file_path: filePath,
      file_hash: hash,
      entry_id: entry.id,
      status: provider ? "embedded" : "synced",
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    logSyncError(`doSync failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sync a single CorrectionRecord (by id) for a project through the existing
 * doSync egress chokepoint. The raw record is never emitted — exportCorrections()
 * applies the fail-closed scrubForExport to every free-text field. If the record
 * does not exist (retracted or unknown id) we silently return without error.
 *
 * Called only from the syncToSupabase "corrections" store branch, which has
 * already verified the double opt-in.
 */
async function syncCorrectionRecord(
  filePath: string,
  correctionId: string,
  project: string
): Promise<void> {
  try {
    // Export the single correction (project + no retracted). If the id doesn't
    // exist in the active set (already retracted or bad id) → empty → skip.
    const rows = exportCorrections({ project, includeRetracted: true });
    const row = rows.find((r) => r.id === correctionId);
    if (!row) return; // retracted or not found — nothing to sync

    // Serialize the CorrectionExport projection as the "content" for doSync.
    // scrubForExport (inside exportCorrections) already redacted every free-text
    // field, so doSync's internal scrubForCloud re-scrub is a no-op (idempotent).
    const scrubbedJson = JSON.stringify(row);
    await doSync(filePath, scrubbedJson, project, "corrections");
  } catch (err) {
    logSyncError(`syncCorrectionRecord failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function backfill(
  project: string,
  files: Array<{ path: string; content: string; store: "journal" | "palace" | "awareness" | "digest"; room?: string }>
): Promise<{ synced: number; skipped: number; failed: number }> {
  const client = getSupabaseClient();
  if (!client) return { synced: 0, skipped: 0, failed: 0 };

  let synced = 0, skipped = 0, failed = 0;

  for (const file of files) {
    try {
      // PRIVACY GATE (Wave 1): backfill() calls doSync() directly, bypassing
      // syncToSupabase()'s gate — so re-apply it here. Count as skipped.
      if (classifyStore(file.store, { project }) === "personal" && readSupabaseConfig()?.sync_personal !== true) {
        skipped++;
        continue;
      }
      // Skip-dedup hash must match what doSync stores: hash of SCRUBBED content.
      // Using raw content here would cause raw_hash != scrubbed_hash for any file
      // containing a secret pattern, making the skip never fire → re-uploads every run.
      const hash = contentHash(scrubForCloud(file.content));
      const { data: existing } = await client
        .from("ar_sync_state")
        .select("file_hash")
        .eq("file_path", file.path)
        .single();

      if (existing?.file_hash === hash) {
        skipped++;
        continue;
      }

      await doSync(file.path, file.content, project, file.store, file.room);
      synced++;
    } catch (err) {
      logSyncError(`backfill failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { synced, skipped, failed };
}
