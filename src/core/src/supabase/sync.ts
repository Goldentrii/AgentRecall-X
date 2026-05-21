// packages/core/src/supabase/sync.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSupabaseClient } from "./client.js";
import { readSupabaseConfig } from "./config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";

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
  const logPath = path.join(os.homedir(), ".agent-recall", "sync-errors.log");
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
  store: "journal" | "palace" | "awareness" | "digest",
  room?: string
): void {
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

    const hash = contentHash(content);

    const { data: existing } = await client
      .from("ar_sync_state")
      .select("file_hash")
      .eq("file_path", filePath)
      .single();

    if (existing?.file_hash === hash) return;

    const parsed = parseMemoryFile(content);
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

export async function backfill(
  project: string,
  files: Array<{ path: string; content: string; store: "journal" | "palace" | "awareness" | "digest"; room?: string }>
): Promise<{ synced: number; skipped: number; failed: number }> {
  const client = getSupabaseClient();
  if (!client) return { synced: 0, skipped: 0, failed: 0 };

  let synced = 0, skipped = 0, failed = 0;

  for (const file of files) {
    try {
      const hash = contentHash(file.content);
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
