import {
  ToolGuardrailFunctionOutputFactory,
  type ToolInputGuardrailDefinition,
} from "@openai/agents";
import { z } from "zod";

import {
  designBasisProjectionToolSchema,
  documentPatchToolSchema,
  isSemesterFrameworkAgentContext,
  lessonDesignBasisPatchToolSchema,
  lessonDesignChangeToolSchema,
  semesterFrameworkPatchToolSchema,
  type LessonAgentContext,
  type LessonDesignBasisPatchProposal,
  type PreparationAgentContext,
  type SemesterFrameworkAggregate,
  type SemesterFrameworkPatchProposal,
} from "../domain.js";
import {
  DesignBasisProjectionError,
  materializeDesignBasisProjection,
} from "../design-basis-projection.js";
import {
  applyDocumentPatch,
  DocumentPatchError,
  materializeDocumentPatchProposal,
} from "../document-patch.js";
import {
  LessonDesignBasisPatchError,
  materializeLessonDesignBasisPatch,
} from "../lesson-design-basis-patch.js";
import {
  LessonDesignChangeError,
  materializeLessonDesignChange,
} from "../lesson-design-change.js";
import type { LessonRepository } from "../repository.js";
import {
  materializeSemesterFrameworkPatch,
  SemesterFrameworkPatchError,
} from "../semester-framework-patch.js";

export class WritePreflightError extends Error {
  constructor(readonly code: string, readonly guidance?: string) {
    super(guidance ?? code);
    this.name = "WritePreflightError";
  }
}

const parseArguments = (argumentsJson: string) => JSON.parse(argumentsJson || "{}");

const errorCode = (error: unknown) => {
  if (
    error instanceof LessonDesignBasisPatchError
    || error instanceof LessonDesignChangeError
    || error instanceof SemesterFrameworkPatchError
    || error instanceof WritePreflightError
  ) return error.code;
  if (error instanceof DesignBasisProjectionError) return error.code;
  if (error instanceof DocumentPatchError) {
    if (error.code === "text_mismatch") return "stale_document";
    if (error.message.includes("原文不唯一")) return "patch_target_ambiguous";
    if (error.message.includes("未产生任何实际变化")) return "no_effect_patch";
    return error.code;
  }
  if (error instanceof z.ZodError) {
    const businessCode = error.issues
      .map((issue) => issue.message)
      .find((message) => /^[a-z][a-z0-9_]+$/.test(message));
    return businessCode ?? "invalid_patch_schema";
  }
  return error instanceof Error ? error.message : "invalid_patch_proposal";
};

