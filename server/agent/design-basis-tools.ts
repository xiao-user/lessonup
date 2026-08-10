import { tool } from "@openai/agents";
import { z } from "zod";
import {
  designBasisProjectionToolSchema,
  lessonDesignChangeToolSchema,
  lessonDesignBasisPatchToolSchema,
  type LessonAgentContext,
  type LessonClassFeedbackRecord,
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
    description: "读取当前教案的上游备课上下文：来源学期框架、单元目标、课时蓝图、章节知识点、教师已取舍的复习/铺垫候选、同单元前序课堂反馈，以及独立保存的学生困难与评价证据。它不是 A4 教案正文；待判断关联和课堂反馈都不能冒充已核验先修关系。",
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
          const [continuity, frameworkFeedback] = await Promise.all([
            repository.getSemesterFrameworkContinuity(
              context.userId,
              sourceFramework.framework.id,
            ),
            repository.listLessonClassFeedback(context.userId, {
              semesterFrameworkId: sourceFramework.framework.id,
            }),
          ]);
          const currentPointIds = new Set(mappedKnowledgePoints.map((item) => item.entityId));
          const relevantContinuity = continuity.candidates.filter((candidate) => (
            candidate.targetUnitId === sourceUnit.id
            && candidate.decision !== "dismissed"
            && (!currentPointIds.size || currentPointIds.has(candidate.currentEntityId))
          ));
          const preferredContinuity = relevantContinuity.some((candidate) => (
            candidate.decision === "accepted"
          ))
            ? relevantContinuity.filter((candidate) => candidate.decision === "accepted")
            : relevantContinuity;
          const unitBlueprintIds = new Set(
            sourceFramework.blueprints
              .filter((item) => item.semesterUnitId === sourceUnit.id)
              .map((item) => item.id),
          );
          const priorBlueprintIds = new Set(
            sourceFramework.blueprints
              .filter((item) => (
                item.semesterUnitId === sourceUnit.id
                && item.plannedPeriod < sourceBlueprint.plannedPeriod
              ))
              .map((item) => item.id),
          );
          const presentFeedback = (record: LessonClassFeedbackRecord) => ({
            "类型": ({
              observation: "课堂观察",
              practice_gap: "练习缺口",
              error_cause: "错因",
              continuity_outcome: "衔接效果",
            })[record.kind],
            "说明": record.statement,
            "所属": record.lessonBlueprintId === sourceBlueprint.id
              ? "本课"
              : priorBlueprintIds.has(record.lessonBlueprintId ?? "")
                ? "同单元前序课时"
                : unitBlueprintIds.has(record.lessonBlueprintId ?? "")
                  ? "同单元其他课时"
                  : "本框架其他记录",
            "衔接结果": record.continuityOutcome === "worked"
              ? "有效"
              : record.continuityOutcome === "weak"
                ? "偏弱"
                : record.continuityOutcome === "skipped"
                  ? "未落实"
                  : null,
          });
          const priorClassFeedback = frameworkFeedback
            .filter((record) => (
              record.lessonFileId !== context.lessonFileId
              && priorBlueprintIds.has(record.lessonBlueprintId ?? "")
            ))
            .slice(0, 20)
            .map(presentFeedback);
          const currentClassFeedback = frameworkFeedback
            .filter((record) => record.lessonFileId === context.lessonFileId)
            .slice(0, 20)
            .map(presentFeedback);
          sourcePlanningContext = {
            "框架": {
              "标题": sourceFramework.framework.title,
              "学期": sourceFramework.framework.term,
              "教学周数": sourceFramework.framework.totalWeeks,
              "每周课时": sourceFramework.framework.weeklyPeriods,
              "每课时分钟": sourceFramework.framework.lessonDurationMinutes,
              "容量系数": sourceFramework.framework.capacityRatio,
              "班级教学情境": sourceFramework.framework.contextProfile,
            },
            "单元": {
              "计划起始周": sourceUnit.plannedStartWeek,
              "计划结束周": sourceUnit.plannedEndWeek,
              "计划课时": sourceUnit.plannedPeriods,
              "单元目标": sourceUnit.learningGoals,
              "教师备注": sourceUnit.teacherNotes,
            },
            "课时蓝图": {
              "单元第几课时": sourceBlueprint.plannedPeriod,
              "课时名称": sourceBlueprint.title,
              "主要教学活动": sourceBlueprint.mainActivity,
              "学生可观察产出": sourceBlueprint.observableProduct,
              "达成证据": sourceBlueprint.assessmentEvidence,
              "预判难点": sourceBlueprint.anticipatedDifficulties,
              "课堂分钟": sourceBlueprint.plannedMinutes,
              "教师备注": sourceBlueprint.teacherNotes,
            },
            "知识点": mappedKnowledgePoints.map((item) => ({
              "名称": item.name,
              "说明": item.detail,
              "建议课时": item.recommendedPeriod,
            })),
            "教学衔接候选": preferredContinuity.map((candidate) => ({
              "方向": candidate.direction === "review" ? "复习旧知" : "后续铺垫",
              "当前知识": candidate.currentPointName,
              "关联知识": candidate.relatedPointName,
              "依据级别": candidate.evidenceKind === "lexical_similarity"
                ? "待结合目标与学情判断"
                : "平台已核验",
              "教师取舍": candidate.decision === "accepted" ? "已采用" : "待取舍",
              "依据说明": candidate.rationale,
            })),
            "同单元前序课堂反馈": priorClassFeedback,
            "本课课堂反馈": currentClassFeedback,
            "反馈使用边界": "课堂反馈与教师取舍只代表本班学情，不得表述为平台已核验先修关系；薄弱衔接应落实到本课复习任务、过程支架或评价证据。",
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
