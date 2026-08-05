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
    expect(framework.framework.catalogReleaseId).toBe(created.framework.catalogReleaseId);
    expect(framework.units).toContainEqual(expect.objectContaining({
      curriculumNodeId: "ch1",
      curriculumNodeTitle: "第一章 三角函数",
    }));
    expect(framework.blueprints[0]).toMatchObject({
      title: "周期变化",
      plannedMinutes: 40,
      knowledgePoints: [expect.objectContaining({ name: "周期变化" })],
      periodRecommendations: [expect.objectContaining({ periodNo: 1 })],
    });

    const unit = JSON.parse(String(await tools[1]!.invoke(
      runContext,
      JSON.stringify({ unitId: withBlueprint.units[0]!.id }),
    )));
    expect(unit.unit.curriculumNodeTitle).toBe("第一章 三角函数");
    expect(unit.frameworkVersion).toBe(1);
    expect(unit.blueprints[0].knowledgePoints[0].name).toBe("周期变化");
    expect(unit.curriculumLessons).toContainEqual(expect.objectContaining({
      nodeId: "ch1-1",
      periodRecommendations: [expect.objectContaining({ periodNo: 1 })],
    }));

    const continuity = JSON.parse(String(await tools[3]!.invoke(
      runContext,
      JSON.stringify({}),
    )));
    expect(continuity).toMatchObject({
      "结论": expect.any(String),
      "候选安排": [],
    });
    expect(continuity["取舍边界"]).toContain("候选不是必须安排");
  });

  it("rejects a lesson-file context", async () => {
    const tool = createSemesterFrameworkTools(new MemoryLessonRepository())[0]!;
    const result = await tool.invoke(
      { context: { userId: "user", lessonFileId: "file" } } as never,
      JSON.stringify({}),
    );
    expect(String(result)).toContain("semester_framework_context_required");
  });
});
