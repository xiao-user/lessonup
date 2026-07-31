export function assertCurrentDocumentVersion(actual: number, expected?: number) {
  if (expected !== undefined && actual !== expected) {
    throw new Error("document_context_stale");
  }
}
