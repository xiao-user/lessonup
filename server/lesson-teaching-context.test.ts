import { describe, expect, it, vi } from "vitest";
import { lessonFieldSchema, lessonPlanSchema } from "./domain.js";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";
import { readLessonTeachingContext } from "./lesson-teaching-context.js";
import { LearningService } from "./learning/service.js";

async function fixture() {
  const repository = new MemoryLessonRepository();
  const ownerId = "teacher";
  const notebook = await repository.createNotebook(ownerId, {
    title: "数学", className: "一班", subject: "数学", year: "2026", tone: "teal",
  });
  let framework = await repository.createSemesterFramework(ownerId, notebook.id, {
    textbookId: "textbook-math-bnu", title: "数学教学框架", term: "上学期",
    totalWeeks: 18, weeklyPeriods: 5, lessonDurationMinutes: 40, capacityRatio: 0.9,
    planningHorizonWeeks: 2, contextProfile: {},
  }, "framework");
  const unit = framework.units[0]!;
  for (let period = 1; period <= 5; period += 1) {
    framework = await repository.createLessonBlueprint(ownerId, framework.framework.id, {
      semesterUnitId: unit.id, curriculumNodeId: unit.curriculumNodeId, title: `第${period}课时`,
      mainActivity: "用数轴解释有理数大小", observableProduct: "标点及解释", assessmentEvidence: "独立说明比较依据",
      anticipatedDifficulties: [], teacherNotes: "",
    }, `blueprint-${period}`);
  }
  const document = lessonPlanSchema.parse(Object.fromEntries(lessonFieldSchema.options.map((field) => [field, ""])));
  const files = await Promise.all(framework.blueprints.map((blueprint) => repository.createLessonFile(ownerId, {
    notebookId: notebook.id, title: blueprint.title, type: "教案", document, pageCount: 1,
    lessonBlueprintId: blueprint.id,
  })));
  for (const file of files) {
    await repository.createLessonClassFeedback(ownerId, {
      lessonFileId: file.id, semesterFrameworkId: framework.framework.id,
      kind: "observation", statement: `${file.title}的实际表现`,
    });
  }
  const scope = { ownerId, notebookId: notebook.id, lessonFileId: files[3]!.id };
  return { repository, scope, framework, files };
}

