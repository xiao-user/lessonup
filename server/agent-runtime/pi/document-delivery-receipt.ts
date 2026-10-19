import type { LessonField } from "../../domain.js";
import { lessonFieldLabels } from "../../agent/tool-presentation.js";
import type { VerifiedReadingEmphasis } from "./reading-emphasis.js";

/**
 * Delivery facts for a lesson patch are derived from the materialized proposal
 * and the verified emphasis manifest. A free-text model summary is never the
 * source of a teacher-facing completion claim; it cannot survive a preflight
 * that produced nothing, and it may not pass an unverified promise through the
 * receipt.
 */
export function documentDeliveryReceipt(
  operations: Array<{ field: LessonField }>,
  emphasis: VerifiedReadingEmphasis,
): string {
  const fields = [...new Set(operations.map((operation) => operation.field))]
    .map((field) => `“${lessonFieldLabels[field]}”`).join("、");
  const reading = emphasis.kind === "marked" && emphasis.count > 0
    ? `并在${emphasis.fields.map((field) => `“${lessonFieldLabels[field]}”`).join("、")}保留 ${emphasis.count} 处阅读重点标记`
    : "本次未增加阅读重点标记";
  return `已准备当前教案${fields}的修改，${reading}；采用前不会写入教案。`;
}
