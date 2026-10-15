import { hasEmbeddingProvider } from "../config.js";
import { ConfiguredEmbeddingProvider } from "./embeddings.js";

/** A search query is embedded inline, so a slow provider must not stall the tool call. */
const QUERY_EMBEDDING_TIMEOUT_MS = 4_000;

export type QueryEmbedder = (query: string, signal?: AbortSignal) => Promise<number[]>;

/** Undefined when no embedding service is configured; retrieval is then lexical only. */
export function createQueryEmbedder(
  provider = new ConfiguredEmbeddingProvider(),
  configured = hasEmbeddingProvider,
): QueryEmbedder | undefined {
  if (!configured) return undefined;
  return async (query, signal) => {
    const timeout = AbortSignal.timeout(QUERY_EMBEDDING_TIMEOUT_MS);
    const [vector] = await provider.embed([query], signal ? AbortSignal.any([signal, timeout]) : timeout);
    if (!vector) throw new Error("embedding_shape_invalid");
    return vector;
  };
}

/**
 * Embeds a search query when a service is configured. A failure only costs
 * ranking quality, so it degrades to lexical retrieval; `degraded` lets callers
 * avoid caching a result that would otherwise be served after the service recovers.
 */
export async function tryEmbedQuery(embed: QueryEmbedder | undefined, query: string, signal?: AbortSignal) {
  if (!embed) return { vector: undefined, degraded: false };
  try {
    return { vector: await embed(query, signal), degraded: false };
  } catch (error) {
    console.warn("Query embedding unavailable; using lexical retrieval", error instanceof Error ? error.message : "unknown_error");
    return { vector: undefined, degraded: true };
  }
}
