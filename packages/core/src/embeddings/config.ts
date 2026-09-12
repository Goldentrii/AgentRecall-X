/**
 * embeddings/config.ts — fix7 (plan-v2 #7, 2026-09-12): OPT-IN local
 * semantic embeddings for the paraphrase retrieval gap.
 *
 * WHY THIS EXISTS: after fix4/fix4b the golden eval sits at 75% top-5
 * hit-rate and every remaining miss is the SEMANTIC-PARAPHRASE class
 * (fix4 report Escalation §2): the query shares almost no lexical tokens
 * with its golden ("semver increment" vs "one version bump per release";
 * a zh query against an English rule). No lexical mechanism reaches them —
 * the goldens never enter the lexical top-k at all, so re-ranking cannot
 * help; the semantic leg contributes CANDIDATES (an additional RRF leg,
 * see retrieval/semantic-leg.ts).
 *
 * OPT-IN ONLY (adversarial plan review, the grounds on which default-on
 * embeddings were REJECTED): flag OFF (the default) is byte-identical to
 * fix4b — no index read, no model load, no new code on the recall path
 * beyond one boolean check. Follows the `AGENT_RECALL_RECALL_FUSION` house
 * precedent exactly: env read PER-CALL (never cached at module load, so a
 * test can toggle it within one process), plus a config-file equivalent
 * (`<root>/config.json`, the same file supabase/config.ts already owns a
 * few keys of).
 *
 * ZERO-CLOUD: inference is a LOCAL ONNX model via transformers.js. The
 * one-time model download happens ONLY inside `ar embeddings setup`
 * (embeddings/runtime.ts sets `allowRemoteModels=false` everywhere else,
 * including the whole recall path — a recall can NEVER touch the network
 * through this feature). No telemetry, no remote inference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

// ---------------------------------------------------------------------------
// Model registry — class-not-instance: one row per supported model; adding a
// model is a new ROW here, never a new branch anywhere else. Selection is by
// measurement (fix7 report's tradeoff table), not vibes.
// ---------------------------------------------------------------------------

export interface EmbeddingModelSpec {
  /** Registry key (also the index filename tag — keep filename-safe). */
  id: string;
  /** HuggingFace repo transformers.js loads (ONNX weights). */
  hfRepo: string;
  /** Embedding dimensionality. */
  dim: number;
  /** Prefix prepended to QUERY texts at embed time (e5 family requires
   *  "query: " / "passage: "; models that don't use prefixes leave these
   *  empty). Part of the model's contract, NOT part of the content hash —
   *  the index hashes raw chunk text only, so switching models never
   *  poisons another model's index (each model has its own index file). */
  queryPrefix: string;
  /** Prefix prepended to PASSAGE (indexed chunk) texts at embed time. */
  passagePrefix: string;
  /** transformers.js dtype (quantization) to load. */
  dtype: string;
  /** Internal/test-only rows are hidden from user-facing surfaces
   *  (`ar embeddings setup` model list, docs). */
  internal?: boolean;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  "multilingual-e5-small": {
    id: "multilingual-e5-small",
    hfRepo: "Xenova/multilingual-e5-small",
    dim: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    dtype: "q8",
  },
  "paraphrase-multilingual-minilm-l12-v2": {
    id: "paraphrase-multilingual-minilm-l12-v2",
    hfRepo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    queryPrefix: "",
    passagePrefix: "",
    dtype: "q8",
  },
  "multilingual-e5-base": {
    id: "multilingual-e5-base",
    hfRepo: "Xenova/multilingual-e5-base",
    dim: 768,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    dtype: "q8",
  },
  /**
   * TEST SEAM — a deterministic, dependency-free, network-free pseudo-
   * embedder (hashed bag-of-tokens, see runtime.ts). Exists so the whole
   * pipeline (index build → semantic leg → RRF fusion → fence) is testable
   * end-to-end in CI without the 380MB runtime or a model download. It is
   * NOT a semantic model (cosine ≈ token overlap) and is never selected
   * unless AGENT_RECALL_EMBEDDINGS_MODEL names it explicitly.
   */
  "_fake-hash-bow": {
    id: "_fake-hash-bow",
    hfRepo: "(builtin test embedder — no download)",
    dim: 64,
    queryPrefix: "",
    passagePrefix: "",
    dtype: "none",
    internal: true,
  },
};

