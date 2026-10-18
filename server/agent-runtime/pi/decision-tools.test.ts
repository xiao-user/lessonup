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
  const listLearningEvidence = vi.fn(async () => []);
  return {
    getLessonFileContext: vi.fn(async () => ({
      id: lessonFileId, ownerId: "teacher-1", notebookId: "notebook-1", documentVersion: 3, contextProfile: {},
    })),
    getLessonFile: vi.fn(async () => ({
      id: lessonFileId, ownerId: "teacher-1", notebookId: "notebook-1", documentVersion: 3,
      document: { objectives: "体会其表达效果。", assessment: "出口条只要求找出反复。" },
    })),
    getRun: vi.fn(async () => ({ id: "run-1", ownerId: "teacher-1", threadId: "thread-1", branchId: "branch-1", status: "running" })),
    getThread: vi.fn(async () => ({ id: "thread-1", ownerId: "teacher-1", resourceType: "lesson_file", lessonFileId })),
    getBranch: vi.fn(async () => ({ id: "branch-1", ownerId: "teacher-1", threadId: "thread-1" })),
    listDecisions: vi.fn(async () => []),
    listDecisionEvidenceCards: vi.fn(async () => []),
    listLearningEvidence,
    getLearningEvidence: vi.fn(async (_ownerId, id) => {
      for (const result of [...listLearningEvidence.mock.results].reverse()) {
        const rows = await result.value as Array<Record<string, unknown>>;
        const evidence = rows.find((item) => item.id === id);
        if (evidence) return { objective: "解释表达效果", task: "独立解释", criterion: "指出联系", learnerGroup: "本班",
          lessonFileId, ownerId: "teacher-1", ...evidence };
      }
      return null;
    }),
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
  question: "出口条是否检验了目标要求的表达效果解释？",
  options: [
    { id: "opt_a", statement: "出口条只保留识别，并将目标限定为识别", tradeoffs: ["易评分", "需要同步收窄教学目标"] },
    { id: "opt_b", statement: "出口条增加表达效果解释及独立评分判据", tradeoffs: ["评价与现有解释目标对齐", "评分成本高"] },
  ],
  chosenOptionId: "opt_b",
  rationale: "目标要求体会表达效果，当前出口条只要求识别。",
  counterevidence: ["五分钟内完成解释的时间容量尚未验证。"],
  assumptions: ["教师保留体会表达效果这一目标。"],
  uncertainties: ["解释任务的表述和评分成本尚需教师核对。"],
  confidence: 0.72,
  expectedSignal: "修订后出口条明确要求解释，并有对应判据；这只验证设计对齐。",
  falsifier: "若教师核实原有独立任务已要求解释且有对应判据，则该设计缺口判断不成立。",
  observationPlan: {
    kind: "design_check", objective: "核对目标与评价的解释要求是否一致。",
    task: "并列核对教案目标、出口条任务和评分判据。", criterion: "出口条要求解释表达效果，并对解释而非仅识别设独立判据。",
    learnerGroup: "本课教案，不采集学生表现", method: "document_check",
    conditions: "核对同一版本教案，设计对齐不证明真实学生达成。", baselineEvidenceId: null,
  },
  reviewAt: null,
  evidenceCards: [evidenceCard],
  status: "proposed",
};

function toolsFor(plan = applyTaskIntent(deterministicCapabilityPlan("请帮我准备这节课的教学决策。"), { type: "decision_proposal" })) {
  const target = repository();
  return { repository: target, ...createPiDecisionTools(target, context, plan) };
}

