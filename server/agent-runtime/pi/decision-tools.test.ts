import { describe, expect, it, vi } from "vitest";

import { applyTaskIntent } from "../../conversation/task-intent.js";
import { deterministicCapabilityPlan } from "../../agent/capability-router.js";
import type { LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { createPiDecisionTools } from "./decision-tools.js";

const lessonFileId = "lesson-1";
const context = {
  resourceType: "lesson_file",
  userId: "teacher-1",
  notebookId: "notebook-1",
  lessonFileId,
  threadId: "thread-1",
  branchId: "branch-1",
  runId: "run-1",
  activeSectionId: "process",
  documentVersion: 3,
  designBasisVersion: 0,
  contextProfile: {},
  allowedKnowledgeScopes: [],
  attachmentSourceIds: [],
  abortSignal: new AbortController().signal,
} satisfies LessonAgentContext;

function repository() {
  return {
    getLessonFileContext: vi.fn(async () => ({
      id: lessonFileId, ownerId: "teacher-1", notebookId: "notebook-1", documentVersion: 3, contextProfile: {},
    })),
    getRun: vi.fn(async () => ({ id: "run-1", ownerId: "teacher-1", threadId: "thread-1", branchId: "branch-1", status: "running" })),
    getThread: vi.fn(async () => ({ id: "thread-1", ownerId: "teacher-1", resourceType: "lesson_file", lessonFileId })),
    getBranch: vi.fn(async () => ({ id: "branch-1", ownerId: "teacher-1", threadId: "thread-1" })),
    listDecisions: vi.fn(async () => []),
    listDecisionEvidenceCards: vi.fn(async () => []),
    getDecisionCommandResult: vi.fn(async () => null),
    replayDecisionCommand: vi.fn(async () => null),
    saveDecision: vi.fn(async (record) => record),
  } as unknown as LessonRepository;
}

const evidenceCard = {
  kind: "curriculum_standard",
  level: "primary",
  source: {
    system: "curriculum_standards", uri: "d1://curriculum_standards/1",
    locator: "第三学段·阅读与鉴赏·第3条", version: "2022", capturedAt: "2026-10-18T00:00:00Z",
  },
  excerpt: "体会其表达效果。",
  claim: "目标应指向解释与表达效果。",
  supports: ["opt_b"],
  applicability: "第三学段阅读教学。",
  limitations: ["课标不规定具体活动。"],
  conflictsWith: [],
  confidence: 0.95,
  expiresAt: null,
  piiLevel: "none",
};

const proposal = {
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
};

function toolsFor(plan = applyTaskIntent(deterministicCapabilityPlan("请帮我准备这节课的教学决策。"), { type: "decision_proposal" })) {
  const target = repository();
  return { repository: target, ...createPiDecisionTools(target, context, plan) };
}

describe("decision agent tools", () => {
  it("reads existing decisions before proposing", async () => {
    const { tools } = toolsFor();
    const readTool = tools.find((tool) => tool.name === "read_decision_context")!;
    const proposalTool = tools.find((tool) => tool.name === "propose_decision")!;
    await expect(proposalTool.execute("call-1", proposal)).rejects.toThrow("read_decision_context_required");
    await readTool.execute("call-2", {});
    const result = await proposalTool.execute("call-3", proposal);
    const content = result.content[0];
    expect(content.type).toBe("text");
    if (content.type === "text") expect(content.text).toContain("decision_proposed");
  });

  it("captures exactly one agent proposal and never confirms it", async () => {
    const { tools, getDecisionProposal } = toolsFor();
    const readTool = tools.find((tool) => tool.name === "read_decision_context")!;
    const proposalTool = tools.find((tool) => tool.name === "propose_decision")!;
    await readTool.execute("call-1", {});
    await proposalTool.execute("call-2", proposal);
    expect(getDecisionProposal()?.status).toBe("proposed");
    expect(getDecisionProposal()?.provenance.createdBy).toBe("agent");
    expect(getDecisionProposal()?.provenance.confirmedBy).toBeNull();
    await expect(proposalTool.execute("call-3", proposal)).rejects.toThrow("multiple_write_proposals_not_allowed");
    await expect(proposalTool.execute("call-4", { ...proposal, status: "teacher_confirmed" }))
      .rejects.toThrow();
  });

  it("keeps the proposal tool out of ordinary teaching surfaces", () => {
    const { tools } = toolsFor(deterministicCapabilityPlan("请调整这一处。"));
    expect(tools.map((tool) => tool.name)).toEqual(["read_decision_context"]);
  });
});