/**
 * Default model — chosen by measurement on the golden eval (fix7 report,
 * 2026-09-12): multilingual-e5-small recovered the most paraphrase-class
 * queries at the smallest download (~144MB q8 cache) and lowest warm
 * latency; see the report's tradeoff table before changing this.
 */
export const DEFAULT_EMBEDDING_MODEL = "multilingual-e5-small";

/** Resolve the active model spec (env override → default). Unknown ids fall
 *  back to the default LOUDLY at the call sites that surface status (the
 *  semantic leg reports the resolved model in its note). */
export function resolveEmbeddingModel(): EmbeddingModelSpec {
  const requested = process.env.AGENT_RECALL_EMBEDDINGS_MODEL;
  if (requested && EMBEDDING_MODELS[requested]) return EMBEDDING_MODELS[requested];
  return EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL];
}

// ---------------------------------------------------------------------------
// Opt-in flag — read PER-CALL (AGENT_RECALL_RECALL_FUSION precedent).
// ---------------------------------------------------------------------------

/**
 * Is the semantic leg enabled?
 *
 * Precedence (explicit env always wins, so a caller/test/eval-harness can
 * force either state regardless of the store's config file):
 *   1. AGENT_RECALL_EMBEDDINGS === "1"  → on
 *   2. AGENT_RECALL_EMBEDDINGS === any other non-empty value → off
 *   3. <root>/config.json `"embeddings_enabled": true` → on
 *   4. default → off
 *
 * The config read is best-effort and tiny (config.json is a small file the
 * supabase path already reads); any read/parse failure means OFF — the flag
 * must never make a recall throw.
 */
export function embeddingsEnabled(): boolean {
  const env = process.env.AGENT_RECALL_EMBEDDINGS;
  if (env !== undefined && env !== "") return env === "1";
  try {
    const p = path.join(getRoot(), "config.json");
    if (!fs.existsSync(p)) return false;
    const cfg = JSON.parse(fs.readFileSync(p, "utf-8"));
    return cfg?.embeddings_enabled === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Machine-level home for the embedding RUNTIME (a self-contained
 * `npm --prefix` install of transformers.js, ~380MB with onnxruntime — the
 * reason it is NOT a dependency of this package) and the MODEL cache
 * (~140-290MB per model). Overridable via AGENT_RECALL_EMBEDDINGS_HOME so
 * multiple stores / eval clones can share one runtime+model download.
 *
 * The INDEX deliberately does NOT live here — it is derived from store
 * content and lives under the store root (see embeddingsIndexPath), so a
 * store clone carries its own index and never shares another store's.
 */
export function embeddingsHome(): string {
  return process.env.AGENT_RECALL_EMBEDDINGS_HOME ?? path.join(getRoot(), "embeddings");
}

/** `<home>/runtime` — self-contained transformers.js install (setup step). */
export function embeddingsRuntimeDir(): string {
  return path.join(embeddingsHome(), "runtime");
}

/** `<home>/models` — transformers.js cacheDir (one-time model downloads). */
export function embeddingsModelsDir(): string {
  return path.join(embeddingsHome(), "models");
}

/** `<root>/embeddings/index-v1-<model>.bin` — the persistent, content-hash-
 *  keyed vector index (embeddings/index-store.ts). Per-model filename: two
 *  models never share vectors (dims/spaces are incompatible). */
export function embeddingsIndexPath(spec?: EmbeddingModelSpec): string {
  const model = spec ?? resolveEmbeddingModel();
  return path.join(getRoot(), "embeddings", `index-v1-${model.id}.bin`);
}
