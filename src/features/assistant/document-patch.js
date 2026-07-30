export function applyClientDocumentPatch(plan, patch) {
  const next = { ...plan };
  const grouped = new Map();
  for (const operation of patch.operations) {
    const operations = grouped.get(operation.field) ?? [];
    operations.push(operation);
    grouped.set(operation.field, operations);
  }
  for (const [field, operations] of grouped) {
    let value = String(next[field] ?? "");
    for (const operation of [...operations].sort((left, right) => right.start - left.start)) {
      if (value.slice(operation.start, operation.end) !== operation.expectedText) {
        throw new Error("stale_document");
      }
      value = `${value.slice(0, operation.start)}${operation.replacement}${value.slice(operation.end)}`;
    }
    next[field] = value;
  }
  return next;
}
