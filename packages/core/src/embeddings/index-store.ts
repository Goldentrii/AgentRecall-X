/**
 * embeddings/index-store.ts — fix7: the persistent, content-hash-keyed
 * vector index.
 *
 * WHAT IT STORES — hash→vector ONLY. No chunk text, no provenance, no trust
 * bits ever live in the index: at query time the semantic leg re-reads the
 * store through the same trust-filtered readers as every lexical tier and
 * only LOOKS UP vectors by content hash (see embeddings/chunker.ts's
 * header). A corrupt/poisoned/stale index can therefore degrade recall
 * quality but can never inject content or bypass a trust/scope/fence stage.
 *
 * FORMAT (v1, single file per model — `index-v1-<model>.bin`):
 *   bytes 0..8    magic "AREMBIX1"
 *   bytes 8..12   uint32 LE — header JSON byte length
 *   bytes 12..N   header JSON (utf-8): { version, model, dim, count,
 *                 built_at, hashes: string[count] }
 *   bytes N..EOF  count × dim float32 LE (row i = hashes[i]'s vector,
 *                 L2-normalized at embed time so cosine = dot product)
 * Binary because a JSON-of-number-arrays index at realistic store sizes
 * (tens of thousands of 384-dim vectors) costs hundreds of ms of parse on
 * EVERY recall; this format is one read + one small JSON parse + one memcpy.
 *
 * WRITES follow the fix6 conventions: the full payload is built first, then
 * written inside `withLock("embeddings-index")` via tmp+rename (atomic on
 * POSIX) — lock-free READERS can never observe a torn file, and two
 * concurrent rebuilds serialize instead of interleaving.
 *
 * READS are lock-free and corruption-TOLERANT: any structural problem
 * (short file, bad magic, unparsable header, dim/model mismatch, size
 * mismatch) returns `{ error }` — the semantic leg degrades to lexical-only
 * with a diagnosable note; the recall path never throws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../storage/fs-utils.js";
import { withLock } from "../storage/filelock.js";
import { embeddingsIndexPath, type EmbeddingModelSpec } from "./config.js";

const MAGIC = "AREMBIX1";

export interface EmbeddingIndex {
  model: string;
  dim: number;
  builtAt: string;
  /** Row order matches `vectors` rows. */
  hashes: string[];
  /** count × dim, L2-normalized rows. */
  vectors: Float32Array;
  /** hash → row number (built at load). */
  rowByHash: Map<string, number>;
}

export interface IndexReadError {
  reason: "missing" | "corrupt" | "model-mismatch";
  message: string;
}

function headerFor(index: { model: string; dim: number; builtAt: string; hashes: string[] }): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      model: index.model,
      dim: index.dim,
      count: index.hashes.length,
      built_at: index.builtAt,
      hashes: index.hashes,
    }),
    "utf-8",
  );
}

/** Serialize + atomically write the index under the shared store lock. */
export async function writeEmbeddingIndex(
  spec: EmbeddingModelSpec,
  hashes: string[],
  vectors: Float32Array,
): Promise<string> {
  if (vectors.length !== hashes.length * spec.dim) {
    throw new Error(
      `embedding index shape mismatch: ${hashes.length} hashes × dim ${spec.dim} != ${vectors.length} floats`,
    );
  }
  const indexPath = embeddingsIndexPath(spec);
  const header = headerFor({ model: spec.id, dim: spec.dim, builtAt: new Date().toISOString(), hashes });
  const headBuf = Buffer.alloc(12);
  headBuf.write(MAGIC, 0, "ascii");
  headBuf.writeUInt32LE(header.length, 8);
  const vecBuf = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  const payload = Buffer.concat([headBuf, header, vecBuf]);

  await withLock("embeddings-index", () => {
    ensureDir(path.dirname(indexPath));
    const tmp = indexPath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, indexPath); // atomic on POSIX — readers never see a torn file
  });
  return indexPath;
}

