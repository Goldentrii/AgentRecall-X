/**
 * embeddings/indexer.ts — fix7: incremental, content-hash-keyed index build.
 *
 * INCREMENTAL BY CONSTRUCTION: chunks are keyed by sha256(content) (see
 * embeddings/chunker.ts), so a rebuild embeds ONLY hashes not already in
 * the on-disk index — unchanged content is never re-embedded, and renaming/
 * moving a file costs nothing (path-independent keys; the repo's
 * content-hash cache pattern). `force: true` re-embeds everything.
 *
 * PRUNING: a FULL build (no `projects` filter) enumerates the complete
 * retrievable corpus, so hashes absent from the enumeration are dropped
 * (stale vectors from deleted/edited content). A project-SCOPED build only
 * adds/updates — it cannot know whether an unrecognized hash belongs to an
 * unenumerated project, so it never prunes (documented CLI behavior).
 *
 * NEVER runs on the recall path — index building is a CLI/explicit-API
 * operation only (`ar embeddings rebuild`); recall reads the index and
 * degrades if it is missing/stale (retrieval/semantic-leg.ts).
 */

import * as fs from "node:fs";
import { projectsRootDir } from "../storage/paths.js";
import { chunkProject, chunkGlobalInsights, type EmbeddingChunk } from "./chunker.js";
import { getEmbedder } from "./runtime.js";
import { resolveEmbeddingModel, type EmbeddingModelSpec } from "./config.js";
import { readEmbeddingIndex, writeEmbeddingIndex } from "./index-store.js";

export interface BuildEmbeddingsOptions {
  /** Restrict to these project slugs (default: every dir under projects/,
   *  `_`-namespace excluded — the same BY-NAME reserved-namespace rule the
   *  rest of the store uses). */
  projects?: string[];
  /** Re-embed every chunk even if its hash is already indexed. */
  force?: boolean;
  /** Model override (default: resolveEmbeddingModel()). */
  model?: EmbeddingModelSpec;
  /** Progress callback (CLI renders it; embedding a large store takes
   *  minutes on first build). */
  onProgress?: (done: number, total: number) => void;
  /** Embed batch size (texts per model call). */
  batchSize?: number;
}

export interface BuildEmbeddingsReport {
  ok: boolean;
  error?: { reason: string; message: string };
  model: string;
  dim: number;
  indexPath?: string;
  projects: string[];
  totalChunks: number;
  embeddedNew: number;
  reused: number;
  pruned: number;
  durationMs: number;
}

