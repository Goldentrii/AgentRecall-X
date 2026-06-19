/**
 * Local embedding helper — thin wrapper around OpenAI text-embedding-3-small.
 * Returns null when OPENAI_API_KEY is not set so callers can degrade gracefully.
 * Uses plain fetch; no openai SDK dependency.
 */

/** Timeout in ms for the embedding fetch. Overridable via AGENT_RECALL_EMBED_TIMEOUT_MS. */
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
