// packages/core/src/supabase/recall-backend.ts
import { getSupabaseClient } from "./client.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import type { SupabaseConfig } from "./config.js";
import { calibratedConfidence, type ConfidenceScale } from "../tools-logic/confidence.js";

// Import the interface type — we can't import directly from recall-backend.ts
// because it would create a circular dependency (it dynamically imports us).
// Instead, we define the same shape and the getRecallBackend() factory casts.

/** RRF constant (same as local backend). */
const RRF_K = 60;

/** Compute the human label + stored calibrated value for a score (Wave 4). */
function label(score: number, scale: ConfidenceScale): { confidence: string; calibrated: number } {
  const c = calibratedConfidence(score, scale);
  return { confidence: c.label, calibrated: c.calibrated };
}

interface RecallResultItem {
  id: string;
  source: "palace" | "journal" | "insight";
  title: string;
  excerpt: string;
  score: number;
  confidence: string;
  calibrated: number;
  room?: string;
  date?: string;
  severity?: string;
}

export class SupabaseRecallBackend {
  private config: SupabaseConfig;
  private embedding: EmbeddingProvider | null;

  constructor(config: SupabaseConfig) {
    this.config = config;
    this.embedding = config.embedding_api_key
      ? createEmbeddingProvider(config.embedding_provider, config.embedding_api_key)
      : null;
  }

  available(): boolean {
    return !!getSupabaseClient() && !!this.embedding;
  }

  async search(
    query: string,
    project: string | undefined,
    limit: number
  ): Promise<RecallResultItem[]> {
    const client = getSupabaseClient();
    if (!client || !this.embedding || !project) {
      // Fallback to local
      const { localRecallSearch } = await import("../tools-logic/smart-recall.js");
      return localRecallSearch(query, project, limit);
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedding.embed(query);
    } catch {
      // Embedding failed — fallback to local
      const { localRecallSearch } = await import("../tools-logic/smart-recall.js");
      return localRecallSearch(query, project, limit);
    }

    // Three parallel queries
    const [semanticResults, insightResults, ftsResults] = await Promise.all([
      // 1. pgvector cosine similarity on ar_entries
      client.rpc("ar_semantic_search", {
        query_embedding: queryEmbedding,
        match_project: project,
        match_limit: limit * 2,
      }),
      // 2. pgvector on ar_insights (cross-project)
      client.rpc("ar_insight_search", {
        query_embedding: queryEmbedding,
        match_limit: limit,
      }),
      // 3. PostgreSQL FTS (keyword backup)
      client
        .from("ar_entries")
        .select("id, project, store, room, slug, title, body, tags, metadata")
        .eq("project", project)
        .textSearch("body", query.split(/\s+/).join(" & "), { type: "plain" })
        .limit(limit),
    ]);

    // Convert to RecallResultItem and rank per source
    const semanticItems: RecallResultItem[] = (semanticResults.data ?? []).map(
      (r: Record<string, unknown>) => ({
        id: r.id as string,
        source: (r.store === "journal" ? "journal" : "palace") as "palace" | "journal",
        title: (r.title ?? r.slug) as string,
        excerpt: ((r.body as string) ?? "").slice(0, 300),
        score: (r.similarity as number) ?? 0,
        // cosine similarity is already 0..1.
        ...label((r.similarity as number) ?? 0, "cosine"),
        room: (r.room as string) ?? undefined,
      })
    );

    const insightItemsList: RecallResultItem[] = (insightResults.data ?? []).map(
      (r: Record<string, unknown>) => ({
        id: r.id as string,
        source: "insight" as const,
        title: r.title as string,
        excerpt: `[${r.severity as string}] confirmed ${r.confirmed as number}x`,
        score: (r.similarity as number) ?? 0,
        // cosine similarity is already 0..1.
        ...label((r.similarity as number) ?? 0, "cosine"),
        severity: r.severity as string,
      })
    );

    const ftsItems: RecallResultItem[] = (ftsResults.data ?? []).map(
      (r: Record<string, unknown>, idx: number) => ({
        id: r.id as string,
        source: (r.store === "journal" ? "journal" : "palace") as "palace" | "journal",
        title: (r.title ?? r.slug) as string,
        excerpt: ((r.body as string) ?? "").slice(0, 300),
        score: 1 / (idx + 1),
        // reciprocal-rank 1/(idx+1) is already 0..1.
        ...label(1 / (idx + 1), "cosine"),
        room: (r.room as string) ?? undefined,
      })
    );

    // RRF merge across all three
    semanticItems.sort((a, b) => b.score - a.score);
    insightItemsList.sort((a, b) => b.score - a.score);
    ftsItems.sort((a, b) => b.score - a.score);

    const rrfMap = new Map<string, { score: number; item: RecallResultItem }>();

    for (const items of [semanticItems, insightItemsList, ftsItems]) {
      items.forEach((item, idx) => {
        const rank = idx + 1;
        const contribution = 1 / (RRF_K + rank);
        const existing = rrfMap.get(item.id);
        if (existing) {
          existing.score += contribution;
        } else {
          rrfMap.set(item.id, { score: contribution, item });
        }
      });
    }

    // Dedup and sort
    const seen = new Set<string>();
    const deduped: RecallResultItem[] = [];
    for (const { score, item } of rrfMap.values()) {
      const key = item.excerpt.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      // Final RRF score → rrf-supabase scale.
      deduped.push({ ...item, score, ...label(score, "rrf-supabase") });
    }

    deduped.sort((a, b) => b.score - a.score);
    return deduped.slice(0, limit);
  }
}
