import type { SourceRef } from "./domain.js";

/**
 * Evidence is source-addressable for citations but passage-addressable for the
 * durable audit trail. A single retrieval may legitimately observe several
 * chunks from the same PDF, so source.id alone is not an idempotency key.
 */
export function runEvidenceIdentity(source: SourceRef) {
  return source.chunkId
    ? `chunk:${JSON.stringify([source.id, source.chunkId])}`
    : `source:${source.id}`;
}

export function uniqueRunEvidenceSources(sources: SourceRef[]) {
  const unique = new Map<string, SourceRef>();
  for (const source of sources) {
    unique.set(runEvidenceIdentity(source), source);
  }
  return [...unique.values()];
}
