/**
 * embeddings/runtime.ts — fix7: loading the LOCAL ONNX embedder.
 *
 * The transformers.js runtime is NOT a dependency of this package (it pulls
 * ~380MB of onnxruntime binaries — see embeddings/config.ts's header). It is
 * installed once, self-contained, under `<embeddings-home>/runtime` by
 * `ar embeddings setup` (the CLI owns the `npm --prefix` spawn; this module
 * only LOADS from that location) and models are cached once under
 * `<embeddings-home>/models`.
 *
 * NETWORK CONTRACT (zero-cloud, adversarial-review requirement):
 *   - `allowRemote: false` (the default, used by the ENTIRE recall path and
 *     by `ar embeddings rebuild`): transformers.js is configured with
 *     `env.allowRemoteModels = false` — a cached model loads from disk; a
 *     missing model produces a CLEAN, actionable error (never a network
 *     fetch). A recall can never touch the network through this feature.
 *   - `allowRemote: true` is passed ONLY by `ar embeddings setup`, the one
 *     sanctioned downloader (one-time, cached, never re-fetched when cached
 *     — transformers.js's cacheDir handles the skip-when-present logic).
 *
 * Every failure path returns a typed { error } — this module never throws
 * into the recall path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  embeddingsRuntimeDir,
  embeddingsModelsDir,
  type EmbeddingModelSpec,
} from "./config.js";
import { stem } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";

/** Embeds a batch of texts → one normalized Float32Array per text. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface Embedder {
  spec: EmbeddingModelSpec;
  /** Embed QUERY texts (model's query prefix applied internally). */
  embedQueries: EmbedFn;
  /** Embed PASSAGE/document texts (model's passage prefix applied internally). */
  embedPassages: EmbedFn;
}

export interface EmbedderError {
  /** Enumerated failure class — surfaced verbatim in the semantic leg's
   *  result note so a degraded recall is diagnosable, never silent-silent. */
  reason: "runtime-missing" | "model-missing" | "load-failed";
  message: string;
}

/** The npm package the setup step installs into the runtime dir. Version
 *  pinned to a major verified against this module's load path (v4 ships
 *  `dist/transformers.node.cjs` via the `require` export condition). */
export const RUNTIME_PACKAGE = "@huggingface/transformers";
export const RUNTIME_PACKAGE_RANGE = "^4.2.0";

/** Is the self-contained runtime install present? (Cheap existence check —
 *  `ar embeddings status` and the semantic leg's degrade note both use it.) */
export function runtimeInstalled(): boolean {
  try {
    return fs.existsSync(
      path.join(embeddingsRuntimeDir(), "node_modules", RUNTIME_PACKAGE, "package.json"),
    );
  } catch {
    return false;
  }
}

/** Best-effort "is this model's cache present" check (used by status/setup
 *  messaging only — the authoritative check is the actual load, which
 *  transformers.js performs against its own cache layout). */
