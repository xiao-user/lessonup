import { config } from "../config.js";

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

const privateHostPatterns = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

export function assertSafeWebUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_url_protocol");
  if (privateHostPatterns.some((pattern) => pattern.test(url.hostname))) throw new Error("private_network_url_denied");
  return url;
}

export interface WebSearchProvider {
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
  open(url: string): Promise<{ url: string; content: string }>;
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  async search(query: string, limit = 5) {
    if (!config.TAVILY_API_KEY) throw new Error("web_search_not_configured");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.TAVILY_API_KEY,
        query,
        max_results: Math.min(8, Math.max(1, limit)),
        include_answer: false,
        search_depth: "advanced",
      }),
    });
    if (!response.ok) throw new Error(`web_search_failed:${response.status}`);
    const data = await response.json() as { results?: WebSearchResult[] };
    return (data.results ?? []).map((result) => ({
      title: result.title,
      url: assertSafeWebUrl(result.url).toString(),
      content: result.content,
      score: result.score,
    }));
  }

  async open(value: string) {
    let url = assertSafeWebUrl(value);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "user-agent": "LessonUp/1.0 (+https://lessonup.local)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("invalid_redirect");
        url = assertSafeWebUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`open_web_failed:${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new Error("unsupported_web_content");
      }
      const html = (await response.text()).slice(0, 500_000);
      const content = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24_000);
      return { url: url.toString(), content };
    }
    throw new Error("too_many_redirects");
  }
}
