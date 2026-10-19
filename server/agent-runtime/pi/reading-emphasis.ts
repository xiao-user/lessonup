import { z } from "zod";
import type { LessonField } from "../../domain.js";
import { lessonFieldSchema } from "../../domain.js";
import { getLessonHighlightSpans } from "../../../src/features/lesson-files/lesson-selection-text.js";

/** A verifiable reading design, composed with the lesson rather than added by a keyword pass. */
export const readingEmphasisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("marked"),
    reason: z.string().min(1).max(500),
    spans: z.array(z.object({
      field: lessonFieldSchema,
      text: z.string().min(1).max(2_000),
      tone: z.enum(["yellow", "pink", "green", "blue", "red"]),
    })).min(1).max(128),
  }),
  z.object({
    kind: z.literal("not_needed"),
    reason: z.string().min(1).max(500),
  }),
]);
export type ReadingEmphasis = z.infer<typeof readingEmphasisSchema>;

type MarkedSpan = { field: LessonField; text: string; tone: string };
const key = (span: MarkedSpan) => JSON.stringify([span.field, span.tone, span.text]);

/** Verified delivery facts, independent of the declared shape so receipts stay typed. */
export type VerifiedReadingEmphasis = {
  kind: ReadingEmphasis["kind"];
  count: number;
  fields: LessonField[];
  reason: string;
};

/** Compare actual parsed marks, including repeated occurrences, with declared reading anchors. */
export function verifyReadingEmphasis(
  emphasis: ReadingEmphasis,
  operations: Array<{ field: LessonField; replacement: string }>,
): VerifiedReadingEmphasis {
  const actual = operations.flatMap(({ field, replacement }) => getLessonHighlightSpans(replacement).map(span => ({ field, ...span })));
  const declared = emphasis.kind === "marked" ? emphasis.spans : [];
  const observed = actual.map(key).sort();
  const promised = declared.map(key).sort();
  if (JSON.stringify(observed) !== JSON.stringify(promised)) {
    // Only the native model receives these task-local anchors, never raw provider data.
    throw new Error(`reading_emphasis_mismatch:${JSON.stringify({
      instruction: "阅读重点声明必须与 replacement 中实际可渲染的标记逐项一致。按内容重要性直接修正正文与 spans；不需要标记时使用 not_needed 并说明原因，不能声称已涂色。不要改变无关事实或为凑数新增内容。",
      actual, declared,
    })}`);
  }
  return { kind: emphasis.kind, count: actual.length, fields: [...new Set(actual.map(span => span.field))], reason: emphasis.reason };
}
