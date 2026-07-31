import { describe, expect, it } from "vitest";
import {
  applyDocumentPatch,
  canonicalizeDocumentPatchRanges,
  DocumentPatchError,
  materializeDocumentPatchProposal,
  rebaseDocumentPatch,
  validateDocumentPatch,
} from "./document-patch.js";
import { documentPatchToolSchema, type LessonPlan } from "./domain.js";

const plan: LessonPlan = {
  unit: "第一单元", period: "1", totalPeriods: "2", topic: "轴对称",
  objectives: "理解轴对称。能够判断轴对称图形。", focus: "重点", preparation: "直尺",
  process: "观察。讨论。练习。", assessment: "口头说明", homework: "练习一",
  board: "轴对称", reflection: "待填写",
};

describe("document patch", () => {
  it("accepts a semantic proposal without model-authored versions or offsets", () => {
    const proposal = documentPatchToolSchema.parse({
      summary: "更新教学目标",
      operations: [{
        field: "objectives",
        expectedText: "理解",
        replacement: "解释",
      }],
    });
    const patch = materializeDocumentPatchProposal({
      proposal,
      fileId: "m1",
      documentVersion: 7,
      plan,
    });

    expect(patch).toMatchObject({
      fileId: "m1",
      baseDocumentVersion: 7,
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: 2,
        expectedText: "理解",
        replacement: "解释",
      }],
    });
  });

  it("rejects semantic proposals whose source text is not unique", () => {
    expect(() => materializeDocumentPatchProposal({
      proposal: {
        summary: "替换重复内容",
        operations: [{
          field: "process",
          expectedText: "。",
          replacement: "；",
        }],
      },
      fileId: "m1",
      documentVersion: 7,
      plan,
    })).toThrow(/修改原文不唯一/);
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

  it("rebases a safe replacement after unrelated text is inserted before it", () => {
    const patch = canonicalizeDocumentPatchRanges({
      fileId: "m1", baseDocumentVersion: 3, summary: "更新第二项目标",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 6,
        end: 8,
        expectedText: "能够",
        replacement: "独立",
      }],
    }, plan);
    const current = {
      ...plan,
      objectives: `新增说明。${plan.objectives}`,
    };

    const rebased = rebaseDocumentPatch(patch, current, 4);

    expect(rebased.baseDocumentVersion).toBe(4);
    expect(applyDocumentPatch(current, rebased).objectives)
      .toBe("新增说明。理解轴对称。独立判断轴对称图形。");
  });

  it("preserves later teacher edits when the proposed target is unchanged", () => {
    const patch = canonicalizeDocumentPatchRanges({
      fileId: "m1", baseDocumentVersion: 3, summary: "更新第一项目标",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: 2,
        expectedText: "理解",
        replacement: "解释",
      }],
    }, plan);
    const current = {
      ...plan,
      objectives: `${plan.objectives}\n补充教师观察记录。`,
    };

    const rebased = rebaseDocumentPatch(patch, current, 4);

    expect(applyDocumentPatch(current, rebased).objectives)
      .toBe("解释轴对称。能够判断轴对称图形。\n补充教师观察记录。");
  });

  it("rejects a true conflict when the teacher changed the proposed target", () => {
    const patch = canonicalizeDocumentPatchRanges({
      fileId: "m1", baseDocumentVersion: 3, summary: "更新第一项目标",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: 2,
        expectedText: "理解",
        replacement: "解释",
      }],
    }, plan);
    const current = {
      ...plan,
      objectives: "掌握轴对称。能够判断轴对称图形。",
    };

    expect(() => rebaseDocumentPatch(patch, current, 4))
      .toThrow(/目标内容已变化或无法唯一定位/);
  });

  it("rejects operations and aggregate patches that do not change the document", () => {
    expect(() => validateDocumentPatch({
      fileId: "m1", baseDocumentVersion: 0, summary: "空修改",
      operations: [{
        op: "replace_text",
        field: "process",
        start: 0,
        end: 0,
        expectedText: "",
        replacement: "",
      }],
    })).toThrow(/no_effect_patch|修改前后内容相同/);
  });
});
