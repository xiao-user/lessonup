import { config } from "../config.js";

export class BgeM3EmbeddingProvider {
  async embed(texts: string[], signal?: AbortSignal) {
    if (!config.BGE_M3_BASE_URL) throw new Error("embedding_not_configured");
    if (texts.length === 0) return [];
    const response = await fetch(new URL("embeddings", `${config.BGE_M3_BASE_URL.replace(/\/?$/, "/")}`), {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      headers: {
        "content-type": "application/json",
        ...(config.BGE_M3_API_KEY ? { authorization: `Bearer ${config.BGE_M3_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: config.BGE_M3_MODEL, input: texts }),
    });
    if (!response.ok) throw new Error(`embedding_failed:${response.status}`);
    const body = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
    const embeddings = body.data.sort((left, right) => left.index - right.index).map((item) => item.embedding);
    if (embeddings.length !== texts.length || embeddings.some((embedding) => embedding.length !== 1024)) {
      throw new Error("embedding_shape_invalid");
    }
    return embeddings;
  }
}
