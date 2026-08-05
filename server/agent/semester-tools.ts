import { tool } from "@openai/agents";
import { z } from "zod";
import {
  isSemesterFrameworkAgentContext,
  semesterFrameworkPatchToolSchema,
  type PreparationAgentContext,
  type SemesterFrameworkAgentContext,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { createSemesterFrameworkPatchPreflight } from "./write-preflight.js";

const lessonKnowledgeSummary = (record: Awaited<ReturnType<LessonRepository["readCurriculumNodeKnowledgePoints"]>>) => ({
  knowledgePoints: record.points.map((item) => ({
    entityId: item.point.id,
    name: item.point.canonicalName,
    detail: item.point.definition,
    recommendedPeriod: item.recommendedPeriod,
  })),
  periodRecommendations: record.periodRecommendations.map((period) => ({
    periodNo: period.periodNo,
    title: period.title,
    pointIds: period.pointIds,
    isOfficial: period.isOfficial,
    note: period.note,
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
        framework: aggregate.framework,
        units: aggregate.units.map((unit) => ({
          ...unit,
          curriculumNodeTitle: nodeById.get(unit.curriculumNodeId)?.title ?? "目录节点已不可用",
        })),
        blueprints: aggregate.blueprints.map((blueprint) => ({
          ...blueprint,
          curriculumNodeTitle: nodeById.get(blueprint.curriculumNodeId)?.title ?? "目录节点已不可用",
          ...lessonKnowledgeSummary(knowledgeByNodeId[blueprint.curriculumNodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          }),
        })),
        outcomeSelections: aggregate.outcomeSelections,
      });
    },
  });

  const readSemesterUnit = tool({
    name: "read_semester_unit",
    description: "按稳定单元 ID 读取当前学期框架中的一个单元及其课时蓝图。先从 read_semester_framework 获得单元 ID。",
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
        unit: { ...unit, curriculumNodeTitle: node?.title ?? "目录节点已不可用" },
        blueprints: unitBlueprints.map((blueprint) => ({
          ...blueprint,
          ...lessonKnowledgeSummary(knowledgeByNodeId[blueprint.curriculumNodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          }),
        })),
        curriculumLessons: curriculumLessons.map((lesson) => ({
          nodeId: lesson.nodeId,
          title: lesson.title,
          ...lessonKnowledgeSummary(knowledgeByNodeId[lesson.nodeId] ?? {
            release: null,
            points: [],
            periodRecommendations: [],
          }),
        })).filter((lesson) => (
          lesson.knowledgePoints.length > 0 || lesson.periodRecommendations.length > 0
        )),
        outcomeSelections: aggregate.outcomeSelections.filter((item) => (
          item.semesterUnitId === unit.id
          || aggregate.blueprints.some((blueprint) => (
            blueprint.semesterUnitId === unit.id && blueprint.id === item.lessonBlueprintId
          ))
        )),
        frameworkVersion: aggregate.framework.version,
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
        },
        "候选安排": result.candidates.map((candidate) => ({
          "当前单元": nodeTitleByUnitId.get(candidate.targetUnitId) ?? "未知单元",
          "方向": candidate.direction === "review" ? "复习旧知" : "后续铺垫",
          "当前知识": candidate.currentPointName,
          "关联知识": candidate.relatedPointName,
          "关联单元": nodeTitleByUnitId.get(candidate.relatedUnitId) ?? "未知单元",
          "依据级别": candidate.evidenceKind === "lexical_similarity"
            ? "待结合目标与学情判断"
            : "平台已核验",
          "依据说明": candidate.rationale,
          "可信度": candidate.confidence,
        })),
        "取舍边界": "候选不是必须安排；词法相关和教材先后都不等于先修证明。最终取舍要结合班级学情、课时与本单元目标，并落实为具体活动或评价证据。",
      });
    },
  });

  const tools = [
    readSemesterFramework,
    readSemesterUnit,
    getFrameworkVersion,
    readSemesterFrameworkContinuity,
  ];
  if (!allowWrite) return tools;

  tools.push(tool({
    name: "propose_semester_framework_patch",
    description: "提出一个可审批的学期框架变更集：可修改框架/单元字段，也可批量补齐、编辑或删除正式课时蓝图。一个蓝图只代表一个真实课时；chapterPeriodNo 是该教材章节内部稳定的第几课时，plannedMinutes 是这一个课时的时长（20–60 分钟），默认沿用框架课时制，绝不是章节总时长。服务端会用 semesterUnitId + curriculumNodeId + chapterPeriodNo 对齐现有蓝图：同一课次更新已有记录，缺少课次才新增，未提及的已有课次保留；只有显式 delete 才删除。教师说“补一节”时保留原课次并新增下一课次；教师明确说“按当前课时建议重新调整、对齐或重建”时，应更新建议内课次并为超出建议且不再需要的旧课次提交 delete，使最终集合与建议一致。章节有多个 periodRecommendations 时，必须分别使用对应的知识点、活动、产出和证据。教师明确要求在建议 2 课时之外增加第 3 课时时，使用 chapterPeriodNo=3。规划一个或多个完整单元时，优先为每个单元使用一个 plan_semester_unit，并把本轮全部单元合并成一次确认；服务端会绑定真实前值并原子写入，不要按单元拆成连续确认。编辑必须复制当前字段的 expectedValue，删除必须复制当前 expectedVersion。严禁把结构化蓝图写入 teacherNotes 代替正式记录。始终暂停等待教师审批。",
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
