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

    const candidates = results
      .filter((r) => r.id !== savedSlug && r.score > 0.03)
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