function listProjectDirs(): string[] {
  try {
    const root = projectsRootDir();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build (or incrementally update) the embedding index.
 *
 * The write is one atomic, locked replacement of the whole index file
 * (embeddings/index-store.ts) — a crash mid-build leaves the previous index
 * intact, and concurrent recalls keep reading the old file until rename.
 */
export async function buildEmbeddingsIndex(opts: BuildEmbeddingsOptions = {}): Promise<BuildEmbeddingsReport> {
  const t0 = performance.now();
  const spec = opts.model ?? resolveEmbeddingModel();
  const scoped = Array.isArray(opts.projects) && opts.projects.length > 0;
  const projects = scoped ? opts.projects! : listProjectDirs();

  const report: BuildEmbeddingsReport = {
    ok: false,
    model: spec.id,
    dim: spec.dim,
    projects,
    totalChunks: 0,
    embeddedNew: 0,
    reused: 0,
    pruned: 0,
    durationMs: 0,
  };

  // Rebuild is offline-strict: the ONLY sanctioned downloader is
  // `ar embeddings setup` (embeddings/runtime.ts's network contract).
  const embedder = await getEmbedder(spec, { allowRemote: false });
  if ("error" in embedder) {
    report.error = embedder.error;
    report.durationMs = performance.now() - t0;
    return report;
  }

  // ---- enumerate + dedupe chunks (hash-keyed; identical content once) ----
  const chunksByHash = new Map<string, EmbeddingChunk>();
  for (const project of projects) {
    for (const chunk of chunkProject(project, { skipInsights: true })) {
      if (!chunksByHash.has(chunk.hash)) chunksByHash.set(chunk.hash, chunk);
    }
  }
  for (const chunk of chunkGlobalInsights()) {
    if (!chunksByHash.has(chunk.hash)) chunksByHash.set(chunk.hash, chunk);
  }
  report.totalChunks = chunksByHash.size;

  // ---- reuse existing vectors (content-hash cache hit) ----
  // fix7 review M1 (2026-09-12): the existing index is ALWAYS read first.
  //  - scoped build over a CORRUPT/mismatched index → REFUSE: a scoped
  //    build cannot preserve other projects' vectors it cannot read, and
  //    proceeding would silently narrow the index to the scoped project
  //    while reporting pruned: 0 (the reviewer's reproduced data-loss bug).
  //    A MISSING index is fine (fresh partial build, coverage diagnosable).
  //  - scoped + force → re-embed the scoped chunk set but PRESERVE every
  //    foreign hash (previously `force` dropped the whole existing index).
  //  - full + force → rebuild from scratch (unchanged).
  const existing = readEmbeddingIndex(spec);
  const existingErr = "error" in existing ? existing.error : null;
  const existingOk = existingErr ? null : (existing as Exclude<typeof existing, { error: unknown }>);
  if (scoped && existingErr && existingErr.reason !== "missing") {
    report.error = {
      reason: "existing-index-unreadable",
      message:
        `existing index unreadable (${existingErr.message}) — a project-scoped build cannot ` +
        `preserve other projects' vectors from an unreadable index; run a full \`ar embeddings rebuild\``,
    };
    report.durationMs = performance.now() - t0;
    return report;
  }
  // Which existing index (if any) backs the scoped-preserve block below,
  // and whether CURRENT-set hashes may reuse cached vectors.
  const reusable = existingOk && (scoped || !opts.force) ? existingOk : null;
  const reuseCurrent = !opts.force;

  const outHashes: string[] = [];
  const rows: Float32Array[] = [];
  const toEmbed: EmbeddingChunk[] = [];
  for (const [hash, chunk] of chunksByHash) {
    const row = reuseCurrent ? reusable?.rowByHash.get(hash) : undefined;
    if (row !== undefined) {
      outHashes.push(hash);
      rows.push(reusable!.vectors.subarray(row * spec.dim, (row + 1) * spec.dim));
      report.reused++;
    } else {
      toEmbed.push(chunk);
    }
  }

  // Scoped builds keep every unrecognized existing hash (cannot prove it
  // stale — see file header); full builds drop them (that IS the prune).
  if (reusable && scoped) {
    const current = new Set(outHashes);
    for (let i = 0; i < reusable.hashes.length; i++) {
      const hash = reusable.hashes[i];
      if (current.has(hash) || chunksByHash.has(hash)) continue;
      outHashes.push(hash);
      rows.push(reusable.vectors.subarray(i * spec.dim, (i + 1) * spec.dim));
    }
  } else if (reusable) {
    report.pruned = reusable.hashes.length - report.reused;
  }

  // ---- embed the new chunks in batches ----
  const batchSize = opts.batchSize ?? 16;
  let done = 0;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const vecs = await embedder.embedPassages(batch.map((c) => c.text));
    for (let j = 0; j < batch.length; j++) {
      if (!vecs[j] || vecs[j].length !== spec.dim) continue; // defensive — skip malformed rows
      outHashes.push(batch[j].hash);
      rows.push(vecs[j]);
      report.embeddedNew++;
    }
    done += batch.length;
    opts.onProgress?.(done, toEmbed.length);
  }

  // ---- write (locked, atomic) ----
  const flat = new Float32Array(outHashes.length * spec.dim);
  for (let i = 0; i < rows.length; i++) flat.set(rows[i], i * spec.dim);
  report.indexPath = await writeEmbeddingIndex(spec, outHashes, flat);
  report.ok = true;
  report.durationMs = performance.now() - t0;
  return report;
}

export interface EmbeddingsStatus {
  enabled: boolean;
  model: string;
  dim: number;
  runtimeInstalled: boolean;
  modelCached: boolean;
  indexPath: string;
  indexExists: boolean;
  indexCount?: number;
  indexBuiltAt?: string;
  indexBytes?: number;
  indexError?: string;
}

/** Diagnostic snapshot for `ar embeddings status`. Read-only. */
export async function embeddingsStatus(): Promise<EmbeddingsStatus> {
  const { embeddingsEnabled, embeddingsIndexPath } = await import("./config.js");
  const { runtimeInstalled, modelCached } = await import("./runtime.js");
  const spec = resolveEmbeddingModel();
  const indexPath = embeddingsIndexPath(spec);
  const status: EmbeddingsStatus = {
    enabled: embeddingsEnabled(),
    model: spec.id,
    dim: spec.dim,
    runtimeInstalled: runtimeInstalled(),
    modelCached: modelCached(spec),
    indexPath,
    indexExists: fs.existsSync(indexPath),
  };
  if (status.indexExists) {
    try {
      status.indexBytes = fs.statSync(indexPath).size;
    } catch { /* best-effort */ }
    const index = readEmbeddingIndex(spec);
    if ("error" in index) {
      status.indexError = index.error.message;
    } else {
      status.indexCount = index.hashes.length;
      status.indexBuiltAt = index.builtAt;
    }
  }
  return status;
}
