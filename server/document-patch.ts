import {
  documentPatchSchema,
  type DocumentPatch,
  type LessonPlan,
} from "./domain.js";

export class DocumentPatchError extends Error {
  constructor(
    public readonly code: "invalid_patch" | "stale_document" | "text_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DocumentPatchError";
  }
}

export function validateDocumentPatch(patchInput: unknown, plan?: LessonPlan): DocumentPatch {
  const parsed = documentPatchSchema.safeParse(patchInput);
  if (!parsed.success) {
    throw new DocumentPatchError("invalid_patch", parsed.error.issues[0]?.message ?? "无效修改");
  }

  const patch = parsed.data;
  const grouped = new Map<string, typeof patch.operations>();
  for (const operation of patch.operations) {
    if (operation.end < operation.start) {
      throw new DocumentPatchError("invalid_patch", "修改区间的结束位置不能早于开始位置");
    }
    const operations = grouped.get(operation.field) ?? [];
    operations.push(operation);
    grouped.set(operation.field, operations);
  }

  for (const [field, operations] of grouped) {
    const sorted = [...operations].sort((left, right) => left.start - right.start);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].start < sorted[index - 1].end) {
        throw new DocumentPatchError("invalid_patch", `${field} 中存在重叠的修改区间`);
      }
    }

    if (plan) {
      const source = plan[field as keyof LessonPlan];
      for (const operation of sorted) {
        if (source.slice(operation.start, operation.end) !== operation.expectedText) {
          throw new DocumentPatchError("text_mismatch", `${field} 的原文已经变化`);
        }
      }
    }
  }

  return patch;
}

export function canonicalizeDocumentPatchRanges(
  patchInput: unknown,
  plan: LessonPlan,
): DocumentPatch {
  const patch = validateDocumentPatch(patchInput);
  const operations = patch.operations.map((operation) => {
    const source = plan[operation.field];
    if (source.slice(operation.start, operation.end) === operation.expectedText) {
      return operation;
    }

    const inferredEnd = operation.start + operation.expectedText.length;
    if (source.slice(operation.start, inferredEnd) !== operation.expectedText) {
      throw new DocumentPatchError("text_mismatch", `${operation.field} 的原文已经变化`);
    }
    return { ...operation, end: inferredEnd };
  });

  return validateDocumentPatch({ ...patch, operations }, plan);
}

export function applyDocumentPatch(plan: LessonPlan, patchInput: unknown): LessonPlan {
  const patch = validateDocumentPatch(patchInput, plan);
  const nextPlan = { ...plan };
  const grouped = new Map<keyof LessonPlan, typeof patch.operations>();

  for (const operation of patch.operations) {
    const field = operation.field as keyof LessonPlan;
    grouped.set(field, [...(grouped.get(field) ?? []), operation]);
  }

  for (const [field, operations] of grouped) {
    let value = nextPlan[field];
    for (const operation of [...operations].sort((left, right) => right.start - left.start)) {
      value = `${value.slice(0, operation.start)}${operation.replacement}${value.slice(operation.end)}`;
    }
    nextPlan[field] = value;
  }

  return nextPlan;
}
