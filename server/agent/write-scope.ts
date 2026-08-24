import type { DocumentPatchProposal, LessonField } from "../domain.js";
import { lessonFieldLabels } from "./tool-presentation.js";

export class WritePreflightError extends Error {
  constructor(readonly code: string, readonly guidance?: string) {
    super(guidance ?? code);
    this.name = "WritePreflightError";
  }
}

export function assertDocumentWriteScope(
  proposal: Pick<DocumentPatchProposal, "operations">,
  allowedFields?: LessonField[],
) {
  if (!allowedFields?.length) return;
  const allowed = new Set(allowedFields);
  const unexpected = [...new Set(
    proposal.operations
      .map((operation) => operation.field)
      .filter((field) => !allowed.has(field)),
  )];
  if (!unexpected.length) return;
  throw new WritePreflightError(
    "document_field_scope_exceeded",
    `教师本轮明确要求写入范围仅限${allowedFields.map((field) => `“${lessonFieldLabels[field]}”`).join("、")}。可以读取其他栏目作为生成依据，但修改提案不能包含${unexpected.map((field) => `“${lessonFieldLabels[field]}”`).join("、")}；请删除超出范围的操作后重新提交。`,
  );
}
