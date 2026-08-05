import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
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
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateAddress(mappedIpv4);
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
      || normalized.startsWith("ff");
  }
  return true;
}

type PublicWebTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export async function resolvePublicWebUrl(
  value: string,
  resolve: typeof lookup = lookup,
): Promise<PublicWebTarget> {
  const url = assertSafeWebUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isPrivateAddress(hostname)) throw new Error("private_network_url_denied");
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }
  const addresses = await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("private_network_url_denied");
  }
  const selected = addresses[0];
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

export async function assertPublicWebUrl(
  value: string,
  resolve: typeof lookup = lookup,
) {
  return (await resolvePublicWebUrl(value, resolve)).url;
}

async function requestPinnedWebTarget(target: PublicWebTarget) {
  const bodyLimit = 500_000;
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, target.address, target.family);
  };
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const request = transport.request(target.url, {
      method: "GET",
      lookup: pinnedLookup,
      servername: target.url.hostname,
      headers: {
        "user-agent": "LessonUp/1.0 (+https://lessonup.local)",
        "accept-encoding": "identity",
      },
      signal: AbortSignal.timeout(10_000),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > bodyLimit) {
          request.destroy(new Error("web_content_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
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
    const original = await resolvePublicWebUrl(value);
    let target = original;
    try {
      for (let redirect = 0; redirect < 4; redirect += 1) {
        const response = await requestPinnedWebTarget(target);
        if (response.status >= 300 && response.status < 400) {
          const locationHeader = response.headers.location;
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          if (!location) throw new Error("invalid_redirect");
          target = await resolvePublicWebUrl(new URL(location, target.url).toString());
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`open_web_failed:${response.status}`);
        }
        const contentTypeHeader = response.headers["content-type"];
        const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
          throw new Error("unsupported_web_content");
        }
        const content = response.body
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 24_000);
        return { url: target.url.toString(), content };
      }
      throw new Error("too_many_redirects");
    } catch (directOpenError) {
      if (!config.TAVILY_API_KEY) throw directOpenError;
      const response = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.TAVILY_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          urls: original.url.toString(),
          extract_depth: "basic",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw directOpenError;
      const data = await response.json() as {
        results?: Array<{ url?: string; raw_content?: string }>;
      };
      const extracted = data.results?.find((result) => result.raw_content?.trim());
      if (!extracted?.raw_content) throw directOpenError;
      const extractedUrl = assertSafeWebUrl(
        extracted.url ?? original.url.toString(),
      ).toString();
      return {
        url: extractedUrl,
        content: extracted.raw_content.trim().slice(0, 24_000),
      };
    }
  }
}
