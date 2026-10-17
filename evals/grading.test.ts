import { describe, expect, it } from "vitest";
import {
  exposesInternalImplementationDetails,
  finalizeBusinessGrade,
  unavailableBusinessGrade,
} from "./grading.js";

const rubric = {
  criteria: ["对应教案原文", "避免伪精确结论"],
  minimumScore: 0.75,
  requireDocumentGrounding: true,
  rejectGeneric: true,
  rejectUnsupportedPrecision: true,
};

describe("business eval gate", () => {
  it("rejects tool names, schema fields, internal codes and UUIDs in teacher-facing replies", () => {
    expect(exposesInternalImplementationDetails(
      "propose_lesson_design_change 失败，请检查 relatedSemanticEntityId 和 invalid_projection",
    )).toBe(true);
    expect(exposesInternalImplementationDetails(
      "本课聚焦春日图景的辨认与概括，并让学生用‘对象+特点’概括画面。",
    )).toBe(false);
  });

  it("makes exposed implementation details a hard business failure", () => {
    const result = finalizeBusinessGrade({
      core: {
        lessonContextUnderstanding: { score: 2, evidence: "对应当前课题" },
        curriculumContextUnderstanding: { score: 2, evidence: "使用当前教材" },
        teacherGoalAlignment: { score: 2, evidence: "完成教师请求" },
        classroomActionability: { score: 2, evidence: "活动可执行" },
        evidenceDiscipline: { score: 2, evidence: "依据边界清楚" },
      },
      criteria: [
        { index: 0, score: 2, evidence: "对应教案原文" },
        { index: 1, score: 2, evidence: "没有伪精确判断" },
      ],
      generic: false,
      unsupportedPrecision: false,
      documentGrounded: true,
      curriculumGrounded: true,
      exposesInternalImplementation: true,
      summary: "业务内容有效，但暴露了内部实现。",
    }, rubric);

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("internal_implementation_exposed");
  });
  it("keeps infrastructure failure distinct from a low-quality business answer", () => {
    const result = unavailableBusinessGrade(rubric, "402 Insufficient Balance");

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["grader_unavailable"]);
    expect(result.summary).toContain("402 Insufficient Balance");
  });

  it("fails a generic answer even when every execution contract could pass", () => {
    const result = finalizeBusinessGrade({
      core: {
        lessonContextUnderstanding: { score: 0, evidence: "没有对应当前教案" },
        curriculumContextUnderstanding: { score: 0, evidence: "没有使用教材" },
        teacherGoalAlignment: { score: 1, evidence: "回应了审查请求" },
        classroomActionability: { score: 0, evidence: "没有课堂动作" },
        evidenceDiscipline: { score: 1, evidence: "没有伪造来源" },
      },
      criteria: [
        { index: 0, score: 1, evidence: "只提到目标" },
        { index: 1, score: 2, evidence: "没有时间估计" },
      ],
      generic: true,
      unsupportedPrecision: false,
      documentGrounded: false,
      curriculumGrounded: false,
      summary: "内容可替换到多数教案。",
      exposesInternalImplementation: false,
    }, rubric);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "generic_response",
      "document_not_grounded",
      "core_failed:lesson_context",
      "core_failed:classroom_actionability",
    ]));
  });

  it("fails unsupported precision and any zero-scored critical criterion", () => {
    const result = finalizeBusinessGrade({
      core: {
        lessonContextUnderstanding: { score: 2, evidence: "引用了当前教学过程" },
        curriculumContextUnderstanding: { score: 1, evidence: "未要求教材核验" },
        teacherGoalAlignment: { score: 2, evidence: "完成了教师请求" },
        classroomActionability: { score: 2, evidence: "给出具体活动" },
        evidenceDiscipline: { score: 0, evidence: "把估算说成确定事实" },
      },
      criteria: [
        { index: 0, score: 2, evidence: "引用了教学过程" },
        { index: 1, score: 0, evidence: "无条件断言至少需要十分钟" },
      ],
      generic: false,
      unsupportedPrecision: true,
      documentGrounded: true,
      curriculumGrounded: false,
      summary: "存在伪精确判断。",
      exposesInternalImplementation: false,
    }, rubric);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "rubric_failed:1",
      "unsupported_precision",
      "core_failed:evidence_discipline",
    ]));
  });

  it("requires current curriculum grounding when the business case depends on it", () => {
    const result = finalizeBusinessGrade({
      core: {
        lessonContextUnderstanding: { score: 2, evidence: "对应当前课题" },
        curriculumContextUnderstanding: { score: 0, evidence: "没有读取当前章节知识点" },
        teacherGoalAlignment: { score: 2, evidence: "回应教师目标" },
        classroomActionability: { score: 2, evidence: "活动可直接实施" },
        evidenceDiscipline: { score: 2, evidence: "区分了建议与事实" },
      },
      criteria: [
        { index: 0, score: 2, evidence: "对应教案原文" },
        { index: 1, score: 2, evidence: "没有伪精确判断" },
      ],
      generic: false,
      unsupportedPrecision: false,
      documentGrounded: true,
      curriculumGrounded: false,
      summary: "课堂建议具体，但缺少当前教材依据。",
      exposesInternalImplementation: false,
    }, { ...rubric, requireCurriculumGrounding: true });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "core_failed:curriculum_context",
      "curriculum_not_grounded",
    ]));
  });
});
