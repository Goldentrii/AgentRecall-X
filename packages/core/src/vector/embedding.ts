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
 *
 * EGRESS GATE (fix 3.5.2, 2026-10-16, rigorous-eval §5 finding 1): an AMBIENT
 * OPENAI_API_KEY — set for any other tool on the machine — used to be enough
 * to select this seam and silently send recall queries and remembered content
 * to api.openai.com. Cloud embeddings now additionally require the EXPLICIT
 * opt-in env AGENT_RECALL_CLOUD_EMBEDDINGS=1 (or "true"). The key alone sends
 * nothing. Not to be confused with AGENT_RECALL_EMBEDDINGS, which gates the
 * LOCAL ONNX leg (no network). The Supabase embedding providers
 * (supabase/embedding.ts) are unaffected: they never read OPENAI_API_KEY and
 * are reachable only via an explicitly configured embedding_api_key.
 */

/** Timeout in ms for the embedding fetch. Not a user-facing env flag — internal seam only. */
const EMBED_TIMEOUT_MS = parseInt(process.env.AGENT_RECALL_EMBED_TIMEOUT_MS ?? "2000", 10);

/**
 * Explicit opt-in gate for CLOUD (OpenAI) embeddings. True only when BOTH
 * AGENT_RECALL_CLOUD_EMBEDDINGS=1|true AND OPENAI_API_KEY are set. Every
 * path that could send text to api.openai.com on the ambient key must check
 * this (embed() below checks it itself, as the egress chokepoint).
 */
export function cloudEmbeddingsEnabled(): boolean {
  const flag = process.env.AGENT_RECALL_CLOUD_EMBEDDINGS;
  if (flag !== "1" && flag !== "true") return false;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Embed a piece of text using OpenAI text-embedding-3-small (1536 dims).
 * Returns null unless cloud embeddings are explicitly opted in
 * (AGENT_RECALL_CLOUD_EMBEDDINGS=1 AND OPENAI_API_KEY), or if the request
 * fails or times out.
 * Never throws — callers must handle null and fall back to keyword search.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!cloudEmbeddingsEnabled()) return null;
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
