import { describe, expect, it } from "vitest";

import { presentPatchOperation } from "./document-patch";

describe("patch presentation", () => {
  it("shows the changed context instead of raw offsets for a long replacement", () => {
    const common = "相同的教学过程。".repeat(40);
    const preview = presentPatchOperation({
      field: "process",
      expectedText: `${common}旧问题${common}`,
      replacement: `${common}新问题${common}`,
    });

    expect(preview.fieldLabel).toBe("教学过程");
    expect(preview.isTruncated).toBe(true);
    expect(preview.before).toContain("旧问题");
    expect(preview.after).toContain("新问题");
    expect(preview.before.length).toBeLessThan(preview.fullBefore.length);
  });

  it("identifies historical no-op approvals without presenting them as deletion", () => {
    expect(presentPatchOperation({
      field: "process",
      expectedText: "",
      replacement: "",
    })).toMatchObject({
      isNoEffect: true,
      before: "",
      after: "",
    });
  });

  it("presents semester framework changes as business fields instead of document offsets", () => {
    expect(presentPatchOperation({
      op: "replace_unit_field",
      unitId: "00000000-0000-4000-8000-000000000001",
      field: "learningGoals",
      expectedValue: "理解重点内容",
      replacement: "能够用证据解释重点内容",
    })).toMatchObject({
      fieldLabel: "单元目标",
      targetKind: "unit",
      before: "理解重点内容",
      after: "能够用证据解释重点内容",
      isNoEffect: false,
    });
  });

  it("presents blueprint creation and deletion as explicit domain actions", () => {
    expect(presentPatchOperation({
      op: "create_lesson_blueprint",
      plannedPeriod: 2,
      title: "景物观察与证据",
      mainActivity: "分类圈画内容",
      observableProduct: "观察证据表",
      assessmentEvidence: "能够引用原文说明",
      plannedMinutes: 40,
    })).toMatchObject({
      fieldLabel: "新增第 2 课时蓝图",
      targetKind: "blueprint",
      before: "（尚未创建）",
    });

    expect(presentPatchOperation({
      op: "delete_lesson_blueprint",
      expectedTitle: "景物观察与证据",
      expectedVersion: 3,
    })).toMatchObject({
      fieldLabel: "删除课时蓝图",
      targetKind: "blueprint",
      before: "景物观察与证据（版本 V3）",
      after: "删除蓝图，并移除其关联的知识点选择",
    });
  });

  it("presents design-basis decisions separately from A4 document edits", () => {
    expect(presentPatchOperation({
      op: "create_design_basis_entry",
      kind: "review",
      statement: "复习比喻的本体、喻体与相似点。",
      rationale: "本课需要据此判断比喻表达效果。",
    })).toMatchObject({
      fieldLabel: "新增复习旧知",
      targetKind: "design-basis",
      before: "（尚未记录）",
    });
  });
});
