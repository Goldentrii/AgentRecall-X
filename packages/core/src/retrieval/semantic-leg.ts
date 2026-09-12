/**
 * retrieval/semantic-leg.ts — fix7: the OPT-IN semantic candidate leg.
 *
 * WHAT IT IS: an ADDITIONAL ranked list fed into queryMemory()'s existing
 * RRF fusion (applyRRF — fusing one more leg, exactly the pattern that
 * function already implements for tiers and fuseRemoteWithLocal implements
 * for backends). It contributes CANDIDATES, not a re-ranking: the
 * paraphrase-class goldens (fix4 Escalation §2) never enter the lexical
 * candidate lists at all, so only a new leg can reach them.
 *
 * WHAT IT IS NOT: a bypass. Candidates are re-read at query time through
 * the SAME `readTierCandidates` + `filterTrusted` chokepoints as every
 * lexical tier scorer (via embeddings/chunker.ts), the SCOPE stage applies
 * to insight-attributed items exactly as `SCOPE_ATTRIBUTED_TIERS` mandates,
 * items keep their native tier `source` labels, and everything flows
 * through the unchanged fence at the MCP-tool boundary. The index stores
 * hash→vector only (no text — embeddings/index-store.ts's header), so a
 * poisoned/stale index cannot inject content: an untrusted item's hash is
 * never even looked up, because its candidate never survives the trust
 * filter. Proven by the fix7 adversarial tests
 * (fix7-embeddings-security.test.mjs).
 *
 * DEGRADE CONTRACT: every failure (no runtime, no model, missing/corrupt/
 * empty index, embed error) returns an EMPTY item list plus a typed,
 * diagnosable note — the recall path never throws and never blocks on the
 * network (embeddings/runtime.ts loads with allowRemoteModels=false).
 *
 * KNOWN NON-COVERAGE (documented, lexically unchanged): the legacy journal
 * root (~/.claude/projects) and the raw hook-archive tier are not chunked
 * — see embeddings/chunker.ts's header. The contradiction stage does not
 * run over semantic-only items (annotate-only metadata; a semantic item
 * that also matched lexically was already annotated on its lexical pass).
 */

import { applyScope } from "./scope.js";
import type { QueryMemoryItem } from "./query-memory.js";
import { chunkProject, type EmbeddingChunk } from "../embeddings/chunker.js";
import { getEmbedder } from "../embeddings/runtime.js";
import { resolveEmbeddingModel } from "../embeddings/config.js";
import { readEmbeddingIndex } from "../embeddings/index-store.js";
import { parseSinceDate } from "../tools-logic/journal-search.js";

/**
 * How many semantic items join the fusion. RRF contributions run
 * 1/(60+1)..1/(60+K): large enough for a paraphrase-only golden at semantic
 * rank 1 to reach the fused top-5, small enough that the leg cannot flood
 * it (the same "one leg, K votes" budget every lexical tier already gets
 * via its own perTierLimit). Measured on the golden eval (fix7 report).
 */
const SEMANTIC_TOP_K = 8;

/**
 * Per-model minimum cosine before a chunk may become a candidate — keeps
 * the leg from spending its K votes on semantically-unrelated items for
 * queries whose true answer is not in the store (junk at 1/61 could
 * otherwise displace a rank-5 lexical hit). Values measured on the golden
 * eval + planted-junk probes (fix7 report); e5-family cosines sit high
 * (unrelated ≈0.72-0.80), MiniLM's sit low (unrelated ≈0.1-0.35).
 */
const MIN_COSINE: Record<string, number> = {
  "multilingual-e5-small": 0.80,
  "multilingual-e5-base": 0.80,
  "paraphrase-multilingual-minilm-l12-v2": 0.35,
  "_fake-hash-bow": 0.15,
};

export interface SemanticLegNote {
  status: "ok" | "model-unavailable" | "index-missing" | "index-corrupt" | "index-empty" | "error";
  model: string;
  /** Chunks of THIS query's trust-filtered candidate set that had a vector
   *  in the index (coverage diagnostic — 0 with status "ok" means the index
   *  is stale for this project: run `ar embeddings rebuild`). */
  matched?: number;
  /** Items actually contributed to the fusion (post floor/top-K). */
  contributed?: number;
  message?: string;
}

export interface SemanticLegResult {
  items: QueryMemoryItem[];
  note: SemanticLegNote;
}

