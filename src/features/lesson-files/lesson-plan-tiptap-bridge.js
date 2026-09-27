import { normalizeEditableText } from "./editable-text.js";

/**
 * Apply one editor fragment to the canonical field document.
 *
 * A4 pages are only a projection. A Tiptap transaction may replace the field
 * fragment it owns, but it must never serialize sibling fields or page wrappers
 * back into storage.
 */
export function applyLessonFieldEdit(plan, edit) {
  const field = edit?.field;
  if (!field) return plan;

  const source = String(plan[field] ?? "");
  const start = Math.min(Math.max(0, Number(edit.start) || 0), source.length);
  const previousValue = normalizeEditableText(String(edit.previousValue ?? ""));
  const value = normalizeEditableText(String(edit.value ?? ""));
  const replacedEnd = Math.min(source.length, start + previousValue.length);
  const nextValue = `${source.slice(0, start)}${value}${source.slice(replacedEnd)}`;
  if (nextValue === source) return plan;
  return { ...plan, [field]: nextValue };
}