const recoveryGuidance = (code: string) => {
  if (code === "design_basis_evidence_required" || code === "unobserved_design_basis_evidence") {
    return "这项内容被表述成平台已有的教材事实，但本轮尚未取得直接依据。请重新核对当前章节资料；如果它只是根据教案和学情作出的课堂判断，就用教师可读的教学判断表达，不要冒充平台事实。";
  }
  if (code === "unknown_curriculum_entity" || code === "curriculum_evidence_mismatch") {
    return "引用的教材知识与平台当前章节资料不一致。请重新核对当前章节，只使用本轮实际读取到的知识和来源。";
  }
  if (code === "curriculum_node_scope_invalid") {
    return "复习或铺垫指向的教材章节不属于当前教案绑定教材。请重新检索当前教材范围内的章节后再提交。";
  }
  if (code === "patch_target_ambiguous") {
    return "局部修改引用的原文在栏目中出现了多次。若要重写整栏，请直接提交该栏目的完整新内容；若只改局部，请重新读取栏目并引用带有上下文的完整原句。";
  }
  if (code === "stale_document" || code === "document_context_stale") {
    return "教案快照已经变化。请重新读取实际目标栏目和文档版本，只重做受影响的修改。";
  }
  if (code === "stale_design_basis" || code === "design_basis_context_stale") {
    return "设计依据已经变化。请重新读取设计依据，只重做受影响的引用或修改。";
  }
  if (code === "stale_resource" || code === "resource_context_stale") {
    return "学期框架快照已经变化。请重新读取目标单元或蓝图，只重做受影响的操作。";
  }
  if (code === "no_effect_patch") {
    return "提案没有产生实际变化。请删除无效操作；如果当前内容已经合适，直接向教师说明无需修改。";
  }
  if (code === "too_many_document_operations") {
    return "教师本轮只要求一处最小修改。请保留对当前目标影响最大的一处栏目修改，删除其余操作后重新提交。";
  }
  if (code === "too_many_framework_operations") {
    return "教师本轮只要求修改最影响课堂实施的一处内容。请保留一个蓝图字段操作，把教师动作、学生任务、可观察产出和达成证据合并为完整且可读的一处表述。";
  }
  if (code === "blueprint_specific_curriculum_node_required") {
    return "这个课时标题已经能唯一对应当前单元中的具体教材章节，但蓝图没有绑定该章节。请读取当前教材目录，改用准确章节后再提交；单元复习、检测等跨章节课时才可以绑定单元节点。";
  }
  if (code === "blueprint_period_recommendation_mismatch") {
    return "完整规划单元时，不能把一个章节的多个建议课时合并成一条长蓝图。请读取目标单元返回的 periodRecommendations；同一章节按第 1、第 2……课时分别创建蓝图，每条只安排当前课时的知识、活动、学生产出和达成证据。课时分钟由服务端按框架统一设置，无需相加或填写。";
  }
  if (code === "lesson_design_change_source_required") {
    return "结构化记录和教案正文之间缺少明确对应。请只保留真正支撑相关栏目的依据；如果教师只是要完成教案，可改为直接更新 A4 栏目。";
  }
  if (code === "unique_reference_key_required_for_created_basis_entry") {
    return "本次结构化记录中存在无法区分的重复引用。请合并重复内容，并让每条新增依据只对应它实际支撑的教案栏目。";
  }
  if (code === "unknown_created_basis_entry_reference" || code === "duplicate_created_basis_entry_reference") {
    return "教案正文引用了本次调整中不存在或重复的依据。请删除无效引用，并只保留实际创建且直接相关的依据。";
  }
  if (code === "semantic_entity_required" || code === "continuity_reference_required") {
    return "作为平台知识或前后衔接保存的内容缺少当前教材依据。请先核对章节和相关知识；若只是课堂取舍，就以教学判断表达。";
  }
  if (code === "unexpected_continuity_reference") {
    return "这项普通课堂判断不应附带前后章节关系。请删除无关关系，只保留对当前课堂有用的内容。";
  }
  return "这次修改还不能进入教师确认。请重新读取受影响的当前内容，简化为一次可执行的修改后再提交；不要向教师展示技术细节，也不要声称已经写入。";
};

const reject = (error: unknown) => {
  const code = errorCode(error);
  const guidance = error instanceof WritePreflightError && error.guidance
    ? error.guidance
    : recoveryGuidance(code);
  return ToolGuardrailFunctionOutputFactory.rejectContent(
    `【提案需调整】${guidance}`,
    { code },
  );
};

const allow = () => ToolGuardrailFunctionOutputFactory.allow();

const isCommittedApprovalReplay = (
  context: PreparationAgentContext,
  toolCall: { callId?: string },
) => Boolean(
  context.approvedToolReplayCallId
  && toolCall.callId === context.approvedToolReplayCallId
);

