import type { WebSearchProvider, WebSearchResult } from "../server/providers/web-search.js";

const privateHostPatterns = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe80:/i,
];

function assertSafePublicHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_url_protocol");
  if (privateHostPatterns.some((pattern) => pattern.test(url.hostname))) throw new Error("private_network_url_denied");
  return url.toString();
}

/**
 * Worker-safe web retrieval: all page extraction stays at Tavily. That keeps
 * the Worker from opening arbitrary origins, while preserving the same public
 * search/open port used by Pi tools.
 */
export class WorkerTavilyWebSearchProvider implements WebSearchProvider {
  constructor(private readonly apiKey: string | undefined) {}

  async search(query: string, limit = 5): Promise<WebSearchResult[]> {
    if (!this.apiKey) throw new Error("web_search_not_configured");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: Math.min(8, Math.max(1, limit)),
        include_answer: false,
        search_depth: "advanced",
      }),
    });
    if (!response.ok) throw new Error(`web_search_failed:${response.status}`);
    const data = await response.json() as { results?: WebSearchResult[] };
    return (data.results ?? []).map((result) => ({ ...result, url: assertSafePublicHttpUrl(result.url) }));
  }

  async open(url: string) {
    if (!this.apiKey) throw new Error("web_search_not_configured");
    const requestedUrl = assertSafePublicHttpUrl(url);
    const response = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ urls: requestedUrl, extract_depth: "basic" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`open_web_failed:${response.status}`);
    const data = await response.json() as { results?: Array<{ url?: string; raw_content?: string }> };
    const result = data.results?.find((item) => item.raw_content?.trim());
    if (!result?.raw_content) throw new Error("open_web_empty");
    return {
      url: assertSafePublicHttpUrl(result.url ?? requestedUrl),
      content: result.raw_content.replace(/\s+/g, " ").trim().slice(0, 24_000),
    };
  }
}
