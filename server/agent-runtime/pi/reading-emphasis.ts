import type { LessonField } from "../../domain.js";
import { getLessonHighlightSpans } from "../../../src/features/lesson-files/lesson-selection-text.js";

/** Delivery facts derived from the exact replacement text, never a second model-authored manifest. */
export type VerifiedReadingEmphasis = {
  kind: "marked" | "not_needed";
  count: number;
  fields: LessonField[];
};

/**
 * Reading marks are part of the lesson body. The renderer is the source of
 * truth for what will actually appear, so deriving the receipt from the final
 * replacements removes a redundant, failure-prone model round trip without
 * weakening any content or rendering validation.
 */
export function deriveReadingEmphasis(
  operations: Array<{ field: LessonField; replacement: string }>,
): VerifiedReadingEmphasis {
  const actual = operations.flatMap(({ field, replacement }) => getLessonHighlightSpans(replacement).map(span => ({ field, ...span })));
  return {
    kind: actual.length ? "marked" : "not_needed",
    count: actual.length,
    fields: [...new Set(actual.map(span => span.field))],
  };
}
