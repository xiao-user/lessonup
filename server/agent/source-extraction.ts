import type { SourceRef } from "../domain.js";
import { presentableSource } from "./source-policy.js";

const sourceKind = (value: Record<string, unknown>): SourceRef["kind"] => {
  if (value.kind === "public" || value.kind === "private" || value.kind === "web") return value.kind;
  return typeof value.url === "string" ? "web" : "private";
};

function unpackSourcePayload(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") {
    try {
      return unpackSourcePayload(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => unpackSourcePayload(item, depth + 1));
  }
  if (typeof value !== "object") return [];

  const object = value as Record<string, unknown>;
  if (typeof object.title === "string") return [object];
  if (object.type === "text" && typeof object.text === "string") {
    return unpackSourcePayload(object.text, depth + 1);
  }
  if (Array.isArray(object.content)) {
    return unpackSourcePayload(object.content, depth + 1);
  }
  if (object.structuredContent !== undefined) {
    return unpackSourcePayload(object.structuredContent, depth + 1);
  }
  if (Array.isArray(object.sources)) {
    return unpackSourcePayload(object.sources, depth + 1);
  }
  return [];
}

export function extractSources(value: unknown): SourceRef[] {
  return unpackSourcePayload(value).flatMap((source): SourceRef[] => {
    const id = source.id ?? source.chunkId ?? source.url;
    if (typeof source.title !== "string" || typeof id !== "string") return [];
    return [presentableSource({
      id,
      title: source.title,
      url: typeof source.url === "string" ? source.url : undefined,
      kind: sourceKind(source),
      page: typeof source.page === "number" && Number.isInteger(source.page) && source.page > 0
        ? source.page
        : undefined,
      chunkId: typeof source.chunkId === "string" ? source.chunkId : undefined,
    })];
  });
}
