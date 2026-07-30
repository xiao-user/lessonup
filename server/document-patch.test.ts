import { describe, expect, it } from "vitest";
import {
  applyDocumentPatch,
  canonicalizeDocumentPatchRanges,
  DocumentPatchError,
  validateDocumentPatch,
} from "./document-patch.js";
import { documentPatchSchema, documentPatchToolSchema, type LessonPlan } from "./domain.js";

const plan: LessonPlan = {
  unit: "第一单元", period: "1", totalPeriods: "2", topic: "轴对称",
  objectives: "理解轴对称。能够判断轴对称图形。", focus: "重点", preparation: "直尺",
  process: "观察。讨论。练习。", assessment: "口头说明", homework: "练习一",
  board: "轴对称", reflection: "待填写",
};

describe("document patch", () => {
  it("normalizes a model-provided null citations field to no citations", () => {
    const toolInput = documentPatchToolSchema.parse({
      baseDocumentVersion: 0,
      summary: "更新教学目标",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: 1,
        expectedText: "旧",
        replacement: "新",
      }],
      citations: null,
    });
    const patch = documentPatchSchema.parse({ ...toolInput, fileId: "m1" });

    expect(patch.citations).toBeUndefined();
  });

  it("applies multiple operations from the same base document without offset drift", () => {
    const result = applyDocumentPatch(plan, {
      fileId: "m1",
      baseDocumentVersion: 3,
      summary: "让目标可观察",
      operations: [
        { op: "replace_text", field: "objectives", start: 0, end: 2, expectedText: "理解", replacement: "解释" },
        { op: "replace_text", field: "objectives", start: 6, end: 8, expectedText: "能够", replacement: "独立" },
      ],
    });
    expect(result.objectives).toBe("解释轴对称。独立判断轴对称图形。");
    expect(plan.objectives).toBe("理解轴对称。能够判断轴对称图形。");
  });

  it("corrects an exclusive end offset when expectedText exactly identifies the source range", () => {
    const patch = canonicalizeDocumentPatchRanges({
      fileId: "m1",
      baseDocumentVersion: 0,
      summary: "更新教学目标",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: 3,
        expectedText: "理解轴对称。",
        replacement: "解释轴对称。",
      }],
    }, plan);

    expect(patch.operations[0].end).toBe("理解轴对称。".length);
    expect(applyDocumentPatch(plan, patch).objectives).toContain("解释轴对称。");
  });

  it("does not correct a range when expectedText is absent at the declared start", () => {
    expect(() => canonicalizeDocumentPatchRanges({
      fileId: "m1",
      baseDocumentVersion: 0,
      summary: "错误范围",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 1,
        end: 3,
        expectedText: "理解轴对称。",
        replacement: "解释轴对称。",
      }],
    }, plan)).toThrow(/原文已经变化/);
  });

  it("rejects overlapping ranges", () => {
    expect(() => validateDocumentPatch({
      fileId: "m1", baseDocumentVersion: 0, summary: "冲突",
      operations: [
        { op: "replace_text", field: "process", start: 0, end: 4, expectedText: "观察。讨", replacement: "A" },
        { op: "replace_text", field: "process", start: 3, end: 5, expectedText: "讨论", replacement: "B" },
      ],
    })).toThrow(DocumentPatchError);
  });

  it("rejects stale expected text", () => {
    expect(() => applyDocumentPatch(plan, {
      fileId: "m1", baseDocumentVersion: 0, summary: "过期",
      operations: [{ op: "replace_text", field: "topic", start: 0, end: 2, expectedText: "几何", replacement: "图形" }],
    })).toThrow(/原文已经变化/);
  });
});