export function modelCached(spec: EmbeddingModelSpec): boolean {
  if (spec.id === "_fake-hash-bow") return true;
  try {
    const dir = path.join(embeddingsModelsDir(), ...spec.hfRepo.split("/"));
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deterministic test embedder (`_fake-hash-bow` registry row)
// ---------------------------------------------------------------------------

/**
 * Hashed bag-of-tokens pseudo-embedding: each stemmed token hashes to a
 * (dimension, sign) pair; token vectors accumulate; result is L2-normalized.
 * Cosine similarity ≈ token overlap — deterministic, dependency-free, and
 * good enough for tests to construct "semantically close" pairs on purpose.
 * NEVER a real semantic model; see the registry row's doc comment.
 */
function fakeHashBowEmbed(texts: string[], dim: number): Float32Array[] {
  return texts.map((text) => {
    const vec = new Float32Array(dim);
    for (const raw of tokenizeWords(text)) {
      const tok = stem(raw);
      let h = 2166136261; // FNV-1a
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
    return vec;
  });
}

// ---------------------------------------------------------------------------
// Real embedder (transformers.js from the self-contained runtime install)
// ---------------------------------------------------------------------------

/** One embedder per (model id, allowRemote) per process — model load is the
 *  expensive part (~0.3-3s); recalls after the first reuse the pipeline. */
const _embedderCache = new Map<string, Promise<Embedder | { error: EmbedderError }>>();

async function loadRealEmbedder(
  spec: EmbeddingModelSpec,
  allowRemote: boolean,
): Promise<Embedder | { error: EmbedderError }> {
  if (!runtimeInstalled()) {
    return {
      error: {
        reason: "runtime-missing",
        message:
          `embedding runtime not installed at ${embeddingsRuntimeDir()} — ` +
          `run \`ar embeddings setup\` once (installs ${RUNTIME_PACKAGE} locally + downloads the model; nothing ships in this package)`,
      },
    };
  }

  let mod: {
    env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    pipeline: (task: string, model: string, opts: Record<string, unknown>) =>
      Promise<(texts: string[], opts: Record<string, unknown>) => Promise<{ dims: number[]; data: Float32Array }>>;
  };
  try {
    const req = createRequire(path.join(embeddingsRuntimeDir(), "package.json"));
    const resolved = req.resolve(RUNTIME_PACKAGE);
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    return {
      error: {
        reason: "load-failed",
        message: `embedding runtime failed to load: ${err instanceof Error ? err.message : String(err)} — re-run \`ar embeddings setup\``,
      },
    };
  }

  // Configure BEFORE the model load. cacheDir keeps model files under the
  // embeddings home; allowRemoteModels=false is the zero-network guarantee
  // for every caller except the sanctioned setup downloader. The env
  // assignments live INSIDE the try (fix7 review L): this function's
  // never-throws contract must hold even against a runtime whose `env`
  // export is missing/frozen.
  let extractor: (texts: string[], opts: Record<string, unknown>) => Promise<{ dims: number[]; data: Float32Array }>;
  try {
    mod.env.cacheDir = embeddingsModelsDir();
    mod.env.allowRemoteModels = allowRemote;
    mod.env.allowLocalModels = true;
    extractor = await mod.pipeline("feature-extraction", spec.hfRepo, { dtype: spec.dtype });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const offlineMiss = /allowRemoteModels|local_files_only|not.*found.*locally/i.test(msg);
    return {
      error: {
        reason: offlineMiss ? "model-missing" : "load-failed",
        message: offlineMiss
          ? `embedding model ${spec.hfRepo} is not cached locally (and remote fetch is disabled outside setup) — run \`ar embeddings setup\` once while online`
          : `embedding model ${spec.hfRepo} failed to load: ${msg}`,
      },
    };
  }

  const embedWithPrefix = (prefix: string): EmbedFn => async (texts) => {
    const inputs = prefix ? texts.map((t) => prefix + t) : texts;
    const out = await extractor(inputs, { pooling: "mean", normalize: true });
    const [n, dim] = out.dims;
    const result: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      result.push(out.data.slice(i * dim, (i + 1) * dim));
    }
    return result;
  };

  return {
    spec,
    embedQueries: embedWithPrefix(spec.queryPrefix),
    embedPassages: embedWithPrefix(spec.passagePrefix),
  };
}

/**
 * Get (and cache, per process) the embedder for a model spec.
 *
 * `allowRemote` MUST stay false everywhere except `ar embeddings setup` —
 * see this file's header. Never throws: every failure is a typed
 * `{ error }` the caller degrades on.
 */
export async function getEmbedder(
  spec: EmbeddingModelSpec,
  opts: { allowRemote?: boolean } = {},
): Promise<Embedder | { error: EmbedderError }> {
  if (spec.id === "_fake-hash-bow") {
    const embed: EmbedFn = async (texts) => fakeHashBowEmbed(texts, spec.dim);
    return { spec, embedQueries: embed, embedPassages: embed };
  }
  const allowRemote = opts.allowRemote === true;
  const key = `${spec.id}::${allowRemote ? "remote-ok" : "local-only"}`;
  let pending = _embedderCache.get(key);
  if (!pending) {
    pending = loadRealEmbedder(spec, allowRemote);
    _embedderCache.set(key, pending);
    // A FAILED load must not poison the cache forever (e.g. setup runs in
    // another terminal, user retries recall) — evict error results so the
    // next call re-probes. Successful embedders stay cached.
    pending.then((r) => {
      if ("error" in r) _embedderCache.delete(key);
    }).catch(() => _embedderCache.delete(key));
  }
  return pending;
}

/** Reset the per-process embedder cache (tests). */
export function resetEmbedderCache(): void {
  _embedderCache.clear();
}
