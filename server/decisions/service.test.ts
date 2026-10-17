import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { DecisionService } from "./service.js";
import type { LearningEvidence } from "../learning/domain.js";

const ownerId = "owner-1";
const notebookId = "notebook-1";
const lessonFileId = "lesson-1";

const plan = {
  unit: "语文课程单元",
  period: "第 1 课时",
  totalPeriods: "2 课时",
  topic: "春日的第一声鸟鸣",
  objectives: "理解反复的表达效果。",
  knowledgePoints: "反复",
  continuity: "",
  focus: "理解反复与情感的关系。",
  preparation: "课文与学习任务单。",
  process: "一、导入\n二、探究\n三、迁移",
  assessment: "出口条：解释一处反复。",
  homework: "朗读并标注。",
  board: "反复 → 强调 → 情感",
  reflection: "",
};

async function setup() {
  const repository = new MemoryLessonRepository();
  await repository.importNotebookGraph(ownerId, [{
    id: notebookId,
    title: "语文备课本",
    className: "五年级 2 班",
    year: "2025—2026 学年",
    subject: "语文",
    files: [{
      id: lessonFileId,
      title: "春日的第一声鸟鸣",
      type: "阅读课",
      pages: 1,
      documentVersion: 0,
      lessonPlan: plan,
    }],
  }]);
  const service = new DecisionService(repository, () => "2026-10-18T01:30:00Z");
  return { repository, service };
}

const evidenceCard = {
  kind: "curriculum_standard" as const,
  level: "primary" as const,
  source: {
    system: "curriculum_standards",
    uri: "d1://curriculum_standards/1",
    locator: "第三学段·阅读与鉴赏·第3条",
    version: "2022",
    capturedAt: "2026-10-18T00:00:00Z",
  },
  excerpt: "体会其表达效果。",
  claim: "目标应指向解释与表达效果。",
  supports: ["opt_b"],
  applicability: "第三学段阅读教学。",
  limitations: ["课标不规定具体活动。"],
  confidence: 0.95,
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    contextVersion: { documentVersion: 0, frameworkVersion: null },
    decisionType: "goal_evidence",
    question: "本课的达成证据是什么？",
    options: [
      { id: "opt_a", statement: "出口条复述", tradeoffs: ["易评分", "不能区分理解"] },
      { id: "opt_b", statement: "无提示新段落解释", tradeoffs: ["更接近迁移", "评分成本高"] },
    ],
    chosenOptionId: "opt_b",
    rationale: "目标指向理解。",
    counterevidence: ["上次只能复述。"],
    assumptions: ["学生已能找出重复词句。"],
    uncertainties: ["新段落难度可能增加负担。"],
    confidence: 0.72,
    expectedSignal: "独立解释比例上升。",
    falsifier: "若比例未上升，则决策不成立。",
    reviewAt: null,
    evidenceCards: [evidenceCard],
    status: "proposed",
    createdBy: "teacher",
    ...overrides,
  };
}

