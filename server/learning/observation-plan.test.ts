import { describe, expect, it } from "vitest";
import { learningEvidenceInputSchema } from "./domain.js";
import { observationPlanSchema, observationsComparable } from "./observation-plan.js";

const plan = { kind: "design_check", objective: "核对目标与评价", task: "对照当前教案两栏", criterion: "出口条要求解释相似点与效果", learnerGroup: "当前课时教案", method: "document_check", conditions: "当前教案文本", baselineEvidenceId: null } as const;
const evidence = { documentVersion: 0, objective: plan.objective, task: plan.task, criterion: plan.criterion, learnerGroup: plan.learnerGroup,
  observation: "出口条已增加解释要求", method: plan.method, observedAt: "2026-10-18T09:30:00.000Z", sourceReference: "当前教案评价栏", conditions: plan.conditions };

describe("observation plan input boundaries", () => {
  it("separates document design checks from student learning measurements", () => {
    expect(observationPlanSchema.parse(plan).kind).toBe("design_check");
    expect(observationPlanSchema.safeParse({ ...plan, method: "student_work" }).success).toBe(false);
    expect(observationPlanSchema.safeParse({ ...plan, kind: "learning_change" }).success).toBe(false);
    expect(observationPlanSchema.parse({ ...plan, kind: "learning_change", method: "assessment" }).kind).toBe("learning_change");
    expect(learningEvidenceInputSchema.safeParse({ ...evidence, sampleSize: 30, meetingCriterion: 20 }).success).toBe(false);
  });

  it("requires explicit decision snapshot and synthetic declaration together, without mixing workflows", () => {
    const decisionId = "1e2264ad-cadf-4e88-8474-e56b3d2a3d0c";
    expect(learningEvidenceInputSchema.safeParse({ ...evidence, decisionId }).success).toBe(false);
    expect(learningEvidenceInputSchema.safeParse({ ...evidence, decisionId, decisionVersion: 3 }).success).toBe(false);
    expect(learningEvidenceInputSchema.safeParse({ ...evidence, decisionVersion: 3 }).success).toBe(false);
    const linked = { ...evidence, decisionId, decisionVersion: 3, synthetic: false };
    expect(learningEvidenceInputSchema.parse(linked)).toMatchObject({ decisionId, decisionVersion: 3, synthetic: false });
    expect(learningEvidenceInputSchema.safeParse({ ...linked, inquiryId: "a1701d70-fd15-4716-bcd6-4353af117680" }).success).toBe(false);
  });

  it("compares criterion, group, conditions and method while allowing equivalent-text normalization and alternate tasks", () => {
    expect(observationsComparable(plan, { ...plan, objective: `  ${plan.objective}\n`, criterion: ` ${plan.criterion} ` })).toBe(true);
    // Task wording can differ for an unseen transfer item; comparability is the declared objective, criterion, group, method and conditions.
    expect(observationsComparable({ ...plan, task: "任务甲" }, { ...plan, task: "任务乙" })).toBe(true);
    for (const key of ["objective", "criterion", "learnerGroup", "conditions", "method"] as const) {
      expect(observationsComparable(plan, { ...plan, [key]: "不同条件" })).toBe(false);
    }
    expect(observationsComparable(plan, { ...plan, conditions: undefined })).toBe(false);
  });
});
