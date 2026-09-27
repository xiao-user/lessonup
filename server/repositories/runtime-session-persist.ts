/**
 * Pi runtime sessions keep a CAS header and append-only protocol rows.
 * The coordinator still submits the desired prefix; adapters write only the
 * tail, or delete a repaired suffix. A same-length rewrite (for example an
 * orphan `approval_required` result) must start at the first changed index.
 */
export function firstChangedRuntimeMessageIndex(stored: unknown[], incoming: unknown[]) {
  const shared = Math.min(stored.length, incoming.length);
  for (let index = 0; index < shared; index += 1) {
    if (JSON.stringify(stored[index]) !== JSON.stringify(incoming[index])) return index;
  }
  return shared;
}

export function runtimeSessionWritePlan(
  storedCount: number,
  incomingCount: number,
  rewriteFrom?: number,
) {
  const from = rewriteFrom === undefined
    ? Math.min(storedCount, incomingCount)
    : Math.min(Math.max(rewriteFrom, 0), storedCount, incomingCount);
  return {
    deleteAfter: from < storedCount ? from : null,
    appendFrom: from,
  };
}