describe("DecisionService", () => {
  it("proposes and reads a teacher decision with locatable evidence", async () => {
    const { service } = await setup();
    const decision = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-1");
    expect(decision.status).toBe("proposed");
    expect(decision.version).toBe(1);
    expect(decision.evidenceCardIds).toHaveLength(1);

    const read = await service.read({ ownerId, lessonFileId }, { limit: 20 });
    expect(read.decisions).toHaveLength(1);
    expect(read.evidenceCards).toHaveLength(1);
    expect(read.evidenceCards[0].source.locator).toContain("第三学段");

    const context = await service.readContext({ ownerId, lessonFileId }, decision.id);
    expect(context.decision.id).toBe(decision.id);
    expect(context.versions).toHaveLength(1);
    expect(context.diff).toBeNull();
  });

  it("replays the same proposal idempotently", async () => {
    const { service } = await setup();
    const first = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-2");
    const second = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-2");
    expect(second.id).toBe(first.id);
    const read = await service.read({ ownerId, lessonFileId }, { limit: 20 });
    expect(read.decisions).toHaveLength(1);
  });

  it("rejects an unlocatable standard citation before writing", async () => {
    const { service } = await setup();
    const input = proposal({ evidenceCards: [{ ...evidenceCard, source: { ...evidenceCard.source, locator: null } }] });
    await expect(service.propose({ ownerId, lessonFileId }, input, "propose-3"))
      .rejects.toThrow("decision_invalid:evidence.locator_required");
  });

  it("requires an agent origin for agent-authored proposals", async () => {
    const { service } = await setup();
    await expect(service.propose({ ownerId, lessonFileId }, proposal({ createdBy: "agent" }), "propose-4"))
      .rejects.toThrow("decision_agent_origin_required");
  });

  it("confirms, implements and reviews with real learning evidence", async () => {
    const { repository, service } = await setup();
    const decision = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-5");
    const confirmed = await service.act({ ownerId, lessonFileId }, decision.id, {
      action: "confirm", expectedVersion: 1, chosenOptionId: "opt_b", confidence: 0.8,
    }, "confirm-1");
    expect(confirmed.status).toBe("teacher_confirmed");
    expect(confirmed.provenance.confirmedBy).toBe(ownerId);
    expect(confirmed.version).toBe(2);
    const context = await service.readContext({ ownerId, lessonFileId }, decision.id);
    expect(context.diff?.statusFrom).toBe("proposed");
    expect(context.diff?.statusTo).toBe("teacher_confirmed");
    expect(context.diff?.changed).toContain("status");

    const implemented = await service.act({ ownerId, lessonFileId }, decision.id, {
      action: "implement", expectedVersion: 2, implementedAt: "2026-10-18T01:00:00Z", note: "第二课时使用",
    }, "implement-1");
    expect(implemented.status).toBe("implemented");
    expect(implemented.implementation?.documentVersion).toBe(0);

    const evidence: LearningEvidence = {
      id: randomUUID(), ownerId, notebookId, lessonFileId, documentVersion: 0,
      objective: "解释反复", task: "新段落解释", criterion: "说出强调与情感",
      learnerGroup: "全班", observation: "18/30 能独立解释", method: "student_work",
      observedAt: "2026-10-18T01:15:00Z", sourceReference: "出口条", createdAt: "2026-10-18T01:15:00Z",
    };
    await repository.saveLearningEvidence(evidence, {
      idempotencyKey: "evidence-1", fingerprint: "fingerprint", documentVersion: 0,
    });

    const reviewed = await service.act({ ownerId, lessonFileId }, decision.id, {
      action: "review", expectedVersion: 3, outcome: "supported",
      rationale: "独立解释比例上升", limitations: "单班、无延迟复测",
      evidenceIds: [evidence.id],
    }, "review-1");
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.review?.outcome).toBe("supported");
    expect(reviewed.version).toBe(4);
  });

  it("refuses a stale version and an early review evidence", async () => {
    const { repository, service } = await setup();
    const decision = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-6");
    await service.act({ ownerId, lessonFileId }, decision.id, {
      action: "confirm", expectedVersion: 1, chosenOptionId: "opt_b",
    }, "confirm-2");
    await expect(service.act({ ownerId, lessonFileId }, decision.id, {
      action: "confirm", expectedVersion: 1, chosenOptionId: "opt_b",
    }, "confirm-3")).rejects.toThrow("stale_decision");

    await service.act({ ownerId, lessonFileId }, decision.id, {
      action: "implement", expectedVersion: 2, implementedAt: "2026-10-18T01:00:00Z", note: "",
    }, "implement-2");
    const early: LearningEvidence = {
      id: randomUUID(), ownerId, notebookId, lessonFileId, documentVersion: 0,
      objective: "解释反复", task: "新段落解释", criterion: "说出情感",
      learnerGroup: "全班", observation: "12/30", method: "teacher_observation",
      observedAt: "2026-10-18T00:30:00Z", sourceReference: "课堂观察", createdAt: "2026-10-18T00:30:00Z",
    };
    await repository.saveLearningEvidence(early, {
      idempotencyKey: "evidence-2", fingerprint: "fingerprint", documentVersion: 0,
    });
    await expect(service.act({ ownerId, lessonFileId }, decision.id, {
      action: "review", expectedVersion: 3, outcome: "supported",
      rationale: "不成立", limitations: "单次观察", evidenceIds: [early.id],
    }, "review-2")).rejects.toThrow("decision_review_evidence_before_implementation");
  });

  it("records rejection and no-change without pretending to know the effect", async () => {
    const { service } = await setup();
    const rejected = await service.propose({ ownerId, lessonFileId }, proposal(), "propose-7");
    const rejection = await service.act({ ownerId, lessonFileId }, rejected.id, {
      action: "reject", expectedVersion: 1, reasonCode: "student_mismatch", rationale: "与本班学情不符。",
    }, "reject-1");
    expect(rejection.status).toBe("teacher_rejected");
    expect(rejection.rejection?.reasonCode).toBe("student_mismatch");

    const noChange = await service.propose({ ownerId, lessonFileId }, proposal({
      decisionType: "no_change", options: [], chosenOptionId: null, status: "proposed",
    }), "propose-8");
    const kept = await service.act({ ownerId, lessonFileId }, noChange.id, {
      action: "no_change", expectedVersion: 1, rationale: "现有设计已足够，保留。", confidence: 0.7,
    }, "no-change-1");
    expect(kept.status).toBe("no_change");
    expect(kept.chosenOptionId).toBeNull();
  });

  it("keeps decisions scoped to the owning lesson", async () => {
    const { service } = await setup();
    await expect(service.read({ ownerId: "other-owner", lessonFileId }, { limit: 20 }))
      .rejects.toThrow("lesson_file_not_found");
  });
});
