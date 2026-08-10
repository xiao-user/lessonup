import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createSemesterFrameworkTools } from "./semester-tools.js";

describe("semester framework Agent tools", () => {
  it("reads only the framework bound to the run context", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "n1",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const created = await repository.createSemesterFramework(ownerId, "n1", {
      textbookId: "textbook-math-bnu",
      title: "七年级上学期教学框架",
      term: "上学期",
      startDate: "2026-09-01",
      totalWeeks: 18,
      weeklyPeriods: 5,
      lessonDurationMinutes: 40,
      capacityRatio: 0.9,
      planningHorizonWeeks: 2,
      contextProfile: {},
    }, "create-framework-1");
    const withBlueprint = await repository.createLessonBlueprint(ownerId, created.framework.id, {
      semesterUnitId: created.units[0]!.id,
      curriculumNodeId: "ch1-1",
      title: "周期变化",
      mainActivity: "比较生活中的周期现象并归纳重复规律",
      observableProduct: "周期现象证据表",
      assessmentEvidence: "能用证据说明变化按什么规律重复",
      anticipatedDifficulties: [],
      teacherNotes: "",
    }, "create-blueprint-1");
    const tools = createSemesterFrameworkTools(repository);
    const runContext = {
      context: {
        resourceType: "semester_framework",
        userId: ownerId,
        notebookId: "n1",
        semesterFrameworkId: created.framework.id,
      },
    } as never;

    const framework = JSON.parse(String(await tools[0]!.invoke(
      runContext,
      JSON.stringify({}),
    )));
    expect(framework.framework.toolRef.catalogReleaseId).toBe(created.framework.catalogReleaseId);
    expect(framework.units).toContainEqual(expect.objectContaining({
      toolRef: expect.objectContaining({ curriculumNodeId: "ch1" }),
      教材单元: "第一章 三角函数",
    }));
    expect(framework.blueprints[0]).toMatchObject({
      toolRef: expect.objectContaining({
        blueprintId: withBlueprint.blueprints[0]!.id,
        chapterPeriodNo: 1,
      }),
      课时名称: "周期变化",
      章节课时: "第1课时",
      课堂分钟: 40,
      主要教学活动: "比较生活中的周期现象并归纳重复规律",
      知识点: [expect.objectContaining({ 名称: "周期变化" })],
      课时建议: [expect.objectContaining({ 第几课时: 1 })],
    });
    expect(framework.blueprints[0]).not.toHaveProperty("mainActivity");

    const unit = JSON.parse(String(await tools[1]!.invoke(
      runContext,
      JSON.stringify({ unitId: withBlueprint.units[0]!.id }),
    )));
    expect(unit.unit.教材单元).toBe("第一章 三角函数");
    expect(unit.框架版本).toBe(1);
    expect(unit.blueprints[0].知识点[0].名称).toBe("周期变化");
    expect(unit.curriculumLessons).toContainEqual(expect.objectContaining({
      toolRef: { nodeId: "ch1-1" },
      课时建议: [expect.objectContaining({ 第几课时: 1 })],
    }));

    const continuity = JSON.parse(String(await tools[3]!.invoke(
      runContext,
      JSON.stringify({}),
    )));
    expect(continuity).toMatchObject({
      "结论": expect.any(String),
      "候选安排": [],
    });
    expect(continuity["取舍边界"]).toContain("教师已采用的衔接优先落实");
  });

  it("rejects a lesson-file context", async () => {
    const tool = createSemesterFrameworkTools(new MemoryLessonRepository())[0]!;
    const result = await tool.invoke(
      { context: { userId: "user", lessonFileId: "file" } } as never,
      JSON.stringify({}),
    );
    expect(String(result)).toContain("semester_framework_context_required");
  });

  it("suggests the next same-unit blueprint for weak continuity outcomes", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "n1",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const created = await repository.createSemesterFramework(ownerId, "n1", {
      textbookId: "textbook-math-bnu",
      title: "七年级上学期教学框架",
      term: "上学期",
      startDate: "2026-09-01",
      totalWeeks: 18,
      weeklyPeriods: 5,
      lessonDurationMinutes: 40,
      capacityRatio: 0.9,
      planningHorizonWeeks: 2,
      contextProfile: {},
    }, "create-framework-writeback");
    const withFirst = await repository.createLessonBlueprint(ownerId, created.framework.id, {
      semesterUnitId: created.units[0]!.id,
      curriculumNodeId: "ch1-1",
      title: "周期变化",
      mainActivity: "比较生活中的周期现象",
      observableProduct: "周期现象证据表",
      assessmentEvidence: "能说明重复规律",
      anticipatedDifficulties: [],
      teacherNotes: "",
    }, "create-blueprint-writeback-1");
    const withSecond = await repository.createLessonBlueprint(ownerId, created.framework.id, {
      semesterUnitId: created.units[0]!.id,
      curriculumNodeId: "ch1-1",
      title: "周期建模",
      mainActivity: "建立简单周期模型",
      observableProduct: "模型说明",
      assessmentEvidence: "能解释参数含义",
      anticipatedDifficulties: [],
      teacherNotes: "",
      chapterPeriodNo: 2,
    }, "create-blueprint-writeback-2");
    const firstBlueprint = withFirst.blueprints[0]!;
    const secondBlueprint = withSecond.blueprints.find((item) => item.plannedPeriod === 2)!;
    const priorFile = await repository.createLessonFile(ownerId, {
      notebookId: "n1",
      title: firstBlueprint.title,
      type: "课时蓝图教案",
      document: {
        unit: "第一章",
        period: "第 1 课时",
        totalPeriods: "共 2 课时",
        topic: firstBlueprint.title,
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
        textbookId: created.framework.textbookId,
        lessonNodeId: firstBlueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: firstBlueprint.id,
      pageCount: 1,
    }, "writeback-prior-file");
    await repository.createLessonClassFeedback(ownerId, {
      lessonFileId: priorFile.id,
      kind: "continuity_outcome",
      statement: "复习重复单位时只有半数学生能独立完成",
      lessonBlueprintId: firstBlueprint.id,
      semesterFrameworkId: created.framework.id,
      continuityFingerprint: "fp-period-review",
      continuityDirection: "review",
      continuityOutcome: "weak",
    });

    const feedbackTool = createSemesterFrameworkTools(repository)
      .find((item) => item.name === "read_framework_class_feedback")!;
    const result = JSON.parse(String(await feedbackTool.invoke({
      context: {
        resourceType: "semester_framework",
        userId: ownerId,
        notebookId: "n1",
        semesterFrameworkId: created.framework.id,
      },
    } as never, JSON.stringify({}))));

    expect(result["待回写建议"]).toEqual([
      expect.objectContaining({
        "反馈编号": expect.any(String),
        "反馈说明": "复习重复单位时只有半数学生能独立完成",
        "衔接结果": "偏弱",
        "回写状态": "待确认",
        "建议修改的下一课时": expect.objectContaining({
          "课时名称": secondBlueprint.title,
          "单元第几课时": 2,
          toolRef: expect.objectContaining({
            blueprintId: secondBlueprint.id,
          }),
        }),
      }),
    ]);

    const feedbackId = result["待回写建议"][0]["反馈编号"] as string;
    await repository.markLessonClassFeedbackWriteback(ownerId, feedbackId, "applied");
    const afterApply = JSON.parse(String(await feedbackTool.invoke({
      context: {
        resourceType: "semester_framework",
        userId: ownerId,
        notebookId: "n1",
        semesterFrameworkId: created.framework.id,
      },
    } as never, JSON.stringify({}))));
    expect(afterApply["待回写建议"]).toEqual([]);
  });
});
