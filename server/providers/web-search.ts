import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

function isPrivateAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

export async function assertPublicWebUrl(
  value: string,
  resolve: typeof lookup = lookup,
) {
  const url = assertSafeWebUrl(value);
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return url;
  const addresses = await resolve(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("private_network_url_denied");
  }
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
    let url = await assertPublicWebUrl(value);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "user-agent": "LessonUp/1.0 (+https://lessonup.local)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("invalid_redirect");
        url = await assertPublicWebUrl(new URL(location, url).toString());
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