const normalizeBlueprintTitle = (value: string) => value
  .toLocaleLowerCase("zh-CN")
  .replace(/[《》〈〉*＊：:，,。·—\-（）()\[\]【】“”"'\s]/g, "")
  .replace(/^\d+/, "")
  .replace(/^(写作|专题学习活动|整本书阅读)/, "");

async function validateBlueprintCurriculumBindings(args: {
  repository: LessonRepository;
  aggregate: SemesterFrameworkAggregate;
  proposal: SemesterFrameworkPatchProposal;
}) {
  const creations = args.proposal.operations.flatMap((operation) => {
    if (operation.op === "create_lesson_blueprint") return [operation];
    if (operation.op === "plan_semester_unit") {
      return operation.blueprints.map((blueprint) => ({
        ...blueprint,
        semesterUnitId: operation.unitId,
      }));
    }
    return [];
  });
  if (!creations.length) return;

  const nodes = await args.repository.listCurriculumNodes({
    textbookId: args.aggregate.framework.textbookId,
    catalogReleaseId: args.aggregate.framework.catalogReleaseId,
    maxLevel: 8,
  });
  const childrenByParent = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  for (const creation of creations) {
    const unit = args.aggregate.units.find((candidate) => candidate.id === creation.semesterUnitId);
    if (!unit) continue;
    const descendants: typeof nodes = [];
    const pending = [...(childrenByParent.get(unit.curriculumNodeId) ?? [])];
    while (pending.length) {
      const node = pending.shift()!;
      descendants.push(node);
      pending.push(...(childrenByParent.get(node.nodeId) ?? []));
    }
    const normalizedTitle = normalizeBlueprintTitle(creation.title);
    const exactMatches = descendants.filter((node) => (
      normalizeBlueprintTitle(node.title) === normalizedTitle
    ));
    if (
      normalizedTitle
      && exactMatches.length === 1
      && creation.curriculumNodeId !== exactMatches[0]!.nodeId
    ) {
      throw new WritePreflightError("blueprint_specific_curriculum_node_required");
    }
  }

  for (const operation of args.proposal.operations) {
    if (operation.op !== "plan_semester_unit") continue;
    const proposedCountByNode = new Map<string, number>();
    for (const blueprint of operation.blueprints) {
      proposedCountByNode.set(
        blueprint.curriculumNodeId,
        (proposedCountByNode.get(blueprint.curriculumNodeId) ?? 0) + 1,
      );
    }
    const knowledgeByNodeId = await args.repository.readCurriculumNodesKnowledgePoints({
      textbookId: args.aggregate.framework.textbookId,
      nodeIds: [...proposedCountByNode.keys()],
    });
    for (const [nodeId, proposedCount] of proposedCountByNode) {
      const recommendedCount = Math.max(
        0,
        ...(knowledgeByNodeId[nodeId]?.periodRecommendations ?? [])
          .map((item) => Number(item.periodNo))
          .filter((value) => Number.isInteger(value) && value > 0),
      );
      if (!recommendedCount) continue;
      const existingCount = args.aggregate.blueprints.filter((blueprint) => (
        blueprint.semesterUnitId === operation.unitId
        && blueprint.curriculumNodeId === nodeId
      )).length;
      if (existingCount + proposedCount < recommendedCount) {
        throw new WritePreflightError("blueprint_period_recommendation_mismatch");
      }
    }
  }
}

function requireLessonContext(context: PreparationAgentContext): LessonAgentContext {
  if (isSemesterFrameworkAgentContext(context)) {
    throw new WritePreflightError("lesson_context_required");
  }
  return context;
}

export async function validateLessonDesignProposalReferences(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  proposal: LessonDesignBasisPatchProposal;
}) {
  const evidence = await args.repository.listRunEvidence(
    args.context.userId,
    args.context.runId,
  );
  const observedSources = new Set(evidence.map((record) => record.source.id));
  const nodes = args.context.contextProfile.textbookId
    ? await args.repository.listCurriculumNodes({
        textbookId: args.context.contextProfile.textbookId,
        maxLevel: 8,
      })
    : [];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));

  for (const operation of args.proposal.operations) {
    if (operation.op !== "create_design_basis_entry") continue;
    if (
      operation.kind !== "knowledge_point"
      && operation.kind !== "review"
      && operation.kind !== "prepare"
    ) continue;

    if (!operation.evidenceSourceIds.length) {
      throw new LessonDesignBasisPatchError("design_basis_evidence_required");
    }
    if (operation.evidenceSourceIds.some((sourceId) => !observedSources.has(sourceId))) {
      throw new LessonDesignBasisPatchError("unobserved_design_basis_evidence");
    }

    const entity = operation.semanticEntityId
      ? await args.repository.getCurriculumSemanticEntity(operation.semanticEntityId)
      : null;
    if (!entity) throw new WritePreflightError("unknown_curriculum_entity");
    const entitySources = new Set(entity.sources.map((source) => source.id));
    if (!operation.evidenceSourceIds.some((sourceId) => entitySources.has(sourceId))) {
      throw new WritePreflightError("curriculum_evidence_mismatch");
    }

    if (operation.kind === "review" || operation.kind === "prepare") {
      const related = operation.relatedSemanticEntityId
        ? await args.repository.getCurriculumSemanticEntity(operation.relatedSemanticEntityId)
        : null;
      if (!related) throw new WritePreflightError("unknown_curriculum_entity");
      if (
        !operation.relatedCurriculumNodeId
        || !args.context.contextProfile.textbookId
        || !nodeIds.has(operation.relatedCurriculumNodeId)
      ) {
        throw new WritePreflightError("curriculum_node_scope_invalid");
      }
    }
  }
}

