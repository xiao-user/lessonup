import { lessonSelectionMatches } from "../../../src/features/lesson-files/lesson-selection-text.js";
import type { LessonAgentSelection, LessonPlan } from "../../domain.js";

/** Return only verified quote data, not the potentially large client snapshot. */
export function prepareCurrentSelection(
  selection: LessonAgentSelection | undefined,
  document: LessonPlan,
  documentVersion: number,
): (LessonAgentSelection & { documentVersion: number }) | undefined {
  if (!selection) return undefined;
  const input = selection as LessonAgentSelection & {
    fieldSnapshot?: string; baseDocumentVersion?: number; documentVersion?: number;
  };
  const field = document[input.field];
  if (input.documentVersion !== documentVersion
    || !Number.isInteger(input.baseDocumentVersion)
    || input.baseDocumentVersion! < 0 || input.baseDocumentVersion! > documentVersion
    || input.fieldSnapshot !== field || !lessonSelectionMatches(field, input.text)) throw new Error("selection_context_stale");
  return { field: input.field, start: input.start, end: input.end, text: input.text, documentVersion };
}
