import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createLessonDesignBasisTools } from "./design-basis-tools.js";
import { createDocumentTools } from "./tools.js";

async function seedFrameworkWithTwoPeriods(repository: MemoryLessonRepository, ownerId: string) {
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
  const firstPlanned = await repository.createLessonBlueprint(ownerId, framework.framework.id, {
    semesterUnitId: withGoals.units[0]!.id,
    curriculumNodeId: "ch1-1",
    title: "周期变化",
    mainActivity: "比较真实数据中的重复片段",
    observableProduct: "周期证据表",
    assessmentEvidence: "能指出重复单位和周期长度",
    anticipatedDifficulties: [],
    teacherNotes: "",
  }, "context-blueprint-1");
  const secondPlanned = await repository.createLessonBlueprint(ownerId, framework.framework.id, {
    semesterUnitId: withGoals.units[0]!.id,
    curriculumNodeId: "ch1-1",
    title: "周期建模",
    mainActivity: "用证据表建立周期模型",
    observableProduct: "简单周期模型说明",
    assessmentEvidence: "能用上一课证据解释模型参数",
    anticipatedDifficulties: [],
    teacherNotes: "",
    chapterPeriodNo: 2,
  }, "context-blueprint-2");
  return {
    frameworkId: framework.framework.id,
    unitId: withGoals.units[0]!.id,
    firstBlueprint: firstPlanned.blueprints[0]!,
    secondBlueprint: secondPlanned.blueprints.find((item) => item.plannedPeriod === 2)!,
  };
}

describe("lesson design basis Agent context", () => {
  it("joins the source blueprint, unit goal, and canonical chapter knowledge", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const seeded = await seedFrameworkWithTwoPeriods(repository, ownerId);
    const file = await repository.createLessonFile(ownerId, {
      notebookId: "notebook-context",
      title: seeded.firstBlueprint.title,
      type: "课时蓝图教案",
      document: {
        unit: "第一章",
        period: "第 1 课时",
        totalPeriods: "共 5 课时",
        topic: seeded.firstBlueprint.title,
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
        textbookId: "textbook-math-bnu",
        lessonNodeId: seeded.firstBlueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: seeded.firstBlueprint.id,
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
    expect(result.sourcePlanningContext["单元"]["单元目标"]).toContain("三角函数建模");
    expect(result.sourcePlanningContext["课时蓝图"]).toMatchObject({
      "课时名称": "周期变化",
      "学生可观察产出": "周期证据表",
    });
    expect(result.mappedKnowledgePoints).toContainEqual(expect.objectContaining({
      name: "周期变化",
    }));
    expect(result.missingEvidence.knowledgePoints).toBe(false);
  });

  it("exposes prior-period class feedback inside design-basis planning context", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const seeded = await seedFrameworkWithTwoPeriods(repository, ownerId);
    const priorFile = await repository.createLessonFile(ownerId, {
      notebookId: "notebook-context",
      title: seeded.firstBlueprint.title,
      type: "课时蓝图教案",
      document: {
        unit: "第一章",
        period: "第 1 课时",
        totalPeriods: "共 2 课时",
        topic: seeded.firstBlueprint.title,
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
        textbookId: "textbook-math-bnu",
        lessonNodeId: seeded.firstBlueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: seeded.firstBlueprint.id,
      pageCount: 1,
    }, "prior-file");
    await repository.createLessonClassFeedback(ownerId, {
      lessonFileId: priorFile.id,
      kind: "practice_gap",
      statement: "半数学生仍分不清重复单位和周期长度。",
      lessonBlueprintId: seeded.firstBlueprint.id,
      semesterFrameworkId: seeded.frameworkId,
    });
    const nextFile = await repository.createLessonFile(ownerId, {
      notebookId: "notebook-context",
      title: seeded.secondBlueprint.title,
      type: "课时蓝图教案",
      document: {
        unit: "第一章",
        period: "第 2 课时",
        totalPeriods: "共 2 课时",
        topic: seeded.secondBlueprint.title,
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
        textbookId: "textbook-math-bnu",
        lessonNodeId: seeded.secondBlueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: seeded.secondBlueprint.id,
      pageCount: 1,
    }, "next-file");
    const readBasis = createLessonDesignBasisTools(repository, false)[0]!;
    const readFeedback = createDocumentTools(repository, false)
      .find((tool) => tool.name === "read_lesson_class_feedback")!;

    const basisResult = JSON.parse(String(await readBasis.invoke({
      context: {
        resourceType: "lesson_file",
        userId: ownerId,
        lessonFileId: nextFile.id,
      },
    } as never, JSON.stringify({}))));
    const feedbackResult = JSON.parse(String(await readFeedback.invoke({
      context: {
        resourceType: "lesson_file",
        userId: ownerId,
        lessonFileId: nextFile.id,
      },
    } as never, JSON.stringify({}))));

    expect(basisResult.sourcePlanningContext["同单元前序课堂反馈"]).toEqual([
      expect.objectContaining({
        "类型": "练习缺口",
        "说明": "半数学生仍分不清重复单位和周期长度。",
        "所属": "同单元前序课时",
      }),
    ]);
    expect(feedbackResult["同单元前序记录"]).toEqual([
      expect.objectContaining({
        "类型": "练习缺口",
        "说明": "半数学生仍分不清重复单位和周期长度。",
      }),
    ]);
  });
});
