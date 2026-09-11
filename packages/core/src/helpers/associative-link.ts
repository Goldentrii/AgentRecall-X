import { addEdge } from "../palace/graph.js";
import { localRecallSearch } from "../tools-logic/smart-recall.js";
import { palaceDir } from "../storage/paths.js";

/**
 * After saving a memory, find top-3 similar existing memories and write
 * bidirectional edges in graph.json. Fire-and-forget — never throws.
 */
export async function linkToSimilar(
  project: string,
  content: string,
  savedSlug: string
): Promise<void> {
  try {
    const pd = palaceDir(project);
    const snippet = content.slice(0, 300).replace(/\n+/g, " ");
    const results = await localRecallSearch(snippet, project, 6);

    // Threshold recalibrated (fix4 S4-completion, 2026-09-11): the old 0.03
    // was calibrated against palace scores INFLATED by the per-line applyRRF
    // accumulation bug (a single file with >=2 matching lines summed
    // 1/61 + 1/62 ≈ 0.033). With one-doc-one-vote scoring (see
    // query-memory.ts scorePalaceTier), a genuine single-source rank-1..5
    // match scores 1/(60+rank) ≈ 0.0152-0.0164, so 0.03 would have silently
    // disabled linking for every single-source match. 0.015 keeps the
    // original intent — "link to the few results with real rank-competitive
    // similarity" — on the un-inflated scale (top ~6 single-source ranks, or
    // anything cross-source/boosted).
    const candidates = results
      .filter((r) => r.id !== savedSlug && r.score > 0.015)
      .slice(0, 3);

    for (const candidate of candidates) {
      const targetSlug = candidate.room
        ? `${candidate.room}/${candidate.id}`
        : candidate.id;
      addEdge(pd, savedSlug, targetSlug, "semantic_similar", candidate.score);
      addEdge(pd, targetSlug, savedSlug, "semantic_similar", candidate.score);
    }
  } catch {
    // Silently skip — linking is best-effort, never blocks the main save
  }
}
