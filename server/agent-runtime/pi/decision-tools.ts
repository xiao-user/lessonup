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
  const lessonUri = `lessonup://lesson-files/${scope.lessonFileId}`;
  const lessonSourceAlias = "lessonup://lesson-files/current";
  const observationSources = new Map<string, { uri: string; version: string; capturedAt: string }>();
  const observationExcerpts = new Map<string, string[]>();
  let lessonExcerpts: string[] = [];
  const exactExcerpt = (excerpt: string, originals: string[]) => excerpt.trim().length > 0
    && originals.some((original) => original.replace(/\s+/g, "").includes(excerpt.replace(/\s+/g, "")));
  let capturedAt = "";
  let proposal: DecisionRecord | null = null;
  const tools: AgentTool<any>[] = [{
    name: "read_decision_context", label: "读取教学决策与证据",
    description: "读取当前课时已有的教学决策、相关证据卡和版本；提出新决策前必须先读取。证据必须来自工具结果或教师提供，区分观察、推断与不确定性，不得编造课标条款、学生表现或效果。",
    parameters: Type.Object({
      decisionId: Type.Optional(Type.String({ format: "uuid" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_callId, input) => {
      const { decisionId, limit } = input as { decisionId?: string; limit?: number };
      const decisionContext = decisionId
        ? await service.readContext(scope, decisionId)
        : await service.read(scope, { limit: limit ?? 10 });
      const [evidence, file] = await Promise.all([
        repository.listLearningEvidence(scope.ownerId, scope.lessonFileId, 21),
        repository.getLessonFile(scope.ownerId, scope.lessonFileId),
      ]);
      if (!file) throw new Error("lesson_file_not_found");
      lessonExcerpts = Object.values(file.document);
      capturedAt = new Date().toISOString();
      const visibleEvidence = evidence.slice(0, 20).map((item) => {
        const uri = `lessonup://learning-evidence/${item.id}`;
        const existing = [...observationSources.entries()].find(([, source]) => source.uri === uri)?.[0];
        const sourceUri = existing ?? `lessonup://learning-evidence/observation-${observationSources.size + 1}`;
        observationSources.set(sourceUri, { uri, version: String(item.documentVersion), capturedAt });
        observationExcerpts.set(uri, [item.observation, item.objective, item.task, item.criterion, item.sourceReference]
          .filter((value) => typeof value === "string"));
        return { ...item, sourceUri };
      });
      decisionContextRead = true;
      return text({
        ...decisionContext,
        learning: {
          evidence: visibleEvidence,
          truncated: evidence.length > 20,
          instruction: "这些是教师记录的观察，不自动代表真实课堂或因果效果；必须保留来源中的合成标注。更多记录使用 read_learning_progress 分页读取。",
        },
        lessonSource: { uri: lessonSourceAlias, version: String(context.documentVersion) },
        capturedAt,
      });
    },
  }];
  if (plan.taskIntent?.type === "decision_proposal") {
    tools.push({
      name: "propose_decision", label: "准备教学决策候选",
      description: "基于当前教案、课标/教材原文、学习证据与课堂反馈，提交可检查的教学决策候选：明确问题、至少两个选项（保留现稿除外）、可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件。仅保存候选，不替教师确认、实施或审议；证据不足时提交 status=insufficient_evidence。",
      parameters: typeBoxFromZod(proposeDecisionSchema.omit({
        contextVersion: true, createdBy: true, sourceRunId: true,
      }), "input"),
      executionMode: "sequential",
      execute: async (callId, input) => {
        if (!decisionContextRead) throw new Error("read_decision_context_required");
        if (proposal) throw new Error("multiple_write_proposals_not_allowed");
        const candidate = proposeDecisionSchema.parse({
          ...(input as Record<string, unknown>),
          contextVersion: { documentVersion: context.documentVersion, frameworkVersion: null },
          createdBy: "agent",
          sourceRunId: context.runId,
        });
        if (candidate.chosenOptionId === "null" && !candidate.options.some((option) => option.id === "null")) {
          candidate.chosenOptionId = null;
        }
        if (candidate.chosenOptionId !== null && !candidate.options.some((option) => option.id === candidate.chosenOptionId)) {
          throw new Error(`decision_chosen_option_invalid:chosenOptionId must be JSON null or exactly one of ${JSON.stringify(candidate.options.map((option) => option.id))}; received ${JSON.stringify(candidate.chosenOptionId)}`);
        }
        candidate.evidenceCards = candidate.evidenceCards.map((card) => {
          const uri = card.source.uri;
          const observation = observationSources.get(uri)
            ?? [...observationSources.values()].find((source) => source.uri === uri);
          if (uri === lessonSourceAlias || uri === lessonUri) {
            if (["curriculum_standard", "textbook", "student_work", "classroom_observation"].includes(card.kind)) {
              throw new Error("decision_evidence_kind_mismatch:the current lesson is a lesson document, not curriculum standards, a textbook, or observed student work; classify the actual source rather than the claim");
            }
            if (!exactExcerpt(card.excerpt, lessonExcerpts)) {
              throw new Error("decision_evidence_excerpt_not_exact:copy an exact contiguous excerpt from one lesson field; split combined excerpts into separate evidence cards and keep interpretations in claim");
            }
            return { ...card, source: { ...card.source, uri: lessonUri, version: String(context.documentVersion), capturedAt } };
          }
          if (observation) {
            if (!exactExcerpt(card.excerpt, observationExcerpts.get(observation.uri) ?? [])) {
              throw new Error("decision_evidence_excerpt_not_exact:copy an exact contiguous excerpt from the observed record; keep interpretations in claim");
            }
            return { ...card, source: { ...card.source, ...observation } };
          }
          if (uri.startsWith("lessonup://")) {
            throw new Error(`decision_evidence_source_unknown:copy exactly one observed source URI from ${JSON.stringify([lessonSourceAlias, ...observationSources.keys()])}; put field/page selectors in source.locator, not in the URI`);
          }
          return card;
        });
        proposal = await service.propose(scope, candidate, `agent:${context.runId}:${callId}`, origin);
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
