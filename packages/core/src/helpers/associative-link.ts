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

    // Threshold recalibrated (fix4 S4-completion, 2026-09-11; corrected per
    // independent review M2 same day): the old 0.03 was calibrated against
    // palace scores INFLATED by the per-line applyRRF accumulation bug (a
    // single file with >=2 matching lines summed 1/61 + 1/62 ≈ 0.033), so
    // its EFFECTIVE semantics were "link only multi-evidence memories":
    // >=2 same-file lines, a cross-source fusion (≈0.032), or a hot-window-
    // boosted recent item (>=×1.3 ⇒ >=0.021). With one-doc-one-vote scoring
    // (query-memory.ts scorePalaceTier) every single-source match scores
    // 1/(60+rank) <= 0.0164 — the review caught that this fix's first cut
    // (0.015) sat BELOW the whole single-source band (1/(60+6) ≈ 0.01515 at
    // limit 6), turning the gate into a no-op that linked the top-3 of ANY
    // keyword match on every save. 0.02 restores the original multi-
    // evidence class on the un-inflated scale: cross-source fusions and
    // boosted-recent items pass, a lone unboosted keyword match does not.
    const candidates = results
      .filter((r) => r.id !== savedSlug && r.score > 0.02)
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
