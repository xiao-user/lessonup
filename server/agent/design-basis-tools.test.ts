import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createLessonDesignBasisTools } from "./design-basis-tools.js";

describe("lesson design basis Agent context", () => {
  it("joins the source blueprint, unit goal, and canonical chapter knowledge", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-context",
      title: "数学备课本",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(ownerId, "notebook-context", {
      textbookId: "textbook-math-bnu",
      title: "数学学期框架",
      term: "上学期",
      startDate: "2026-09-01",
      totalWeeks: 18,
      weeklyPeriods: 5,
      lessonDurationMinutes: 40,
      capacityRatio: 0.9,
      planningHorizonWeeks: 2,
      contextProfile: {},
    }, "context-framework");
    const withGoals = await repository.applyManualSemesterFrameworkPatch(ownerId, {
      frameworkId: framework.framework.id,
      baseFrameworkVersion: framework.framework.version,
      summary: "补充单元目标",
      operations: [{
        op: "replace_unit_field",
        unitId: framework.units[0]!.id,
        field: "learningGoals",
        expectedValue: "",
        replacement: "能从真实数据中识别周期变化，并为后续三角函数建模建立直观基础。",
      }],
    }, "context-unit-goal");
    const planned = await repository.createLessonBlueprint(ownerId, framework.framework.id, {
      semesterUnitId: withGoals.units[0]!.id,
      curriculumNodeId: "ch1-1",
      title: "周期变化",
      mainActivity: "比较真实数据中的重复片段",
      observableProduct: "周期证据表",
      assessmentEvidence: "能指出重复单位和周期长度",
      anticipatedDifficulties: [],
      teacherNotes: "",
    }, "context-blueprint");
    const blueprint = planned.blueprints[0]!;
    const file = await repository.createLessonFile(ownerId, {
      notebookId: "notebook-context",
      title: blueprint.title,
      type: "课时蓝图教案",
      document: {
        unit: "第一章",
        period: "第 1 课时",
        totalPeriods: "共 5 课时",
        topic: blueprint.title,
        objectives: "",
        knowledgePoints: "",
        continuity: "",
        focus: "",
        preparation: "",
        process: "",
        assessment: "",
        homework: "",
        board: "",
        reflection: "",
      },
      contextProfile: {
        textbookId: framework.framework.textbookId,
        lessonNodeId: blueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: blueprint.id,
      pageCount: 1,
    }, "context-file");
    const readTool = createLessonDesignBasisTools(repository, false)[0]!;

    const result = JSON.parse(String(await readTool.invoke({
      context: {
        resourceType: "lesson_file",
        userId: ownerId,
        lessonFileId: file.id,
      },
    } as never, JSON.stringify({}))));

    expect(result.sourceState).toBe("current");
    expect(result.sourcePlanningContext.unit.learningGoals).toContain("三角函数建模");
    expect(result.sourcePlanningContext.blueprint).toMatchObject({
      title: "周期变化",
      observableProduct: "周期证据表",
    });
    expect(result.mappedKnowledgePoints).toContainEqual(expect.objectContaining({
      name: "周期变化",
    }));
    expect(result.missingEvidence.knowledgePoints).toBe(false);
  });
});
