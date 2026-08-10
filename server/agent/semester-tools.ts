import { tool } from "@openai/agents";
import { z } from "zod";
import { buildContinuityWritebackHints } from "../curriculum/continuity-adoption.js";
import {
  isSemesterFrameworkAgentContext,
  semesterFrameworkPatchToolSchema,
  type PreparationAgentContext,
  type SemesterFrameworkAgentContext,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";
import {
  presentSemesterBlueprintForAgent,
  presentSemesterUnitForAgent,
} from "./teacher-facing-language.js";
import { createSemesterFrameworkPatchPreflight } from "./write-preflight.js";

const lessonKnowledgeSummary = (record: Awaited<ReturnType<LessonRepository["readCurriculumNodeKnowledgePoints"]>>) => ({
  knowledgePoints: record.points.map((item) => ({
    toolRef: { entityId: item.point.id },
    名称: item.point.canonicalName,
    说明: item.point.definition,
    建议课时: item.recommendedPeriod,
  })),
  periodRecommendations: record.periodRecommendations.map((period) => ({
    toolRef: { pointIds: period.pointIds },
    第几课时: period.periodNo,
    标题: period.title,
    是否官方: period.isOfficial,
    说明: period.note,
  })),
});

const descendantNodes = <T extends { nodeId: string; parentId: string | null }>(
  nodes: T[],
  parentId: string,
) => {
  const childrenByParent = new Map<string, T[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const result: T[] = [];
  const pending = [...(childrenByParent.get(parentId) ?? [])];
  while (pending.length) {
    const node = pending.shift()!;
    result.push(node);
    pending.push(...(childrenByParent.get(node.nodeId) ?? []));
  }
  return result;
};

const curriculumNodeTitleOf = (
  nodes: Array<{ nodeId: string; title: string }>,
  nodeId: string,
) => nodes.find((node) => node.nodeId === nodeId)?.title ?? "目录节点已不可用";

const requireSemesterContext = (context?: { context: unknown }): SemesterFrameworkAgentContext => {
  if (!context?.context) throw new Error("agent_context_missing");
  const value = context.context as PreparationAgentContext;
  if (!isSemesterFrameworkAgentContext(value)) throw new Error("semester_framework_context_required");
  return value;
};

async function readScopedFramework(
  repository: LessonRepository,
  context: SemesterFrameworkAgentContext,
) {
  const aggregate = await repository.getSemesterFramework(
    context.userId,
    context.semesterFrameworkId,
  );
  if (!aggregate || aggregate.framework.notebookId !== context.notebookId) {
    throw new Error("semester_framework_scope_invalid");
  }
  return aggregate;
}

export function createSemesterFrameworkTools(
  repository: LessonRepository,
  allowWrite = false,
  options: { maxPatchOperations?: number } = {},
) {
  const readSemesterFramework = tool({
    name: "read_semester_framework",
    description: "读取当前学期框架、学期参数、单元顺序、课时蓝图和教师已确认的学习结果。仅访问当前线程绑定的框架。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireSemesterContext(runContext);
      const aggregate = await readScopedFramework(repository, context);
      const nodes = await repository.listCurriculumNodes({
        textbookId: aggregate.framework.textbookId,
        catalogReleaseId: aggregate.framework.catalogReleaseId,
        maxLevel: 8,
      });
      const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
      const knowledgeByNodeId = await repository.readCurriculumNodesKnowledgePoints({
        textbookId: aggregate.framework.textbookId,
        nodeIds: [...new Set(aggregate.blueprints.map((blueprint) => blueprint.curriculumNodeId))],
      });
      return JSON.stringify({
        说明: "下列中文栏目供理解与对教师说明；发起修改时只用各条目 toolRef 中的稳定标识。",
        framework: {
          toolRef: {
            frameworkId: aggregate.framework.id,
            textbookId: aggregate.framework.textbookId,
            catalogReleaseId: aggregate.framework.catalogReleaseId,
          },
          框架名称: aggregate.framework.title,
          学期: aggregate.framework.term,
          开学日期: aggregate.framework.startDate,
          教学周数: aggregate.framework.totalWeeks,
          每周课时: aggregate.framework.weeklyPeriods,
          每课时分钟: aggregate.framework.lessonDurationMinutes,
          课堂容量系数: aggregate.framework.capacityRatio,
          滚动备课周数: aggregate.framework.planningHorizonWeeks,
          班级教学情境: aggregate.framework.contextProfile,
          状态: aggregate.framework.status,
          框架版本: aggregate.framework.version,
        },
        units: aggregate.units.map((unit) => presentSemesterUnitForAgent(
          unit,
          nodeById.get(unit.curriculumNodeId)?.title ?? "目录节点已不可用",
        )),
        blueprints: aggregate.blueprints.map((blueprint) => {
          const knowledge = lessonKnowledgeSummary(knowledgeByNodeId[blueprint.curriculumNodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          });
          return presentSemesterBlueprintForAgent(blueprint, {
            curriculumNodeTitle: nodeById.get(blueprint.curriculumNodeId)?.title ?? "目录节点已不可用",
            knowledgePoints: knowledge.knowledgePoints,
            periodRecommendations: knowledge.periodRecommendations,
          });
        }),
        outcomeSelections: aggregate.outcomeSelections,
      });
    },
  });

  const readSemesterUnit = tool({
    name: "read_semester_unit",
    description: "按稳定单元 ID 读取当前学期框架中的一个单元及其课时蓝图。先从 read_semester_framework 的 unit.toolRef.unitId 取得单元 ID。",
    parameters: z.object({ unitId: z.string().uuid() }),
    execute: async ({ unitId }, runContext) => {
      const context = requireSemesterContext(runContext);
      const aggregate = await readScopedFramework(repository, context);
      const unit = aggregate.units.find((candidate) => candidate.id === unitId);
      if (!unit) throw new Error("semester_unit_not_found");
      const nodes = await repository.listCurriculumNodes({
        textbookId: aggregate.framework.textbookId,
        catalogReleaseId: aggregate.framework.catalogReleaseId,
        maxLevel: 8,
      });
      const node = nodes.find((candidate) => candidate.nodeId === unit.curriculumNodeId);
      const unitBlueprints = aggregate.blueprints.filter((item) => item.semesterUnitId === unit.id);
      const curriculumLessons = descendantNodes(nodes, unit.curriculumNodeId);
      const curriculumNodeIds = [...new Set([
        ...curriculumLessons.map((item) => item.nodeId),
        ...unitBlueprints.map((blueprint) => blueprint.curriculumNodeId),
      ])];
      const knowledgeByNodeId = await repository.readCurriculumNodesKnowledgePoints({
        textbookId: aggregate.framework.textbookId,
        nodeIds: curriculumNodeIds,
      });
      return JSON.stringify({
        说明: "中文栏目用于理解与对教师说明；修改提案只使用 toolRef。",
        unit: presentSemesterUnitForAgent(unit, node?.title ?? "目录节点已不可用"),
        blueprints: unitBlueprints.map((blueprint) => {
          const knowledge = lessonKnowledgeSummary(knowledgeByNodeId[blueprint.curriculumNodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          });
          return presentSemesterBlueprintForAgent(blueprint, {
            curriculumNodeTitle: curriculumNodeTitleOf(nodes, blueprint.curriculumNodeId),
            knowledgePoints: knowledge.knowledgePoints,
            periodRecommendations: knowledge.periodRecommendations,
          });
        }),
        curriculumLessons: curriculumLessons.map((lesson) => {
          const knowledge = lessonKnowledgeSummary(knowledgeByNodeId[lesson.nodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          });
          return {
            toolRef: { nodeId: lesson.nodeId },
            篇目标题: lesson.title,
            知识点: knowledge.knowledgePoints,
            课时建议: knowledge.periodRecommendations,
          };
        }).filter((lesson) => (
          lesson.知识点.length > 0 || lesson.课时建议.length > 0
        )),
        outcomeSelections: aggregate.outcomeSelections.filter((item) => (
          item.semesterUnitId === unit.id
          || aggregate.blueprints.some((blueprint) => (
            blueprint.semesterUnitId === unit.id && blueprint.id === item.lessonBlueprintId
          ))
        )),
        框架版本: aggregate.framework.version,
      });
    },
  });

  const getFrameworkVersion = tool({
    name: "get_semester_framework_version",
    description: "读取当前学期框架的聚合版本。判断上下文是否过期时使用。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireSemesterContext(runContext);
      const aggregate = await readScopedFramework(repository, context);
      return JSON.stringify({ frameworkVersion: aggregate.framework.version });
    },
  });

  const readSemesterFrameworkContinuity = tool({
    name: "read_semester_framework_continuity",
    description: "读取各单元可用于复习旧知和后续铺垫的教学衔接候选。严格层来自同一已审核知识点或已审核方向关系；召回层使用去除通用教学词后的名称相关性，只标记为待判断，不冒充已核验先修关系。最终必须结合单元目标、教材顺序与本班学情取舍。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireSemesterContext(runContext);
      const aggregate = await readScopedFramework(repository, context);
      const result = await repository.refreshSemesterFrameworkContinuity(
        context.userId,
        context.semesterFrameworkId,
      );
      const nodes = await repository.listCurriculumNodes({
        textbookId: aggregate.framework.textbookId,
        catalogReleaseId: aggregate.framework.catalogReleaseId,
        maxLevel: 8,
      });
      const nodeTitleByUnitId = new Map(aggregate.units.map((unit) => [
        unit.id,
        nodes.find((node) => node.nodeId === unit.curriculumNodeId)?.title ?? "目录节点已不可用",
      ]));
      return JSON.stringify({
        "结论": result.candidates.length
          ? "平台找到了教学衔接候选；其中已审核关系可作为依据，词法相关项只负责召回，仍需结合本班学情与课时取舍。"
          : "当前框架没有具备确定性证据的复习或铺垫候选。",
        "候选统计": {
          "已核验": result.candidates.filter((candidate) => (
            candidate.evidenceKind !== "lexical_similarity"
          )).length,
          "待判断": result.candidates.filter((candidate) => (
            candidate.evidenceKind === "lexical_similarity"
          )).length,
          "教师已采用": result.candidates.filter((candidate) => (
            candidate.decision === "accepted"
          )).length,
          "教师已排除": result.candidates.filter((candidate) => (
            candidate.decision === "dismissed"
          )).length,
        },
        "候选安排": result.candidates.map((candidate) => ({
          toolRef: { fingerprint: candidate.fingerprint },
          "当前单元": nodeTitleByUnitId.get(candidate.targetUnitId) ?? "未知单元",
          "方向": candidate.direction === "review" ? "复习旧知" : "后续铺垫",
          "当前知识": candidate.currentPointName,
          "关联知识": candidate.relatedPointName,
          "关联单元": nodeTitleByUnitId.get(candidate.relatedUnitId) ?? "未知单元",
          "依据级别": candidate.evidenceKind === "lexical_similarity"
            ? "待结合目标与学情判断"
            : "平台已核验",
          "教师取舍": candidate.decision === "accepted"
            ? "已采用"
            : candidate.decision === "dismissed"
              ? "已排除"
              : "待取舍",
          "依据说明": candidate.rationale,
          "可信度": candidate.confidence,
        })),
        "取舍边界": "教师已采用的衔接优先落实到活动、产出或证据；已排除的不要再写入规划。其余候选不是必须安排；词法相关和教材先后都不等于先修证明。最终取舍要结合班级学情、课时与本单元目标。",
      });
    },
  });

  const readFrameworkClassFeedback = tool({
    name: "read_framework_class_feedback",
    description: "读取本学期框架下已记录的课堂反馈（观察、练习缺口、错因、衔接是否有效）。偏弱或未落实的衔接效果会附带同单元下一课时蓝图回写建议；不得把反馈提升为平台已核验先修关系。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireSemesterContext(runContext);
      const [records, aggregate] = await Promise.all([
        repository.listLessonClassFeedback(context.userId, {
          semesterFrameworkId: context.semesterFrameworkId,
        }),
        repository.getSemesterFramework(context.userId, context.semesterFrameworkId),
      ]);
      if (!records.length) {
        return JSON.stringify({
          "结论": "当前框架还没有课堂反馈记录。",
          "记录": [],
          "待回写建议": [],
        });
      }
      const writebackHints = buildContinuityWritebackHints(
        records,
        aggregate?.blueprints ?? [],
      );
      return JSON.stringify({
        "结论": writebackHints.length
          ? "以下是教师记录的课堂事实与判断；对偏弱或未落实的衔接效果，应优先按待回写建议修改同单元下一课时蓝图，并提交一次审批确认。"
          : "以下是教师记录的课堂事实与判断；规划后续课时时应优先消化薄弱衔接和错因，而不是重复生成空泛复习标签。",
        "记录": records.slice(0, 40).map((record) => ({
          "类型": ({
            observation: "课堂观察",
            practice_gap: "练习缺口",
            error_cause: "错因",
            continuity_outcome: "衔接效果",
          })[record.kind],
          "说明": record.statement,
          "衔接方向": record.continuityDirection === "review"
            ? "复习旧知"
            : record.continuityDirection === "prepare"
              ? "后续铺垫"
              : null,
          "衔接结果": record.continuityOutcome === "worked"
            ? "有效"
            : record.continuityOutcome === "weak"
              ? "偏弱"
              : record.continuityOutcome === "skipped"
                ? "未落实"
                : null,
          "回写状态": record.writebackStatus === "pending"
            ? "待回写"
            : record.writebackStatus === "applied"
              ? "已回写"
              : record.writebackStatus === "not_applicable"
                ? "无需回写"
                : null,
          toolRef: {
            feedbackId: record.id,
            lessonFileId: record.lessonFileId,
            lessonBlueprintId: record.lessonBlueprintId,
            continuityFingerprint: record.continuityFingerprint,
          },
        })),
        "待回写建议": writebackHints.map((hint) => ({
          "反馈编号": hint.feedbackId,
          "反馈说明": hint.statement,
          "衔接方向": hint.continuityDirection === "review"
            ? "复习旧知"
            : hint.continuityDirection === "prepare"
              ? "后续铺垫"
              : null,
          "衔接结果": hint.continuityOutcome === "weak" ? "偏弱" : "未落实",
          "来源课时": hint.sourceBlueprint
            ? {
                "课时名称": hint.sourceBlueprint.title,
                "单元第几课时": hint.sourceBlueprint.plannedPeriod,
                toolRef: { blueprintId: hint.sourceBlueprint.id },
              }
            : null,
          "建议修改的下一课时": hint.nextBlueprint
            ? {
                "课时名称": hint.nextBlueprint.title,
                "单元第几课时": hint.nextBlueprint.plannedPeriod,
                "当前主要教学活动": hint.nextBlueprint.mainActivity,
                "当前学生可观察产出": hint.nextBlueprint.observableProduct,
                "当前达成证据": hint.nextBlueprint.assessmentEvidence,
                toolRef: {
                  blueprintId: hint.nextBlueprint.id,
                  expectedVersion: hint.nextBlueprint.version,
                },
              }
            : null,
          "建议动作": hint.nextBlueprint
            ? "用 replace_lesson_blueprint_field 调整下一课时的主要教学活动、学生可观察产出或达成证据，把薄弱衔接落实为具体任务；不要静默改写，必须一次审批确认。"
            : "同单元尚无下一课时蓝图：先说明缺口，必要时再创建下一课时蓝图，不要编造已有蓝图。",
          "回写状态": "待确认",
        })),
        "使用边界": "课堂反馈只代表本班学情；待回写建议不是平台已核验先修关系，也不得绕过教师审批直接写入。",
      });
    },
  });

  const tools = [
    readSemesterFramework,
    readSemesterUnit,
    getFrameworkVersion,
    readSemesterFrameworkContinuity,
    readFrameworkClassFeedback,
  ];
  if (!allowWrite) return tools;

  tools.push(tool({
    name: "propose_semester_framework_patch",
    description: "提出一个可审批的学期框架变更集：可修改框架/单元字段，也可批量补齐、编辑或删除正式课时蓝图。一个蓝图只代表一个真实课时。工具参数沿用 schema 字段；对教师说明时只用中文界面说法（第几课时、主要教学活动、学生可观察产出、达成证据等），不要复述英文字段名或蓝图 UUID。chapterPeriodNo 是章节内部第几课时，plannedMinutes 是单课时时长（20–60 分钟），默认沿用框架课时制。服务端用 semesterUnitId + curriculumNodeId + chapterPeriodNo 对齐：同课次更新、缺课次新增、未提及保留、显式 delete 才删除。教师说“补一节”时保留原课次并新增；明确要求按建议重建时，还要 delete 超出建议且不再需要的旧课次。多课时建议必须分条提交。规划多个单元时优先用 plan_semester_unit 合并为一次确认。编辑必须复制当前 expectedValue，删除必须复制 expectedVersion。严禁把结构化蓝图写入 teacherNotes。始终暂停等待教师审批。",
    parameters: semesterFrameworkPatchToolSchema,
    needsApproval: true,
    inputGuardrails: [createSemesterFrameworkPatchPreflight(repository, {
      maxOperations: options.maxPatchOperations,
    })],
    execute: async (proposal, runContext) => {
      const context = requireSemesterContext(runContext);
      const aggregate = await repository.getSemesterFramework(
        context.userId,
        context.semesterFrameworkId,
      );
      if (!aggregate) throw new Error("semester_framework_not_found");
      return JSON.stringify({
        status: "approved_semester_framework_patch_applied",
        summary: proposal.summary,
        frameworkVersion: aggregate.framework.version,
      });
    },
  }));
  return tools;
}
