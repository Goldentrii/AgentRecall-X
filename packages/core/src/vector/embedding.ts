/**
 * Local embedding helper — thin wrapper around OpenAI text-embedding-3-small.
 * Returns null when OPENAI_API_KEY is not set so callers can degrade gracefully.
 * Uses plain fetch; no openai SDK dependency.
 *
 * EMBEDDING SEAM — purity-census-2026-07-05 / Loop 13 verdict:
 * Local sentence-embeddings tested against BM25/lexical on the real corpus: no benefit.
 * Ceiling is DATA density, not retrieval algorithm. Env flags
 * (AGENT_RECALL_EMBEDDING_PROVIDER, AGENT_RECALL_EMBEDDING_KEY, AGENT_RECALL_EMBED_TIMEOUT_MS)
 * are NOT user-facing and removed from docs/help surfaces.
 * Code path kept as matchFn A/B seam only — do not re-activate without new data.
 * Do not re-propose without evidence from a corpus with >5x current density.
 *
 * SUPERSEDED-IN-PART (fix7, 2026-09-12): the "no benefit" verdict no longer
 * holds unqualified — the fix7 golden eval measured the semantic-paraphrase
 * class at +15 hit-rate points (75%→90%) using LOCAL ONNX embeddings as an
 * additional RRF candidate leg (src/embeddings/*, retrieval/semantic-leg.ts,
 * OPT-IN via AGENT_RECALL_EMBEDDINGS). THIS file remains what it was: the
 * dormant CLOUD (OpenAI) seam, still not user-facing, still not on any
 * default path — the sanctioned local path does not use it.
 */

/** Timeout in ms for the embedding fetch. Not a user-facing env flag — internal seam only. */
const EMBED_TIMEOUT_MS = parseInt(process.env.AGENT_RECALL_EMBED_TIMEOUT_MS ?? "2000", 10);

/**
 * Embed a piece of text using OpenAI text-embedding-3-small (1536 dims).
 * Returns null if OPENAI_API_KEY is not set or if the request fails or times out.
 * Never throws — callers must handle null and fall back to keyword search.
 */
export async function embed(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    // Network errors, timeouts (AbortError), JSON parse errors — always degrade gracefully
    return null;
  }
}
