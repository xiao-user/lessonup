function normalizedSourceKey(source) {
  if (source.url) return `url:${source.url.trim().toLowerCase()}`;
  if (source.id) return `id:${source.id}`;
  return [
    source.kind ?? "unknown",
    source.title?.trim().toLowerCase() ?? "",
  ].join(":");
}

export function dedupeAgentSources(sources = []) {
  const seen = new Set();
  return sources.filter((source) => {
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