/** In-process read cache keyed by (path, mtimeMs, size) — repeated recalls
 *  in one MCP-server process skip re-reading a multi-MB file. KNOWN
 *  NARROW STALENESS WINDOW (fix7 review L, accepted): two rebuilds landing
 *  within the same mtime tick AND producing byte-equal sizes would serve
 *  the older copy until the next tick — content-hash keys make same-size
 *  different-content rebuilds vanishingly rare, and a rebuild is a manual
 *  CLI action; `resetEmbeddingIndexCache()` is the test/debug escape. */
const _readCache = new Map<string, { mtimeMs: number; size: number; index: EmbeddingIndex }>();

/**
 * Load the index for a model. Lock-free (writes are atomic-rename).
 * NEVER throws — every failure is a typed `{ error }` for the semantic
 * leg's degrade note.
 */
export function readEmbeddingIndex(spec: EmbeddingModelSpec): EmbeddingIndex | { error: IndexReadError } {
  const indexPath = embeddingsIndexPath(spec);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    return {
      error: {
        reason: "missing",
        message: `no embedding index at ${indexPath} — run \`ar embeddings rebuild\` once`,
      },
    };
  }
  const cached = _readCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.index;
  }

  try {
    const buf = fs.readFileSync(indexPath);
    if (buf.length < 12 || buf.toString("ascii", 0, 8) !== MAGIC) {
      return { error: { reason: "corrupt", message: `embedding index has bad magic/size (${indexPath}) — re-run \`ar embeddings rebuild\`` } };
    }
    const headerLen = buf.readUInt32LE(8);
    if (12 + headerLen > buf.length) {
      return { error: { reason: "corrupt", message: `embedding index header truncated (${indexPath}) — re-run \`ar embeddings rebuild\`` } };
    }
    const header = JSON.parse(buf.toString("utf-8", 12, 12 + headerLen)) as {
      version: number; model: string; dim: number; count: number; built_at: string; hashes: string[];
    };
    if (header.version !== 1 || !Array.isArray(header.hashes) || header.hashes.length !== header.count) {
      return { error: { reason: "corrupt", message: `embedding index header invalid (${indexPath}) — re-run \`ar embeddings rebuild\`` } };
    }
    if (header.model !== spec.id || header.dim !== spec.dim) {
      return {
        error: {
          reason: "model-mismatch",
          message: `embedding index was built for model "${header.model}" (dim ${header.dim}), active model is "${spec.id}" (dim ${spec.dim}) — run \`ar embeddings rebuild\``,
        },
      };
    }
    const vecBytes = header.count * header.dim * 4;
    const vecStart = 12 + headerLen;
    if (vecStart + vecBytes !== buf.length) {
      return { error: { reason: "corrupt", message: `embedding index vector block size mismatch (${indexPath}) — re-run \`ar embeddings rebuild\`` } };
    }
    // Copy into an aligned ArrayBuffer (Buffer pool offsets are not
    // guaranteed 4-byte aligned for a Float32Array view).
    const aligned = new ArrayBuffer(vecBytes);
    buf.copy(Buffer.from(aligned), 0, vecStart, vecStart + vecBytes);
    const vectors = new Float32Array(aligned);
    const rowByHash = new Map<string, number>();
    for (let i = 0; i < header.hashes.length; i++) rowByHash.set(header.hashes[i], i);
    const index: EmbeddingIndex = {
      model: header.model,
      dim: header.dim,
      builtAt: header.built_at,
      hashes: header.hashes,
      vectors,
      rowByHash,
    };
    _readCache.set(indexPath, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return index;
  } catch (err) {
    return {
      error: {
        reason: "corrupt",
        message: `embedding index unreadable (${indexPath}): ${err instanceof Error ? err.message : String(err)} — re-run \`ar embeddings rebuild\``,
      },
    };
  }
}

/** Reset the in-process read cache (tests). */
export function resetEmbeddingIndexCache(): void {
  _readCache.clear();
}
