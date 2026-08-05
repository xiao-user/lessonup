function normalizedSourceKey(source) {
  if (source.url) return `url:${source.url.trim().toLowerCase()}`;
  if (source.id) return `id:${source.id}`;
  return [
    source.kind ?? "unknown",
    source.title?.trim().toLowerCase() ?? "",
  ].join(":");
}

function presentableSource(source) {
  if (!source.url) return source;
  try {
    const hostname = new URL(source.url).hostname.toLowerCase();
    if (hostname === "ykt.cbern.com.cn" || hostname.endsWith(".ykt.cbern.com.cn")) {
      const { url: _url, ...withoutUrl } = source;
      return withoutUrl;
    }
  } catch {
    return source;
  }
  return source;
}

export function dedupeAgentSources(sources = []) {
  const seen = new Set();
  return sources.map(presentableSource).filter((source) => {
    const key = normalizedSourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function latestAssistantSources(messages = []) {
  const message = messages.findLast((item) => item.role === "assistant");
  return dedupeAgentSources(message?.sources ?? []);
}
