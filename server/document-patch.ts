import {
  documentPatchSchema,
  type DocumentPatch,
  type DocumentPatchProposal,
  type LessonPlan,
} from "./domain.js";

const REBASE_CONTEXT_LENGTH = 32;

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
    if (operation.expectedText === operation.replacement) {
      throw new DocumentPatchError("invalid_patch", "修改前后内容相同");
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
    const inferredEnd = operation.start + operation.expectedText.length;
    if (source.slice(operation.start, inferredEnd) !== operation.expectedText) {
      throw new DocumentPatchError("text_mismatch", `${operation.field} 的原文已经变化`);
    }
    return {
      ...operation,
      end: inferredEnd,
      contextBefore: source.slice(
        Math.max(0, operation.start - REBASE_CONTEXT_LENGTH),
        operation.start,
      ),
      contextAfter: source.slice(
        inferredEnd,
        inferredEnd + REBASE_CONTEXT_LENGTH,
      ),
    };
  });

  return validateDocumentPatch({ ...patch, operations }, plan);
}

export function materializeDocumentPatchProposal(args: {
  proposal: DocumentPatchProposal;
  fileId: string;
  documentVersion: number;
  plan: LessonPlan;
}): DocumentPatch {
  const operations = args.proposal.operations.map((operation) => {
    const source = args.plan[operation.field];
    let start = 0;
    if (operation.expectedText) {
      start = source.indexOf(operation.expectedText);
      if (start < 0) {
        throw new DocumentPatchError(
          "text_mismatch",
          `${operation.field} 中找不到修改所依据的原文`,
        );
      }
      if (source.indexOf(operation.expectedText, start + 1) >= 0) {
        throw new DocumentPatchError(
          "invalid_patch",
          `${operation.field} 中的修改原文不唯一`,
        );
      }
    } else if (source.length > 0) {
      throw new DocumentPatchError(
        "invalid_patch",
        `${operation.field} 不是空栏目，不能使用无锚点插入`,
      );
    }
    const end = start + operation.expectedText.length;
    return {
      op: "replace_text" as const,
      field: operation.field,
      start,
      end,
      expectedText: operation.expectedText,
      replacement: operation.replacement,
      contextBefore: source.slice(Math.max(0, start - REBASE_CONTEXT_LENGTH), start),
      contextAfter: source.slice(end, end + REBASE_CONTEXT_LENGTH),
    };
  });
  return validateDocumentPatch({
    fileId: args.fileId,
    baseDocumentVersion: args.documentVersion,
    summary: args.proposal.summary,
    operations,
  }, args.plan);
}

/**
 * Rebinds a proposal to the latest canonical document without weakening conflict
 * detection. The document version remains a chronology/CAS token; exact text and
 * server-bound context determine whether an operation still addresses the same
 * piece of content.
 */
export function rebaseDocumentPatch(
  patchInput: unknown,
  plan: LessonPlan,
  documentVersion: number,
): DocumentPatch {
  const patch = validateDocumentPatch(patchInput);
  if (patch.baseDocumentVersion === documentVersion) {
    return canonicalizeDocumentPatchRanges(patch, plan);
  }

  const operations = patch.operations.map((operation) => {
    const source = plan[operation.field];
    if (!operation.expectedText) {
      throw new DocumentPatchError(
        "stale_document",
        `${operation.field} 的插入位置已经失去有效基准`,
      );
    }

    const originalEnd = operation.start + operation.expectedText.length;
    let resolvedStart = source.slice(operation.start, originalEnd) === operation.expectedText
      ? operation.start
      : -1;

    if (resolvedStart < 0 && (
      operation.contextBefore !== undefined
      || operation.contextAfter !== undefined
    )) {
      const candidates: number[] = [];
      let candidate = source.indexOf(operation.expectedText);
      while (candidate >= 0) {
        const beforeMatches = operation.contextBefore === undefined
          || source.slice(
            Math.max(0, candidate - operation.contextBefore.length),
            candidate,
          ) === operation.contextBefore;
        const candidateEnd = candidate + operation.expectedText.length;
        const afterMatches = operation.contextAfter === undefined
          || source.slice(candidateEnd, candidateEnd + operation.contextAfter.length)
            === operation.contextAfter;
        if (beforeMatches && afterMatches) candidates.push(candidate);
        candidate = source.indexOf(operation.expectedText, candidate + 1);
      }
      if (candidates.length === 1) resolvedStart = candidates[0];
    }

    if (resolvedStart < 0) {
      throw new DocumentPatchError(
        "stale_document",
        `${operation.field} 中的目标内容已变化或无法唯一定位`,
      );
    }

    const resolvedEnd = resolvedStart + operation.expectedText.length;
    return {
      ...operation,
      start: resolvedStart,
      end: resolvedEnd,
      contextBefore: source.slice(
        Math.max(0, resolvedStart - REBASE_CONTEXT_LENGTH),
        resolvedStart,
      ),
      contextAfter: source.slice(
        resolvedEnd,
        resolvedEnd + REBASE_CONTEXT_LENGTH,
      ),
    };
  });

  return validateDocumentPatch({
    ...patch,
    baseDocumentVersion: documentVersion,
    operations,
  }, plan);
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

  if (Object.keys(nextPlan).every((field) => (
    nextPlan[field as keyof LessonPlan] === plan[field as keyof LessonPlan]
  ))) {
    throw new DocumentPatchError("invalid_patch", "修改未产生任何实际变化");
  }

  return nextPlan;
}
