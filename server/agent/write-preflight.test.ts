import { describe, expect, it } from "vitest";

import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import {
  createDocumentPatchPreflight,
  createSemesterFrameworkPatchPreflight,
  isCommittedApprovalReplay,
  toolCallIdOf,
} from "./write-preflight.js";

describe("semester framework write preflight", () => {
  it("rejects a chapter lesson that is lazily bound to the unit root", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-preflight",
      title: "数学备课本",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(ownerId, "notebook-preflight", {
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
    }, "preflight-framework");
    const unit = framework.units[0]!;
    const guardrail = createSemesterFrameworkPatchPreflight(repository);
    const result = await guardrail.run({
      context: {
        context: {
          resourceType: "semester_framework",
          userId: ownerId,
          notebookId: framework.framework.notebookId,
          semesterFrameworkId: framework.framework.id,
          frameworkVersion: framework.framework.version,
        },
      },
      toolCall: {
        arguments: JSON.stringify({
          summary: "规划章节课时",
          operations: [{
            op: "create_lesson_blueprint",
            semesterUnitId: unit.id,
            curriculumNodeId: unit.curriculumNodeId,
            chapterPeriodNo: 1,
            title: "周期变化",
            mainActivity: "比较两组周期数据",
            observableProduct: "周期证据表",
            assessmentEvidence: "能指出重复单位与周期长度",
            anticipatedDifficulties: [],
            plannedMinutes: 40,
            teacherNotes: "",
          }],
        }),
      },
    } as never);

    expect(JSON.stringify(result)).toContain("blueprint_specific_curriculum_node_required");
  });

  it("rejects a complete unit plan that collapses two recommended periods into one blueprint", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-periods",
      title: "数学备课本",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(ownerId, "notebook-periods", {
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
    }, "period-framework");
    const originalRead = repository.readCurriculumNodesKnowledgePoints.bind(repository);
    repository.readCurriculumNodesKnowledgePoints = async (args) => {
      const records = await originalRead(args);
      if (records["ch1-1"]) records["ch1-1"]!.periodRecommendations = [
        ...records["ch1-1"]!.periodRecommendations,
        { id: "period-2", periodNo: 2, title: "第2课时", mappingType: "教研建议", isOfficial: false, note: "", pointIds: [] },
      ];
      return records;
    };
    const unit = framework.units[0]!;
    const result = await createSemesterFrameworkPatchPreflight(repository).run({
      context: { context: {
        resourceType: "semester_framework",
        userId: ownerId,
        notebookId: framework.framework.notebookId,
        semesterFrameworkId: framework.framework.id,
        frameworkVersion: framework.framework.version,
      } },
      toolCall: { arguments: JSON.stringify({
        summary: "完整规划第一单元",
        operations: [{
          op: "plan_semester_unit",
          unitId: unit.id,
          plannedStartWeek: 1,
          plannedEndWeek: 2,
          learningGoals: "能识别并解释周期变化",
          blueprints: [{
            curriculumNodeId: "ch1-1",
            chapterPeriodNo: 1,
            title: "周期变化",
            mainActivity: "比较周期数据",
            observableProduct: "周期证据表",
            assessmentEvidence: "能解释重复单位",
            anticipatedDifficulties: [],
            plannedMinutes: 40,
            teacherNotes: "",
          }],
        }],
      }) },
    } as never);

    expect(JSON.stringify(result)).toContain("blueprint_period_recommendation_mismatch");
  });
});

describe("committed approval replay preflight", () => {
  it("reads call ids from either callId or id", () => {
    expect(toolCallIdOf({ callId: "call-a" })).toBe("call-a");
    expect(toolCallIdOf({ id: "call-b" })).toBe("call-b");
    expect(isCommittedApprovalReplay(
      { approvedToolReplayCallId: "call-b" } as never,
      { id: "call-b" },
    )).toBe(true);
  });

  it("allows the post-approval propose replay without revalidating the old snapshot", async () => {
    const repository = new MemoryLessonRepository();
    const ownerId = "00000000-0000-4000-8000-000000000001";
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-replay",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-replay",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: {
          unit: "",
          period: "",
          totalPeriods: "",
          topic: "",
          objectives: "可观察目标",
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
      }],
    }]);
    // Simulate the post-write snapshot: version advanced and old expectedText
    // no longer matches. Replay must still allow via the committed call id.
    await repository.saveLessonDocument({
      ownerId,
      fileId: "file-replay",
      document: {
        unit: "",
        period: "",
        totalPeriods: "",
        topic: "",
        objectives: "可观察目标",
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
      pageCount: 1,
      baseVersion: 0,
      idempotencyKey: "replay-save",
    });
    const guardrail = createDocumentPatchPreflight(repository);
    const result = await guardrail.run({
      context: {
        context: {
          resourceType: "lesson_file",
          userId: ownerId,
          notebookId: "notebook-replay",
          lessonFileId: "file-replay",
          // Stale relative to the committed write; replay token is the gate.
          documentVersion: 0,
          approvedToolReplayCallId: "propose-replay",
        },
      },
      toolCall: {
        callId: "propose-replay",
        arguments: JSON.stringify({
          summary: "让目标可观察",
          operations: [{
            field: "objectives",
            expectedText: "目标",
            replacement: "可观察目标",
          }],
        }),
      },
    } as never);

    expect(result).toMatchObject({ behavior: { type: "allow" } });
  });
});
