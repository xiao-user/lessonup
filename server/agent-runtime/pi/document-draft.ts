import { lessonFieldSchema, type LessonField, type ResourcePatch } from "../../domain.js";

export const isDocumentDraftPatch = (patch: ResourcePatch) => (
  "baseDocumentVersion" in patch && "operations" in patch
);

/** Only semantic document text is public; never forward raw tool arguments. */
export function documentDraftFields(name: string, args: unknown): Partial<Record<LessonField, string>> | null {
  if (!["propose_document_patch", "propose_lesson_design_change", "propose_design_basis_projection"].includes(name)) return null;
  if (!args || typeof args !== "object") return null;
  const input = args as Record<string, unknown>;
  const operations = name === "propose_lesson_design_change" ? input.documentOperations : input.operations;
  if (!Array.isArray(operations)) return null;
  const fields: Partial<Record<LessonField, string>> = {};
  for (const operation of operations.slice(0, 32)) {
    if (!operation || typeof operation !== "object") continue;
    const field = lessonFieldSchema.safeParse(operation.field);
    if (field.success && typeof operation.replacement === "string") fields[field.data] = operation.replacement;
  }
  return Object.keys(fields).length ? fields : null;
}
