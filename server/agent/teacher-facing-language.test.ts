import { describe, expect, it } from "vitest";

import {
  presentSemesterBlueprintForAgent,
  presentSemesterUnitForAgent,
} from "./teacher-facing-language.js";

describe("teacher-facing tool presentation", () => {
  it("keeps machine ids under toolRef and exposes UI labels for agent prose", () => {
    const presented = presentSemesterBlueprintForAgent({
      id: "bp-1",
      semesterUnitId: "unit-1",
      curriculumNodeId: "node-1",
      chapterPeriodNo: 2,
      sortNo: 4,
      version: 1,
      title: "第2课时：拟人",
      mainActivity: "比较拟人句",
      observableProduct: "批注卡",
      assessmentEvidence: "能说明拟人作用",
      anticipatedDifficulties: ["把修辞当装饰"],
      plannedMinutes: 40,
      teacherNotes: "",
      status: "planned",
    }, {
      curriculumNodeTitle: "济南的冬天",
      knowledgePoints: [{ name: "拟人" }],
      periodRecommendations: [{ periodNo: 2 }],
    });

    expect(presented.toolRef).toEqual({
      blueprintId: "bp-1",
      semesterUnitId: "unit-1",
      curriculumNodeId: "node-1",
      chapterPeriodNo: 2,
      sortNo: 4,
      version: 1,
    });
    expect(presented).toMatchObject({
      课时名称: "第2课时：拟人",
      章节课时: "第2课时",
      教材章节: "济南的冬天",
      主要教学活动: "比较拟人句",
      学生可观察产出: "批注卡",
      达成证据: "能说明拟人作用",
    });
    expect(presented).not.toHaveProperty("mainActivity");
    expect(presented).not.toHaveProperty("chapterPeriodNo");
  });

  it("presents units with semantic labels", () => {
    expect(presentSemesterUnitForAgent({
      id: "unit-1",
      curriculumNodeId: "ch1",
      plannedStartWeek: 1,
      plannedEndWeek: 3,
      plannedPeriods: 6,
      learningGoals: "感受冬天的温晴",
      teacherNotes: "",
      status: "planned",
    }, "第一单元")).toMatchObject({
      toolRef: { unitId: "unit-1", curriculumNodeId: "ch1" },
      教材单元: "第一单元",
      单元目标: "感受冬天的温晴",
    });
  });
});
