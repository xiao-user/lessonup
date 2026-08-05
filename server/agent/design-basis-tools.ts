import { tool } from "@openai/agents";
import { z } from "zod";
import {
  designBasisProjectionToolSchema,
  lessonDesignChangeToolSchema,
  lessonDesignBasisPatchToolSchema,
  type LessonAgentContext,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";
import {
  createDesignBasisPatchPreflight,
  createDesignBasisProjectionPreflight,
  createLessonDesignChangePreflight,
} from "./write-preflight.js";

const requireContext = (context?: { context: unknown }) => {
  if (!context?.context) throw new Error("agent_context_missing");
  return context.context as LessonAgentContext;
};

export function createLessonDesignBasisTools(
  repository: LessonRepository,
  allowWrite: boolean,
) {
  const readLessonDesignBasis = tool({
    name: "read_lesson_design_basis",
    description: "读取当前教案的上游备课上下文：来源学期框架、单元目标、课时蓝图、章节知识点、相关复习/铺垫候选，以及独立保存的学生困难、评价证据和其他教学决定。它不是 A4 教案正文；待判断关联不能冒充已核验先修关系。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireContext(runContext);
      const aggregate = await repository.getLessonDesignBasis(
        context.userId,
        context.lessonFileId,
      );
      if (!aggregate) throw new Error("lesson_design_basis_not_found");
      let sourceState: "independent" | "current" | "source_changed" = "independent";
      let sourcePlanningContext: Record<string, unknown> | null = null;
      let mappedKnowledgePoints: Array<Record<string, unknown>> = [];
      let knowledgeNodeId = aggregate.basis.curriculumNodeId;
      let sourceFramework = aggregate.basis.frameworkId
        ? await repository.getSemesterFramework(context.userId, aggregate.basis.frameworkId)
        : null;
      const sourceBlueprint = sourceFramework?.blueprints.find((item) => (
        item.id === aggregate.basis.lessonBlueprintId
      ));
      const sourceUnit = sourceFramework?.units.find((item) => (
        item.id === sourceBlueprint?.semesterUnitId
      ));
      if (sourceBlueprint) knowledgeNodeId = sourceBlueprint.curriculumNodeId;
      if (aggregate.basis.textbookId && knowledgeNodeId) {
        const knowledge = await repository.readCurriculumNodeKnowledgePoints({
          textbookId: aggregate.basis.textbookId,
          nodeId: knowledgeNodeId,
        });
        mappedKnowledgePoints = knowledge.points.map((item) => ({
          entityId: item.point.id,
          name: item.point.canonicalName,
          detail: item.point.definition,
          sequenceNo: item.sequenceNo,
          recommendedPeriod: item.recommendedPeriod,
        }));
      }
      if (aggregate.basis.frameworkId) {
        sourceState = sourceFramework
          && sourceFramework.framework.version === aggregate.basis.sourceFrameworkVersion
          && (!sourceBlueprint || sourceBlueprint.version === aggregate.basis.sourceBlueprintVersion)
          ? "current"
          : "source_changed";
        if (sourceFramework && sourceUnit && sourceBlueprint) {
          const continuity = await repository.getSemesterFrameworkContinuity(
            context.userId,
            sourceFramework.framework.id,
          );
          const currentPointIds = new Set(mappedKnowledgePoints.map((item) => item.entityId));
          const relevantContinuity = continuity.candidates.filter((candidate) => (
            candidate.targetUnitId === sourceUnit.id
            && (!currentPointIds.size || currentPointIds.has(candidate.currentEntityId))
          ));
          sourcePlanningContext = {
            framework: {
              title: sourceFramework.framework.title,
              term: sourceFramework.framework.term,
              totalWeeks: sourceFramework.framework.totalWeeks,
              weeklyPeriods: sourceFramework.framework.weeklyPeriods,
              lessonDurationMinutes: sourceFramework.framework.lessonDurationMinutes,
              capacityRatio: sourceFramework.framework.capacityRatio,
              planningHorizonWeeks: sourceFramework.framework.planningHorizonWeeks,
              contextProfile: sourceFramework.framework.contextProfile,
            },
            unit: {
              plannedStartWeek: sourceUnit.plannedStartWeek,
              plannedEndWeek: sourceUnit.plannedEndWeek,
              plannedPeriods: sourceUnit.plannedPeriods,
              learningGoals: sourceUnit.learningGoals,
              teacherNotes: sourceUnit.teacherNotes,
            },
            blueprint: {
              plannedPeriod: sourceBlueprint.plannedPeriod,
              title: sourceBlueprint.title,
              mainActivity: sourceBlueprint.mainActivity,
              observableProduct: sourceBlueprint.observableProduct,
              assessmentEvidence: sourceBlueprint.assessmentEvidence,
              anticipatedDifficulties: sourceBlueprint.anticipatedDifficulties,
              plannedMinutes: sourceBlueprint.plannedMinutes,
              teacherNotes: sourceBlueprint.teacherNotes,
            },
            knowledgePoints: mappedKnowledgePoints,
            continuityCandidates: relevantContinuity.map((candidate) => ({
              direction: candidate.direction,
              currentPoint: candidate.currentPointName,
              relatedPoint: candidate.relatedPointName,
              evidenceLevel: candidate.evidenceKind === "lexical_similarity"
                ? "待结合目标与学情判断"
                : "平台已核验",
              rationale: candidate.rationale,
              confidence: candidate.confidence,
            })),
          };
        }
      }
      return JSON.stringify({
        basis: aggregate.basis,
        entries: aggregate.entries,
        sourceState,
        sourcePlanningContext,
        mappedKnowledgePoints,
        missingEvidence: {
          knowledgePoints: mappedKnowledgePoints.length === 0
            && !aggregate.entries.some((entry) => (
              entry.kind === "knowledge_point" && entry.decision === "accepted"
            )),
          continuity: !aggregate.entries.some((entry) => (
            (entry.kind === "review" || entry.kind === "prepare")
            && entry.decision === "accepted"
          )),
          studentDifficulties: !aggregate.entries.some((entry) => (
            entry.kind === "student_difficulty" && entry.decision === "accepted"
          )),
          assessmentEvidence: !aggregate.entries.some((entry) => (
            entry.kind === "assessment_evidence" && entry.decision === "accepted"
          )),
        },
      });
    },
  });

  if (!allowWrite) return [readLessonDesignBasis];
  return [
    readLessonDesignBasis,
    tool({
      name: "propose_lesson_design_change",
      description: "一次提交完整的备课调整：先把本轮形成或修正的教学判断保存为设计依据，再把相关结论落实到 A4 教案。教师只确认审批卡一次；批准后两部分在同一事务中写入，任一冲突都会整体回滚。A4 操作提交目标栏目的完整 replacement，当前原文快照由服务端绑定，不要提交或猜测 expectedText。新建设计依据必须提供 referenceKey，正文用 createdBasisEntryRefs 引用它。",
      parameters: lessonDesignChangeToolSchema,
      needsApproval: true,
      inputGuardrails: [createLessonDesignChangePreflight(repository)],
      execute: async (changeInput, runContext) => {
        requireContext(runContext);
        return JSON.stringify({
          status: "approved_lesson_design_change_applied",
          summary: changeInput.summary,
        });
      },
    }),
    tool({
      name: "propose_design_basis_projection",
      description: "把当前教案中已确认的设计依据转化为 A4 的教学目标、重点难点、准备、过程、评价、作业、板书或教学反思。每项修改提交目标栏目的完整 replacement，并标明实际使用的设计依据条目或明确使用学情；当前原文快照由服务端绑定。该工具始终暂停并要求教师审批；只写 A4，不修改设计依据。",
      parameters: designBasisProjectionToolSchema,
      needsApproval: true,
      inputGuardrails: [createDesignBasisProjectionPreflight(repository)],
      execute: async (projectionInput, runContext) => {
        requireContext(runContext);
        return JSON.stringify({
          status: "approved_design_basis_projection_applied",
          summary: projectionInput.summary,
        });
      },
    }),
    tool({
      name: "propose_lesson_design_basis_patch",
      description: "提出对当前教案设计依据的结构化修改；可新增/修改/删除知识点、复习、铺垫、学生困难、评价证据和其他确实影响课堂实施的教学决定。该工具始终暂停并要求教师审批，不直接修改 A4 正文。",
      parameters: lessonDesignBasisPatchToolSchema,
      needsApproval: true,
      inputGuardrails: [createDesignBasisPatchPreflight(repository)],
      execute: async (patchInput, runContext) => {
        requireContext(runContext);
        return JSON.stringify({
          status: "approved_lesson_design_basis_patch_applied",
          summary: patchInput.summary,
        });
      },
    }),
  ];
}
