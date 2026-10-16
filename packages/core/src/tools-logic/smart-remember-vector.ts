/**
 * Fire-and-forget vector indexing helper for smart-remember.
 * Imported dynamically so the vector machinery is never loaded in the main
 * save path without the explicit cloud-embeddings opt-in
 * (AGENT_RECALL_CLOUD_EMBEDDINGS=1 AND OPENAI_API_KEY — egress gate, fix
 * 3.5.2; embed() itself re-checks the same gate and returns null otherwise).
 */

import { embed } from "../vector/embedding.js";
import { upsertVector, type VectorItem } from "../vector/local-vector-store.js";

/**
 * Embed content and upsert into the project's local vector index.
 * Silently swallows all errors — caller must never await this.
 */
export async function indexRemembered(
  project: string,
  id: string,
  source: "palace" | "journal" | "insight",
  title: string,
  excerpt: string,
  content: string
): Promise<void> {
  const embedding = await embed(content);
  if (!embedding) return;

  const item: VectorItem = { id, source, title, excerpt };
  await upsertVector(project, item, embedding);
}