export function createDocumentPatchPreflight(
  repository: LessonRepository,
  options: { maxOperations?: number } = {},
): ToolInputGuardrailDefinition {
  return {
    type: "tool_input",
    name: "document_patch_business_preflight",
    run: async ({ context, toolCall }) => {
      try {
        const lessonContext = requireLessonContext(context.context as PreparationAgentContext);
        if (isCommittedApprovalReplay(lessonContext, toolCall)) return allow();
        const proposal = documentPatchToolSchema.parse(parseArguments(toolCall.arguments));
        if (
          options.maxOperations !== undefined
          && proposal.operations.length > options.maxOperations
        ) {
          throw new WritePreflightError("too_many_document_operations");
        }
        const file = await repository.getLessonFile(
          lessonContext.userId,
          lessonContext.lessonFileId,
        );
        if (!file) throw new WritePreflightError("lesson_file_not_found");
        if (file.documentVersion !== lessonContext.documentVersion) {
          throw new WritePreflightError("document_context_stale");
        }
        const patch = materializeDocumentPatchProposal({
          proposal,
          fileId: file.id,
          documentVersion: file.documentVersion,
          plan: file.document,
        });
        applyDocumentPatch(file.document, patch);
        return allow();
      } catch (error) {
        return reject(error);
      }
    },
  };
}

export function createLessonDesignChangePreflight(
  repository: LessonRepository,
): ToolInputGuardrailDefinition {
  return {
    type: "tool_input",
    name: "lesson_design_change_business_preflight",
    run: async ({ context, toolCall }) => {
      try {
        const lessonContext = requireLessonContext(context.context as PreparationAgentContext);
        if (isCommittedApprovalReplay(lessonContext, toolCall)) return allow();
        const proposal = lessonDesignChangeToolSchema.parse(parseArguments(toolCall.arguments));
        const [file, aggregate, observedEvidence] = await Promise.all([
          repository.getLessonFile(lessonContext.userId, lessonContext.lessonFileId),
          repository.getLessonDesignBasis(lessonContext.userId, lessonContext.lessonFileId),
          repository.listRunEvidence(lessonContext.userId, lessonContext.runId),
        ]);
        if (!file) throw new WritePreflightError("lesson_file_not_found");
        if (!aggregate) throw new WritePreflightError("lesson_design_basis_not_found");
        if (file.documentVersion !== lessonContext.documentVersion) {
          throw new WritePreflightError("document_context_stale");
        }
        if (aggregate.basis.version !== lessonContext.designBasisVersion) {
          throw new WritePreflightError("design_basis_context_stale");
        }
        await validateLessonDesignProposalReferences({
          repository,
          context: lessonContext,
          proposal: { summary: proposal.summary, operations: proposal.designBasisOperations },
        });
        materializeLessonDesignChange({ proposal, aggregate, file, observedEvidence });
        return allow();
      } catch (error) {
        return reject(error);
      }
    },
  };
}

