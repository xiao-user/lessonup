export const lessonFieldLabels = {
  unit: "课程单元",
  period: "课时",
  totalPeriods: "总课时",
  topic: "课题",
  objectives: "教学目标",
  focus: "重点难点",
  preparation: "教学准备",
  process: "教学过程",
  assessment: "评价练习",
  homework: "作业设计",
  board: "板书设计",
  reflection: "教学反思",
};

function changedWindow(before, after, contextLength = 72) {
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < suffixLimit
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const prefixContext = before.slice(Math.max(0, prefix - contextLength), prefix);
  const suffixContext = before.slice(
    before.length - suffix,
    Math.min(before.length, before.length - suffix + contextLength),
  );
  return {
    before: `${prefix > contextLength ? "…" : ""}${prefixContext}${before.slice(prefix, before.length - suffix)}${suffixContext}${suffix > contextLength ? "…" : ""}`,
    after: `${prefix > contextLength ? "…" : ""}${prefixContext}${after.slice(prefix, after.length - suffix)}${suffixContext}${suffix > contextLength ? "…" : ""}`,
  };
}

export function presentPatchOperation(operation) {
  const before = operation.expectedText;
  const after = operation.replacement;
  const compact = before.length <= 280 && after.length <= 280;
  return {
    fieldLabel: lessonFieldLabels[operation.field] ?? "教案栏目",
    isNoEffect: before === after,
    before: compact ? before : changedWindow(before, after).before,
    after: compact ? after : changedWindow(before, after).after,
    fullBefore: before,
    fullAfter: after,
    isTruncated: !compact,
  };
}

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