describe("canonical lesson teaching context", () => {
  it("carries finalized learning reviews into the next lesson without copying facts or future results", async () => {
    const { repository, scope, files } = await fixture();
    const service = new LearningService(repository);
    for (const file of [files[2]!, files[4]!]) {
      const lessonScope = { ownerId: scope.ownerId, lessonFileId: file.id };
      const evidence = { documentVersion: 0, objective: "用数轴解释大小", task: "独立标点并解释", criterion: "说明位置与大小的联系",
        learnerGroup: "一班", observation: "部分只能给结论", method: "assessment", observedAt: new Date(Date.now() - 60_000).toISOString(), sourceReference: "解释卡" };
      const baseline = await service.recordEvidence(lessonScope, evidence, `baseline-${file.id}`);
      const inquiry = await service.propose(lessonScope, { documentVersion: 0, baselineEvidenceId: baseline.id,
        hypothesis: "可能尚未建立位置关系", alternativeExplanation: "也可能受表达负担影响", intervention: "比较反例后独立解释",
        expectedSignal: "能独立解释位置关系", checkPlan: "用同一判据比较新任务并延迟检查" }, `inquiry-${file.id}`);
      await service.act(lessonScope, inquiry.id, { action: "adopt", expectedVersion: 0 }, `adopt-${file.id}`);
      await service.act(lessonScope, inquiry.id, { action: "implement", expectedVersion: 1 }, `implement-${file.id}`);
      const followup = await service.recordEvidence(lessonScope, { ...evidence, inquiryId: inquiry.id, observedAt: new Date().toISOString(), observation: `${file.title}能解释新任务` }, `followup-${file.id}`);
      await service.act(lessonScope, inquiry.id, { action: "review", expectedVersion: 2, review: { evidenceId: followup.id, outcome: "supported",
        rationale: "同一判据下出现独立解释", limitations: "任务熟悉度可能影响，不能证明因果效果" } }, `review-${file.id}`);
    }
    const result = await readLessonTeachingContext(repository, scope);
    const previous = result.classroomFeedback.previousLessons.find((item) => item.title === "第3课时")!;
    expect(previous.learningReviews.records).toHaveLength(1);
    expect(previous.learningReviews.records[0]).toMatchObject({ review: { outcome: "supported" }, followup: { observation: "第3课时能解释新任务" } });
    expect(JSON.stringify(result.classroomFeedback)).not.toContain("第5课时能解释新任务");
  });
  it("joins the current blueprint, nearest predecessors and their real feedback without future leakage", async () => {
    const { repository, scope, framework, files } = await fixture();
    const read = vi.spyOn(repository, "listLessonClassFeedback");
    const result = await readLessonTeachingContext(repository, scope);
    expect(result.planning).toMatchObject({ status: "available", stale: false,
      blueprint: { id: framework.blueprints[3]!.id }, nextLesson: { id: framework.blueprints[4]!.id } });
    expect(result.classroomFeedback.currentLesson.records.map((item) => item.lessonFileId)).toEqual([files[3]!.id]);
    expect(result.classroomFeedback.previousLessons.map((item) => item.title)).toEqual(["第1课时", "第2课时", "第3课时"]);
    expect(JSON.stringify(result.classroomFeedback)).not.toContain("第5课时的实际表现");
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every(([owner, filter]) => owner === scope.ownerId && filter.limit === 9)).toBe(true);
  });

  it("flags changed upstream versions and excludes cancelled predecessors", async () => {
    const { repository, scope, framework } = await fixture();
    const predecessor = framework.blueprints[1]!;
    await repository.updateLessonBlueprint(scope.ownerId, framework.framework.id, predecessor.id, {
      expectedVersion: predecessor.version, status: "cancelled",
    }, "cancel-predecessor");
    const result = await readLessonTeachingContext(repository, scope);
    expect(result.planning).toMatchObject({ status: "available", stale: true });
    expect(result.classroomFeedback.previousLessons.map((item) => item.title)).toEqual(["第1课时", "第3课时"]);
  });

  it("bounds feedback and marks truncation instead of inventing an overall outcome", async () => {
    const { repository, scope } = await fixture();
    for (let index = 0; index < 12; index += 1) await repository.createLessonClassFeedback(scope.ownerId, {
      lessonFileId: scope.lessonFileId, kind: "practice_gap", statement: `新观察${index}`,
    });
    const result = await readLessonTeachingContext(repository, scope);
    expect(result.classroomFeedback.currentLesson.truncated).toBe(true);
    expect(result.classroomFeedback.currentLesson.records).toHaveLength(8);
    expect(result.classroomFeedback.currentLesson.records[0]!.statement).toBe("新观察11");
  });

  it("derives provenance from the feedback kind rather than trusting a supplied evidence label", async () => {
    const { repository, scope } = await fixture();
    await repository.createLessonClassFeedback(scope.ownerId, {
      lessonFileId: scope.lessonFileId, kind: "error_cause", statement: "可能尚未理解比较依据",
      evidence: { informationLevel: "verified_curriculum_fact" },
    });
    const result = await readLessonTeachingContext(repository, scope);
    expect(result.classroomFeedback.currentLesson.records[0]!.provenance.level).toBe("teacher_inference");
  });

  it("rejects a different owner or notebook before reading classroom feedback", async () => {
    const { repository, scope } = await fixture();
    const read = vi.spyOn(repository, "listLessonClassFeedback");
    for (const invalid of [{ ...scope, ownerId: "other" }, { ...scope, notebookId: "other" }]) {
      await expect(readLessonTeachingContext(repository, invalid)).rejects.toThrow("lesson_design_basis_not_found");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("does not follow a planning binding into another notebook", async () => {
    const { repository, scope } = await fixture();
    const get = repository.getSemesterFramework.bind(repository);
    vi.spyOn(repository, "getSemesterFramework").mockImplementation(async (...args) => {
      const value = (await get(...args))!;
      return { ...value, framework: { ...value.framework, notebookId: "another-notebook" } };
    });
    const result = await readLessonTeachingContext(repository, scope);
    expect(result.planning.status).toBe("unavailable");
    expect(result.classroomFeedback.previousLessons).toEqual([]);
  });
});