export function createDesignBasisProjectionPreflight(
  repository: LessonRepository,
): ToolInputGuardrailDefinition {
  return {
    type: "tool_input",
    name: "design_basis_projection_business_preflight",
    run: async ({ context, toolCall }) => {
      try {
        const lessonContext = requireLessonContext(context.context as PreparationAgentContext);
        if (isCommittedApprovalReplay(lessonContext, toolCall)) return allow();
        const proposal = designBasisProjectionToolSchema.parse(parseArguments(toolCall.arguments));
        const [file, aggregate] = await Promise.all([
          repository.getLessonFile(lessonContext.userId, lessonContext.lessonFileId),
          repository.getLessonDesignBasis(lessonContext.userId, lessonContext.lessonFileId),
        ]);
        if (!file) throw new WritePreflightError("lesson_file_not_found");
        if (!aggregate) throw new WritePreflightError("lesson_design_basis_not_found");
        if (file.documentVersion !== lessonContext.documentVersion) {
          throw new WritePreflightError("document_context_stale");
        }
        if (aggregate.basis.version !== lessonContext.designBasisVersion) {
          throw new WritePreflightError("design_basis_context_stale");
        }
        materializeDesignBasisProjection({ proposal, aggregate, file });
        return allow();
      } catch (error) {
        return reject(error);
      }
    },
  };
}

export function createDesignBasisPatchPreflight(
  repository: LessonRepository,
): ToolInputGuardrailDefinition {
  return {
    type: "tool_input",
    name: "design_basis_patch_business_preflight",
    run: async ({ context, toolCall }) => {
      try {
        const lessonContext = requireLessonContext(context.context as PreparationAgentContext);
        if (isCommittedApprovalReplay(lessonContext, toolCall)) return allow();
        const proposal = lessonDesignBasisPatchToolSchema.parse(parseArguments(toolCall.arguments));
        const [aggregate, observedEvidence] = await Promise.all([
          repository.getLessonDesignBasis(lessonContext.userId, lessonContext.lessonFileId),
          repository.listRunEvidence(lessonContext.userId, lessonContext.runId),
        ]);
        if (!aggregate) throw new WritePreflightError("lesson_design_basis_not_found");
        if (aggregate.basis.version !== lessonContext.designBasisVersion) {
          throw new WritePreflightError("design_basis_context_stale");
        }
        await validateLessonDesignProposalReferences({ repository, context: lessonContext, proposal });
        materializeLessonDesignBasisPatch({ proposal, aggregate, observedEvidence });
        return allow();
      } catch (error) {
        return reject(error);
      }
    },
  };
}

export function createSemesterFrameworkPatchPreflight(
  repository: LessonRepository,
  options: { maxOperations?: number } = {},
): ToolInputGuardrailDefinition {
  return {
    type: "tool_input",
    name: "semester_framework_patch_business_preflight",
    run: async ({ context, toolCall }) => {
      try {
        const frameworkContext = context.context as PreparationAgentContext;
        if (isCommittedApprovalReplay(frameworkContext, toolCall)) return allow();
        if (!isSemesterFrameworkAgentContext(frameworkContext)) {
          throw new WritePreflightError("semester_framework_context_required");
        }
        const proposal = semesterFrameworkPatchToolSchema.parse(parseArguments(toolCall.arguments));
        if (
          options.maxOperations !== undefined
          && proposal.operations.length > options.maxOperations
        ) {
          throw new WritePreflightError("too_many_framework_operations");
        }
        const aggregate = await repository.getSemesterFramework(
          frameworkContext.userId,
          frameworkContext.semesterFrameworkId,
        );
        if (!aggregate) throw new WritePreflightError("semester_framework_not_found");
        if (aggregate.framework.version !== frameworkContext.frameworkVersion) {
          throw new WritePreflightError("resource_context_stale");
        }
        await validateBlueprintCurriculumBindings({ repository, aggregate, proposal });
        materializeSemesterFrameworkPatch({ proposal, aggregate });
        return allow();
      } catch (error) {
        return reject(error);
      }
    },
  };
}
