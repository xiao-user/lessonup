import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CapabilityPlan, LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { LearningService } from "../../learning/service.js";
import { learningInquiryInputSchema, learningReviewSchema, type LearningInquiry } from "../../learning/domain.js";
import { typeBoxFromZod } from "./schema-adapter.js";

const text = (value: unknown, terminate = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null, terminate,
});

export function createPiLearningTools(repository: LessonRepository, context: LessonAgentContext, plan: CapabilityPlan) {
  const service = new LearningService(repository);
  const scope = { ownerId: context.userId, lessonFileId: context.lessonFileId };
  const origin = { runId: context.runId, threadId: context.threadId, branchId: context.branchId };
  let proposal: LearningInquiry | null = null;
  let selectedEvidenceRead = false;
  const tools: AgentTool<any>[] = [{
    name: "read_learning_progress", label: "读取学习证据与改进记录",
    description: "分页读取当前课时学习证据、改进方案与复测结果；selected 返回本次操作指定的原始证据、方案，以及当前规范教案的课题、目标、过程和评价，超出分页窗口也会精确返回。复用这些内容，缺少其他栏目时才补读；区分观察与推断，未实施不得声称有效。",
    parameters: Type.Object({
      evidenceBefore: Type.Optional(Type.Object({ at: Type.String({ format: "date-time" }), id: Type.String({ format: "uuid" }) })),
      inquiriesBefore: Type.Optional(Type.Object({ at: Type.String({ format: "date-time" }), id: Type.String({ format: "uuid" }) })),
    }, { additionalProperties: false }),
    execute: async (_callId, input) => {
      const task = plan.taskIntent;
      const focus = task?.type === "learning_inquiry" ? { evidenceId: task.evidenceId }
        : task?.type === "learning_review" ? { evidenceId: task.evidenceId, inquiryId: task.inquiryId } : null;
      const [progress, selected] = await Promise.all([service.read(scope, input), focus ? service.readContext(scope, focus) : null]);
      if (selected) selectedEvidenceRead = true;
      return text({ ...progress, selected });
    },
  }, {
    name: "propose_learning_inquiry", label: "准备学习改进方案",
    description: "基于教师已记录的基线证据提出一个可检验假设、替代解释、教学调整、预期信号和复测办法。仅保存待采用方案，不记录实施或学习效果。需要教师从学习验证入口发起。",
    parameters: typeBoxFromZod(learningInquiryInputSchema.omit({ documentVersion: true, baselineEvidenceId: true })),
    executionMode: "sequential",
    execute: async (callId, input) => {
      if (plan.taskIntent?.type !== "learning_inquiry") throw new Error("learning_proposal_not_requested");
      if (!selectedEvidenceRead) throw new Error("read_learning_progress_required");
      if (proposal) throw new Error("multiple_write_proposals_not_allowed");
      proposal = await service.propose(scope, { ...(input as Record<string, unknown>), documentVersion: context.documentVersion,
        baselineEvidenceId: plan.taskIntent.evidenceId }, `agent:${context.runId}:${callId}`, origin);
      return text({ status: "proposed", inquiryId: proposal.id, summary: proposal.intervention }, true);
    },
  }, {
    name: "propose_learning_review", label: "准备复测审议建议",
    description: "核对真实后测证据后建议符合预期、未见预期或证据不足，说明限制。最终复测决定仍由教师确认；不能把前后变化直接当作因果证明。",
    parameters: typeBoxFromZod(learningReviewSchema.omit({ evidenceId: true })),
    executionMode: "sequential",
    execute: async (callId, input) => {
      if (plan.taskIntent?.type !== "learning_review") throw new Error("learning_proposal_not_requested");
      if (!selectedEvidenceRead) throw new Error("read_learning_progress_required");
      if (proposal) throw new Error("multiple_write_proposals_not_allowed");
      proposal = await service.act(scope, plan.taskIntent.inquiryId, { action: "propose_review",
        expectedVersion: plan.taskIntent.expectedVersion, review: { ...(input as Record<string, unknown>), evidenceId: plan.taskIntent.evidenceId } },
      `agent:${context.runId}:${callId}`, origin);
      return text({ status: "review_proposed", inquiryId: proposal.id, review: proposal.proposedReview }, true);
    },
  }];
  return { tools, getLearningProposal: () => proposal };
}