describe("decision agent tools", () => {
  it("exposes input defaults as optional while keeping evidence facts required", () => {
    const { tools } = toolsFor();
    const schema = JSON.parse(JSON.stringify(tools[1]!.parameters));
    expect(schema.required).not.toContain("evidenceCards");
    expect(schema.required).not.toContain("chosenOptionId");
    expect(schema.required).not.toContain("confidence");
    expect(schema.properties.evidenceCards.items.required).not.toContain("supports");
    expect(schema.properties.evidenceCards.items.required).not.toContain("confidence");
    expect(schema.properties.evidenceCards.items.properties.confidence.anyOf).toContainEqual({ type: "null" });
    expect(schema.properties).not.toHaveProperty("lessonEvidence");
    expect(schema.properties.evidenceCards.items.properties.source.required).toEqual(["uri", "locator"]);
  });
  it.each([undefined, null])("stores an omitted or null evidence confidence without inventing a probability (%s)", async (confidence) => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{ ...evidenceCard, confidence }] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].confidence).toBeNull();
  });

  it("resolves the current-lesson alias to server-owned metadata", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{
      ...evidenceCard, kind: "assessment_item", source: { ...evidenceCard.source, uri: "lessonup://lesson-files/current", version: "invented" },
    }] });
    const cards = vi.mocked(repository.saveDecision).mock.calls[0][3];
    expect(cards[0].source).toMatchObject({ uri: "lessonup://lesson-files/lesson-1", version: "3" });
    expect(cards[0].source.capturedAt).not.toBe(evidenceCard.source.capturedAt);
  });

  it("hydrates omitted local metadata before strict business parsing", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{
      ...evidenceCard, kind: "assessment_item",
      source: { uri: "lessonup://lesson-files/current", locator: "objectives" },
    }] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].source).toMatchObject({
      system: "lessonup", uri: "lessonup://lesson-files/lesson-1", version: "3", locator: "objectives",
    });
  });

  it("does not trust model-supplied metadata for a bound local source", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{
      ...evidenceCard, kind: "assessment_item",
      source: { ...evidenceCard.source, uri: "lessonup://lesson-files/current", system: "curriculum_standards", capturedAt: "not-a-timestamp" },
    }] });
    const source = vi.mocked(repository.saveDecision).mock.calls[0][3][0].source;
    expect(source.system).toBe("lessonup");
    expect(Number.isFinite(Date.parse(source.capturedAt))).toBe(true);
  });

  it("keeps full provenance mandatory for external sources", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await expect(tools[1]!.execute("missing-external", { ...proposal, evidenceCards: [{
      ...evidenceCard, source: { uri: evidenceCard.source.uri, locator: evidenceCard.source.locator },
    }] })).rejects.toThrow();
    await expect(tools[1]!.execute("invalid-external", { ...proposal, evidenceCards: [{
      ...evidenceCard, source: { ...evidenceCard.source, capturedAt: "not-a-timestamp" },
    }] })).rejects.toThrow();
    expect(repository.saveDecision).not.toHaveBeenCalled();
    await tools[1]!.execute("valid-external", proposal);
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].source).toEqual(evidenceCard.source);
  });

  it("proposes an actionable candidate with a complete observation plan and null confidence", async () => {
    const { tools, getDecisionProposal } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, confidence: null });
    expect(getDecisionProposal()).toMatchObject({
      status: "proposed", confidence: null, observationPlan: { kind: "design_check", method: "document_check" },
      provenance: { confirmedBy: null },
    });
  });

  it("reports all missing actionable judgment fields before saving", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await expect(tools[1]!.execute("incomplete", {
      ...proposal, confidence: null, counterevidence: [], assumptions: [], uncertainties: [], expectedSignal: "", falsifier: "", observationPlan: null,
    })).rejects.toThrow("counterevidence, assumptions, uncertainties, expectedSignal, falsifier, observationPlan");
    expect(repository.saveDecision).not.toHaveBeenCalled();
    await tools[1]!.execute("complete", proposal);
    expect(repository.saveDecision).toHaveBeenCalledOnce();
  });

  it("normalizes the model's literal null only to an unchosen candidate", async () => {
    const { tools, getDecisionProposal } = toolsFor();
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, chosenOptionId: "null", status: "insufficient_evidence" });
    expect(getDecisionProposal()?.chosenOptionId).toBeNull();
    expect(getDecisionProposal()?.provenance.confirmedBy).toBeNull();
  });

  it("rejects document evidence misclassified as standards or stitched from separate fields", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    const source = { ...evidenceCard.source, uri: "lessonup://lesson-files/current" };
    await expect(tools[1]!.execute("wrong-kind", { ...proposal, evidenceCards: [{ ...evidenceCard, source }] }))
      .rejects.toThrow("decision_evidence_kind_mismatch");
    await expect(tools[1]!.execute("stitched-quote", { ...proposal, evidenceCards: [{
      ...evidenceCard, kind: "assessment_item", source, excerpt: "体会其表达效果。……出口条只要求找出反复。",
    }] })).rejects.toThrow("decision_evidence_excerpt_not_exact");
    expect(repository.saveDecision).not.toHaveBeenCalled();
  });

  it("returns exact option ids on a recoverable choice error", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await expect(tools[1]!.execute("bad", { ...proposal, chosenOptionId: "option B" }))
      .rejects.toThrow('["opt_a","opt_b"]');
    expect(repository.saveDecision).not.toHaveBeenCalled();
    await tools[1]!.execute("corrected", proposal);
    expect(repository.saveDecision).toHaveBeenCalledOnce();
  });

  it("refuses an unobserved in-app source instead of accepting a mistyped id", async () => {
    const { tools, repository } = toolsFor();
    await tools[0]!.execute("read", {});
    await expect(tools[1]!.execute("propose", { ...proposal, evidenceCards: [{
      ...evidenceCard, source: { ...evidenceCard.source, uri: "lessonup://lesson-files/wrong-lesson" },
    }] })).rejects.toThrow("decision_evidence_source_unknown");
    expect(repository.saveDecision).not.toHaveBeenCalled();
  });
  it("does not unlock proposals after a failed context read", async () => {
    const { repository, tools } = toolsFor();
    vi.mocked(repository.listDecisions).mockRejectedValueOnce(new Error("scope_denied"));
    const read = tools.find((tool) => tool.name === "read_decision_context")!;
    const propose = tools.find((tool) => tool.name === "propose_decision")!;
    await expect(read.execute("read", {})).rejects.toThrow("scope_denied");
    await expect(propose.execute("propose", proposal)).rejects.toThrow("read_decision_context_required");
  });

  it("includes bounded learning observations without dropping their source labels", async () => {
    const { repository, tools } = toolsFor();
    vi.mocked(repository.listLearningEvidence).mockResolvedValueOnce([
      { id: "synthetic-observation", documentVersion: 3, observation: "合成评测，不代表真实学生", sourceReference: "合成样本" } as never,
    ]);
    const result = await tools[0]!.execute("read", {});
    const content = result.content[0];
    if (content.type !== "text") throw new Error("expected_text");
    const context = JSON.parse(content.text);
    expect(context.learning.evidence[0].sourceReference).toBe("合成样本");
    expect(context.learning.truncated).toBe(false);
    expect(context.lessonSource).toMatchObject({ uri: "lessonup://lesson-files/current", kind: "platform_data" });
    expect(context.learning.evidence[0].sourceUri).toBe("lessonup://learning-evidence/observation-1");
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{
      ...evidenceCard, kind: "student_work", level: "synthetic", excerpt: "合成评测，不代表真实学生",
      source: { ...evidenceCard.source, uri: context.learning.evidence[0].sourceUri, version: "invented" },
    }] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].source).toMatchObject({
      uri: "lessonup://learning-evidence/synthetic-observation", version: "3",
    });
    expect(repository.listLearningEvidence).toHaveBeenCalledWith("teacher-1", lessonFileId, 21, undefined);
  });

  it.each([
    { synthetic: true, observation: "30份演示回答中9份满足判据。", sourceReference: "QA fixture" },
    { synthetic: false, observation: "【合成验收】30份演示回答中9份满足判据。", sourceReference: "验收演示材料" },
  ])("does not relabel declared synthetic observation as primary (%j)", async (observation) => {
    const { repository, tools } = toolsFor();
    vi.mocked(repository.listLearningEvidence).mockResolvedValueOnce([
      { id: "synthetic-observation", documentVersion: 3, ...observation } as never,
    ]);
    await tools[0]!.execute("read", {});
    const card = { ...evidenceCard, kind: "student_work", level: "primary", excerpt: observation.observation,
      source: { uri: "lessonup://learning-evidence/observation-1", locator: "observation" } };
    await expect(tools[1]!.execute("mislabelled", { ...proposal, evidenceCards: [card] })).rejects.toThrow(/synthetic/);
    expect(repository.saveDecision).not.toHaveBeenCalled();
    await tools[1]!.execute("corrected", { ...proposal, evidenceCards: [{ ...card, level: "synthetic" }] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0]).toMatchObject({
      level: "synthetic", excerpt: observation.observation,
      source: { uri: "lessonup://learning-evidence/synthetic-observation" },
    });
  });

  it("does not mistake a chemistry synthesis topic for a synthetic-data declaration", async () => {
    const { repository, tools } = toolsFor();
    const observation = "学生在合成反应实验中记录了温度变化，并用数据解释反应现象。";
    vi.mocked(repository.listLearningEvidence).mockResolvedValueOnce([
      { id: "chemistry-observation", documentVersion: 3, synthetic: false, observation,
        sourceReference: "本班化学实验报告的匿名汇总" } as never,
    ]);
    await tools[0]!.execute("read", {});
    await tools[1]!.execute("propose", { ...proposal, evidenceCards: [{ ...evidenceCard, kind: "student_work", level: "primary", excerpt: observation,
      source: { uri: "lessonup://learning-evidence/observation-1", locator: "observation" } }] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].level).toBe("primary");
  });

  it("registers older observations through decision pagination without trusting lookahead rows", async () => {
    const { repository, tools } = toolsFor();
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: crypto.randomUUID(), documentVersion: 3,
      observedAt: new Date(Date.UTC(2026, 9, 18, 0, 0, 30 - index)).toISOString(),
      observation: `第 ${index + 1} 次独立解释观察`, objective: "解释效果", task: "独立解释", criterion: "指出联系", sourceReference: "匿名作答汇总",
    }));
    vi.mocked(repository.listLearningEvidence).mockResolvedValueOnce(rows as never);
    const first = await tools[0]!.execute("page-1", {});
    if (first.content[0].type !== "text") throw new Error("expected_text");
    const page = JSON.parse(first.content[0].text);
    expect(page.learning.evidence).toHaveLength(20);
    expect(page.learning.next).toEqual({ at: rows[19].observedAt, id: rows[19].id });
    const oldCard = { ...evidenceCard, kind: "student_work", excerpt: rows[20].observation,
      source: { uri: `lessonup://learning-evidence/${rows[20].id}`, locator: "observation" } };
    await expect(tools[1]!.execute("unread-lookahead", { ...proposal, evidenceCards: [oldCard] }))
      .rejects.toThrow("decision_evidence_source_unknown");
    vi.mocked(repository.listLearningEvidence).mockResolvedValueOnce([rows[20]] as never);
    const second = await tools[0]!.execute("page-2", { evidenceBefore: page.learning.next });
    expect(repository.listLearningEvidence).toHaveBeenLastCalledWith("teacher-1", lessonFileId, 21, page.learning.next);
    if (second.content[0].type !== "text") throw new Error("expected_text");
    const older = JSON.parse(second.content[0].text);
    expect(older.learning.next).toBeNull();
    expect(older.learning.evidence[0].sourceUri).toBe("lessonup://learning-evidence/observation-21");
    await tools[1]!.execute("read-old-source", { ...proposal, evidenceCards: [oldCard] });
    expect(vi.mocked(repository.saveDecision).mock.calls[0][3][0].source).toMatchObject({
      system: "lessonup", uri: oldCard.source.uri, version: "3",
    });
  });
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
