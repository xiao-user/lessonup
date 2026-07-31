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
