import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { z } from "zod";

import type { CapabilityPlan, LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { decisionEvidenceInputSchema, proposeDecisionSchema } from "../../decisions/commands.js";
import type { DecisionRecord } from "../../decisions/contracts.js";
import { DecisionService } from "../../decisions/service.js";
import { typeBoxFromZod } from "./schema-adapter.js";

const text = (value: unknown, terminate = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null, terminate,
});

const decisionToolInputSchema = proposeDecisionSchema.omit({
  contextVersion: true, createdBy: true, sourceRunId: true,
}).extend({
  evidenceCards: z.array(decisionEvidenceInputSchema.extend({
    kind: decisionEvidenceInputSchema.shape.kind.describe("Classify the source, not the claim. For lessonSource use its kind (platform_data), never curriculum_standard/textbook/student_work. For learning observations classify the actual observed source; synthetic observations remain level=synthetic."),
    source: decisionEvidenceInputSchema.shape.source.extend({
      system: z.string().max(100).optional(),
      version: z.string().max(100).optional(),
      capturedAt: z.string().max(200).optional(),
    }).describe("For lessonup:// sources, copy the read tool's URI and locator only; the server supplies system, version and capturedAt. External sources require all five fields with provenance from the read result. Each excerpt must quote one contiguous source field; put interpretation in claim."),
  })).max(8).default([]),
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
      evidenceBefore: Type.Optional(Type.Object({
        at: Type.String({ format: "date-time" }), id: Type.String({ format: "uuid" }),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    execute: async (_callId, input) => {
      const { decisionId, limit, evidenceBefore } = input as {
        decisionId?: string; limit?: number; evidenceBefore?: { at: string; id: string };
      };
      const decisionContext = decisionId
        ? await service.readContext(scope, decisionId)
        : await service.read(scope, { limit: limit ?? 10 });
      const [evidence, file] = await Promise.all([
        repository.listLearningEvidence(scope.ownerId, scope.lessonFileId, 21, evidenceBefore),
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
          next: evidence.length > 20 ? { at: visibleEvidence[19]!.observedAt, id: visibleEvidence[19]!.id } : null,
          instruction: "这些是教师记录的观察，不自动代表真实课堂或因果效果；必须保留来源中的合成标注。要引用更多观察，使用本工具并传 evidenceBefore=learning.next；每页都会发放可验证的 sourceUri。",
        },
        lessonSource: { uri: lessonSourceAlias, kind: "platform_data", version: String(context.documentVersion) },
        capturedAt,
      });
    },
  }];
  if (plan.taskIntent?.type === "decision_proposal") {
    tools.push({
      name: "propose_decision", label: "准备教学决策候选",
      description: "基于已读原文提交教学决策候选。除 no_change 外至少两个有取舍的选项；可行动的 proposed 必须有证据、反例、假设、不确定性、置信度、预期信号与证伪条件。只有 insufficient_evidence 等未形成行动判断的候选可省略行动字段，必须列明证据缺口。应用内来源用读取结果的 URI 和 locator，服务端补齐来源元数据；外部来源需完整出处。仅保存候选，不替教师确认、实施或审议。",
      parameters: typeBoxFromZod(decisionToolInputSchema, "input"),
      executionMode: "sequential",
      execute: async (callId, input) => {
        if (!decisionContextRead) throw new Error("read_decision_context_required");
        if (proposal) throw new Error("multiple_write_proposals_not_allowed");
        const inputCandidate = decisionToolInputSchema.parse(input);
        const evidenceCards = inputCandidate.evidenceCards.map((card) => {
          const uri = card.source.uri;
          const observation = observationSources.get(uri)
            ?? [...observationSources.values()].find((source) => source.uri === uri);
          if (uri === lessonSourceAlias || uri === lessonUri) {
            if (["curriculum_standard", "textbook", "student_work", "classroom_observation"].includes(card.kind)) {
              throw new Error("decision_evidence_kind_mismatch:copy lessonSource.kind=platform_data for this lesson document; it is not curriculum standards, a textbook, or observed student work. Classify the source rather than the claim");
            }
            if (!exactExcerpt(card.excerpt, lessonExcerpts)) {
              throw new Error("decision_evidence_excerpt_not_exact:copy an exact contiguous excerpt from one lesson field; split combined excerpts into separate evidence cards and keep interpretations in claim");
            }
            return { ...card, source: { ...card.source, system: "lessonup", uri: lessonUri, version: String(context.documentVersion), capturedAt } };
          }
          if (observation) {
            if (!exactExcerpt(card.excerpt, observationExcerpts.get(observation.uri) ?? [])) {
              throw new Error("decision_evidence_excerpt_not_exact:copy an exact contiguous excerpt from the observed record; keep interpretations in claim");
            }
            return { ...card, source: { ...card.source, system: "lessonup", ...observation } };
          }
          if (uri.startsWith("lessonup://")) {
            throw new Error(`decision_evidence_source_unknown:copy exactly one observed source URI from ${JSON.stringify([lessonSourceAlias, ...observationSources.keys()])}; put field/page selectors in source.locator, not in the URI`);
          }
          return card;
        });
        const candidate = proposeDecisionSchema.parse({
          ...inputCandidate,
          evidenceCards,
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
        if (candidate.status === "proposed" && candidate.decisionType !== "no_change") {
          const missing = [
            candidate.confidence === null ? "confidence" : null,
            !candidate.counterevidence.length ? "counterevidence" : null,
            !candidate.assumptions.length ? "assumptions" : null,
            !candidate.uncertainties.length ? "uncertainties" : null,
            !candidate.expectedSignal.trim() ? "expectedSignal" : null,
            !candidate.falsifier.trim() ? "falsifier" : null,
          ].filter(Boolean);
          if (missing.length) throw new Error(`decision_proposal_incomplete:actionable proposed candidates require ${missing.join(", ")}; supply explicit evidence-grounded values, or use insufficient_evidence if the judgment cannot yet be supported`);
        }
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
