import { describe, expect, it, vi } from "vitest";
import type { AgentTaskIntent, CapabilityPlan, LessonAgentContext, LessonField } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { createPiDocumentProposalTool } from "../agent-runtime/pi/proposal-tools.js";
import { applyTaskIntent } from "./task-intent.js";

const decisionRef = { id: "60e0f92b-d5d0-4163-911f-ac0626985fcb", version: 2, chosenOptionId: "explain" };
const contaminatedPlan = (): CapabilityPlan => ({
  skillIds: [], toolGroups: ["document-read", "document-write"],
  mcpServers: ["knowledge"], evidenceRequired: true,
  requiredEvidenceKinds: ["curriculum_standard_search"], minimalWriteRequested: true,
  writeMode: "consultative", executionLane: "agent", curriculumRequested: false,
  requestedDocumentFields: ["assessment"],
});
const handoff = (fields?: LessonField[]): AgentTaskIntent => ({ type: "document_write", decisionRef, ...(fields ? { fields } : {}) });
const context: LessonAgentContext = {
  resourceType: "lesson_file", userId: "teacher", notebookId: "notebook", lessonFileId: "lesson",
  threadId: "thread", branchId: "branch", runId: "run", activeSectionId: "process", documentVersion: 4,
  designBasisVersion: 0, contextProfile: {}, allowedKnowledgeScopes: [], attachmentSourceIds: [], abortSignal: new AbortController().signal,
  confirmedDecision: { ...decisionRef, question: "如何同步解释任务与评分判据？", chosenOption: {
    id: "explain", statement: "同步过程评分和出口条的解释判据", tradeoffs: ["需核对评分时间"],
  }, assumptions: ["保留解释目标"] },
};
function proposalTool(plan: CapabilityPlan, documentVersion = 4) {
  const document = { unit: "第一单元", period: "2", totalPeriods: "2", topic: "解释表达效果", objectives: "用证据解释效果",
    knowledgePoints: "证据与解释", continuity: "先识别后解释", focus: "具体解释", preparation: "解释卡",
    process: "独立解释后交流，尚未明确评分记录", assessment: "出口条只记录识别是否正确",
    homework: "解释新语句", board: "证据→联系→效果", reflection: "尚未实施" };
  const getLessonFile = vi.fn(async () => ({ id: "lesson", documentVersion, document }));
  const listRunEvidence = vi.fn(async () => []);
  const repository = { getLessonFile, listRunEvidence } as unknown as LessonRepository;
  return { ...createPiDocumentProposalTool({ repository, context, plan }), getLessonFile, listRunEvidence, document };
}
const coherentRevision = {
  readingEmphasis: { kind: "not_needed", reason: "本次同步评分判据，短句已能清楚表达。" },
  summary: "同步过程评分和出口条的解释判据",
  operations: [
    { field: "process", replacement: "独立解释后按具体证据与效果联系记录，交流后再修订。" },
    { field: "assessment", replacement: "出口条分别记录识别与解释；解释须指出具体证据如何支持效果。" },
  ],
};

describe("structured confirmed-decision task intent", () => {
  it("removes inferred external-source and one-operation gates without mutating the routed plan", () => {
    const routed = contaminatedPlan();
    const original = structuredClone(routed);
    const intent = handoff();
    const result = applyTaskIntent(routed, intent);
    expect(result).toMatchObject({ taskIntent: intent, writeMode: "explicit", executionLane: "agent",
      evidenceRequired: false, mcpServers: [], minimalWriteRequested: false });
    expect(result.requiredEvidenceKinds).toBeUndefined();
    expect(result.requestedDocumentFields).toBeUndefined();
    expect(routed).toEqual(original);
  });

  it("retains explicit field scope and the exact decision id/version/option reference", () => {
    const intent = handoff(["process", "assessment"]);
    const result = applyTaskIntent(contaminatedPlan(), intent);
    expect(result.taskIntent).toEqual(intent);
    expect(result.requestedDocumentFields).toEqual(["process", "assessment"]);
  });

  it("allows a coherent two-field revision but captures only a version-bound proposal awaiting approval", async () => {
    const plan = applyTaskIntent(contaminatedPlan(), handoff(["process", "assessment"]));
    const { tool, getProposal, document, listRunEvidence } = proposalTool(plan);
    const result = await tool.execute("proposal", coherentRevision);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"status":"approval_required"') });
    const proposal = getProposal();
    expect(proposal).toMatchObject({ resourceType: "lesson_file", patchKind: "document", lessonFileId: "lesson", baseResourceVersion: 4 });
    expect(proposal?.patch).toMatchObject({ baseDocumentVersion: 4, operations: [
      { field: "process", expectedText: document.process, replacement: coherentRevision.operations[0].replacement },
      { field: "assessment", expectedText: document.assessment, replacement: coherentRevision.operations[1].replacement },
    ] });
    expect(document.process).toBe("独立解释后交流，尚未明确评分记录");
    expect(listRunEvidence).not.toHaveBeenCalled();
  });

  it("still rejects a write outside the explicit fields", async () => {
    const { tool, getProposal } = proposalTool(applyTaskIntent(contaminatedPlan(), handoff(["assessment"])));
    await expect(tool.execute("out-of-scope", coherentRevision)).rejects.toMatchObject({ code: "document_field_scope_exceeded" });
    expect(getProposal()).toBeNull();
  });

  it("still rejects a proposal when the canonical document version changed", async () => {
    const { tool, getProposal } = proposalTool(applyTaskIntent(contaminatedPlan(), handoff()), 5);
    await expect(tool.execute("stale", coherentRevision)).rejects.toThrow("document_context_stale");
    expect(getProposal()).toBeNull();
  });

  it("retains source requirements and the minimal-operation rule for document writes without a decision reference", async () => {
    const result = applyTaskIntent(contaminatedPlan(), { type: "document_write", fields: ["assessment"] });
    expect(result).toMatchObject({ evidenceRequired: true, mcpServers: ["knowledge"],
      requiredEvidenceKinds: ["curriculum_standard_search"], minimalWriteRequested: true, requestedDocumentFields: ["assessment"] });
    const { tool, getProposal, listRunEvidence } = proposalTool(result);
    await expect(tool.execute("missing-source", { ...coherentRevision, operations: [coherentRevision.operations[1]] }))
      .rejects.toThrow("evidence_required");
    expect(listRunEvidence).toHaveBeenCalledWith("teacher", "run");
    expect(getProposal()).toBeNull();
    const unscoped = proposalTool(applyTaskIntent(contaminatedPlan(), { type: "document_write" }));
    await expect(unscoped.tool.execute("too-many", coherentRevision)).rejects.toThrow("too_many_document_operations");
  });

  it("does not change the evidence requirements or consultative authority of decision proposals", async () => {
    const result = applyTaskIntent(contaminatedPlan(), { type: "decision_proposal" });
    expect(result).toMatchObject({ taskIntent: { type: "decision_proposal" }, writeMode: "consultative", curriculumRequested: true,
      evidenceRequired: true, requiredEvidenceKinds: ["curriculum_standard_search"], mcpServers: ["knowledge"], minimalWriteRequested: true });
    expect(result.requestedDocumentFields).toBeUndefined();
    const { tool, getProposal } = proposalTool(result);
    await expect(tool.execute("unauthorized-write", coherentRevision)).rejects.toThrow("document_write_not_requested");
    expect(getProposal()).toBeNull();
  });

  it("leaves routing untouched when no structured action was supplied", () => {
    const routed = contaminatedPlan();
    expect(applyTaskIntent(routed)).toBe(routed);
  });
});
