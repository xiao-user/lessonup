import { lessonFieldLabels } from "./document-patch.js";

export const isDocumentApproval = (approval) => Boolean(approval?.patch && "baseDocumentVersion" in approval.patch);

export function reduceDocumentDraft(draft, event) {
  if (event.type === "document.draft") return { ...event, state: "streaming" };
  if (!draft || draft.runId !== event.runId) return draft;
  if (event.type === "document.draft.discarded" && draft.toolCallId !== event.toolCallId) return draft;
  if (["document.draft.discarded", "run.failed", "run.cancelled", "run.completed"].includes(event.type)) return null;
  if (event.type === "approval.required" && draft.toolCallId === event.toolCallId) return null;
  return draft;
}

/** Preview only. Never feed this value into editor history, autosave or flush. */
export function previewDocumentDraft(plan, draft) {
  if (!draft) return plan;
  const next = { ...plan };
  if (draft.fields) {
    for (const [field, value] of Object.entries(draft.fields)) {
      if (Object.hasOwn(lessonFieldLabels, field) && typeof value === "string") next[field] = value;
    }
    return next;
  }
  for (const op of draft.patch?.operations ?? []) {
    if (!Object.hasOwn(lessonFieldLabels, op.field) || typeof op.replacement !== "string") return null;
    const value = next[op.field];
    const start = op.start ?? 0;
    const end = op.end ?? value.length;
    if (value.slice(start, end) !== op.expectedText) return null;
    next[op.field] = value.slice(0, start) + op.replacement + value.slice(end);
  }
  return next;
}
