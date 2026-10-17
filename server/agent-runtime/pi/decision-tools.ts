import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import type { CapabilityPlan, LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { proposeDecisionSchema } from "../../decisions/commands.js";
import type { DecisionRecord } from "../../decisions/contracts.js";
import { DecisionService } from "../../decisions/service.js";
import { typeBoxFromZod } from "./schema-adapter.js";

const text = (value: unknown, terminate = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null, terminate,
});

/** Decisions are teacher-owned; the agent only reads context and proposes candidates. */
export function createPiDecisionTools(repository: LessonRepository, context: LessonAgentContext, plan: CapabilityPlan) {
  const service = new DecisionService(repository);
  const scope = { ownerId: context.userId, lessonFileId: context.lessonFileId };
  const origin = { runId: context.runId, threadId: context.threadId, branchId: context.branchId };
  let decisionContextRead = false;
  let proposal: DecisionRecord | null = null;
  const tools: AgentTool<any>[] = [{
    name: "read_decision_context", label: "读取教学决策与证据",
    description: "读取当前课时已有的教学决策、相关证据卡和版本；提出新决策前必须先读取。证据必须来自工具结果或教师提供，区分观察、推断与不确定性，不得编造课标条款、学生表现或效果。",
    parameters: Type.Object({
      decisionId: Type.Optional(Type.String({ format: "uuid" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_callId, input) => {
      decisionContextRead = true;
      const { decisionId, limit } = input as { decisionId?: string; limit?: number };
      if (decisionId) return text(await service.readContext(scope, decisionId));
      return text(await service.read(scope, { limit: limit ?? 10 }));
    },
  }];
  if (plan.taskIntent?.type === "decision_proposal") {
    tools.push({
      name: "propose_decision", label: "准备教学决策候选",
      description: "基于当前教案、课标/教材原文、学习证据与课堂反馈，提交可检查的教学决策候选：明确问题、至少两个选项（保留现稿除外）、可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件。仅保存候选，不替教师确认、实施或审议；证据不足时提交 status=insufficient_evidence。",
      parameters: typeBoxFromZod(proposeDecisionSchema.omit({
        contextVersion: true, createdBy: true, sourceRunId: true,
      })),
      executionMode: "sequential",
      execute: async (callId, input) => {
        if (!decisionContextRead) throw new Error("read_decision_context_required");
        if (proposal) throw new Error("multiple_write_proposals_not_allowed");
        proposal = await service.propose(scope, {
          ...(input as Record<string, unknown>),
          contextVersion: { documentVersion: context.documentVersion, frameworkVersion: null },
          createdBy: "agent",
          sourceRunId: context.runId,
        }, `agent:${context.runId}:${callId}`, origin);
        return text({
          status: "decision_proposed",
          decisionId: proposal.id,
          decisionType: proposal.decisionType,
          question: proposal.question,
          confidence: proposal.confidence,
        }, true);
      },
    });
  }
  return { tools, getDecisionProposal: () => proposal };
}
