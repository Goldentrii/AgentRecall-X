// packages/core/src/supabase/embedding.ts

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export function zeroPad(vec: number[], target: number): number[] {
  if (vec.length >= target) return vec;
  const padded = new Array(target).fill(0);
  for (let i = 0; i < vec.length; i++) padded[i] = vec[i];
  return padded;
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly model = "text-embedding-3-small";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI embedding failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI batch embedding failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}

export class VoyageEmbedding implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly nativeDimensions = 512;
  readonly model = "voyage-3-lite";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: [text] }),
    });
    if (!res.ok) throw new Error(`Voyage embedding failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return zeroPad(data.data[0].embedding, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Voyage batch embedding failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => zeroPad(d.embedding, this.dimensions));
  }
}

export function createEmbeddingProvider(provider: "openai" | "voyage", apiKey: string): EmbeddingProvider {
  if (provider === "voyage") return new VoyageEmbedding(apiKey);
  return new OpenAIEmbedding(apiKey);
}
