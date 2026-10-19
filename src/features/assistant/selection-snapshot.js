import { lessonSelectionMatches } from "../lesson-files/lesson-selection-text.js";

// Selection ranges are editor text offsets, never Markdown string offsets.
export function prepareSelectionSnapshot(selection, document, documentVersion) {
  if (!selection) return undefined;
  if (!Number.isInteger(selection.baseDocumentVersion)
    || selection.baseDocumentVersion < 0
    || selection.baseDocumentVersion > documentVersion
    || typeof selection.fieldSnapshot !== "string"
    || document?.[selection.field] !== selection.fieldSnapshot
    || !lessonSelectionMatches(selection.fieldSnapshot, selection.text)) {
    throw new Error("selection_context_stale");
  }
  return { ...selection, documentVersion };
}