export interface SemanticLegInput {
  query: string;
  /** Already-resolved slug (queryMemory convention). */
  project: string;
  scope?: string;
  since?: string;
  room?: string;
  topK?: number;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export async function runSemanticLeg(input: SemanticLegInput): Promise<SemanticLegResult> {
  const spec = resolveEmbeddingModel();
  const empty = (note: SemanticLegNote): SemanticLegResult => ({ items: [], note });

  try {
    // 1. Index — lock-free read, corruption-tolerant.
    const index = readEmbeddingIndex(spec);
    if ("error" in index) {
      const status = index.error.reason === "missing" ? "index-missing" : "index-corrupt";
      return empty({ status, model: spec.id, message: index.error.message });
    }
    if (index.hashes.length === 0) {
      return empty({ status: "index-empty", model: spec.id, message: "embedding index is empty — run `ar embeddings rebuild`" });
    }

    // 2. Embedder — local-only load; a cold MCP process pays the one-time
    //    model load here (~0.3-3s), warm calls are milliseconds.
    const embedder = await getEmbedder(spec, { allowRemote: false });
    if ("error" in embedder) {
      return empty({ status: "model-unavailable", model: spec.id, message: embedder.error.message });
    }

    // 3. Candidates — the SAME trust-filtered fetch shape as the lexical
    //    tiers (see this file's header), re-chunked deterministically.
    let chunks = chunkProject(input.project, { room: input.room, includeRollupArchive: true });

    //    `since` parity with the lexical journal scorer.
    const sinceCutoff = input.since ? parseSinceDate(input.since) : null;
    if (sinceCutoff) {
      chunks = chunks.filter((c) => {
        if (c.tier !== "journal" || !c.date) return true;
        const d = new Date(c.date);
        return isNaN(d.getTime()) || d >= sinceCutoff;
      });
    }

    //    SCOPE stage — insight chunks only (SCOPE_ATTRIBUTED_TIERS
    //    semantics: journal/palace/corrections are inherently per-slug and
    //    must never be run through applyScope — see scope.ts).
    if (input.scope && input.scope !== "all") {
      const insightScoped = new Set(
        applyScope(chunks.filter((c) => c.tier === "insight"), input.project, input.scope),
      );
      chunks = chunks.filter((c) => c.tier !== "insight" || insightScoped.has(c));
    }

    // 4. Query embed + cosine against indexed vectors (hash lookup — a
    //    chunk not yet indexed is silently lexical-only until the next
    //    rebuild; `matched` makes that coverage gap diagnosable).
    const [queryVec] = await embedder.embedQueries([input.query]);
    const minCosine = MIN_COSINE[spec.id] ?? 0;
    let matched = 0;
    const bestByDoc = new Map<string, { chunk: EmbeddingChunk; cosine: number }>();
    for (const chunk of chunks) {
      const row = index.rowByHash.get(chunk.hash);
      if (row === undefined) continue;
      matched++;
      const cosine = dot(queryVec, index.vectors.subarray(row * spec.dim, (row + 1) * spec.dim));
      if (cosine < minCosine) continue;
      // One-doc-one-vote (fix4 C1's invariant, from day one on this leg).
      const cur = bestByDoc.get(chunk.docKey);
      if (!cur || cosine > cur.cosine) bestByDoc.set(chunk.docKey, { chunk, cosine });
    }

    const ranked = [...bestByDoc.values()].sort((a, b) => b.cosine - a.cosine).slice(0, input.topK ?? SEMANTIC_TOP_K);

    const items: QueryMemoryItem[] = ranked.map(({ chunk, cosine }) => ({
      id: chunk.id,
      source: chunk.tier,
      title: chunk.title,
      excerpt: chunk.excerpt,
      ...(chunk.fusionKey ? { fusionKey: chunk.fusionKey } : {}),
      // Tier-internal pre-fusion score. Cosine is ONLY used to order this
      // leg's own list — applyRRF reads rank, never this raw value, so the
      // incompatible-scale class (smart-recall.ts Fix 1) cannot recur.
      score: cosine,
      ...(chunk.room ? { room: chunk.room } : {}),
      ...(chunk.file ? { file: chunk.file } : {}),
      ...(chunk.date ? { date: chunk.date } : {}),
      ...(chunk.line !== undefined ? { line: chunk.line } : {}),
      ...(chunk.severity ? { severity: chunk.severity } : {}),
      ...(chunk.projects ? { projects: chunk.projects } : {}),
      semantic: true,
    }));

    return {
      items,
      note: { status: "ok", model: spec.id, matched, contributed: items.length },
    };
  } catch (err) {
    // The recall path must never throw because of this opt-in leg.
    return empty({
      status: "error",
      model: spec.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
