import {
  RunContext,
  Runner,
  RunState,
  type Agent,
  type AgentInputItem,
  type ModelProvider,
  type RunStreamEvent,
  type RunToolApprovalItem,
} from "@openai/agents";
import { z } from "zod";
import {
  isSemesterFrameworkAgentContext,
  isLessonDesignChangePatch,
  isLessonDesignBasisPatch,
  isSemesterFrameworkPatch,
} from "../domain.js";
import {
  applyDocumentPatch,
  DocumentPatchError,
  materializeDocumentPatchProposal,
} from "../document-patch.js";
import {
  interruptedTurnContextItem,
  protocolSafeSessionHistory,
  selectCompactionBatch,
  selectProtocolSafeSessionHistory,
  sessionHistoryIncludesMessage,
  threadMemorySummaryItem,
  durableSessionHistoryItems,
  recoverableFailedRunItems,
} from "./session-history.js";
import type {
  AgentMessageRecord,
  CapabilityPlan,
  DocumentPatch,
  PreparationAgentContext,
  LessonAgentContext,
  LessonAgentSelection,
  NormalizedAgentEvent,
  ResourcePatch,
  SourceRef,
} from "../domain.js";
import {
  designBasisProjectionToolSchema,
  documentPatchToolSchema,
  lessonDesignChangeToolSchema,
  lessonDesignBasisPatchToolSchema,
  semesterFrameworkPatchToolSchema,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { RepositorySession } from "../repository.js";
import { decryptRunState, encryptRunState } from "../security/state-crypto.js";
import { routeCapabilities } from "./capability-router.js";
import {
  DeepSeekModelProvider,
  deepSeekModels,
  requestDeepSeekFlashText,
} from "./deepseek-provider.js";
import { assertCurrentDocumentVersion } from "./document-version.js";
import { agentDefinitionVersion, createManager } from "./manager.js";
import { SkillRegistry } from "./skill-registry.js";
import { extractSources } from "./source-extraction.js";
import { publicAgentError } from "./public-error.js";
import { safeToolPresentation, type SafeToolPresentation } from "./tool-presentation.js";
import {
  toolCompletionLabelForOutcome,
  toolCompletionOutcomeOf,
} from "./tool-completion-outcome.js";
import { bindPatchToObservedEvidence } from "./evidence.js";
import { validateObservedEvidence } from "./output-guardrails.js";
import { materializeSemesterFrameworkPatch } from "../semester-framework-patch.js";
import { resolveScopedWritebackFeedbackId } from "../curriculum/continuity-adoption.js";
import { materializeLessonDesignBasisPatch } from "../lesson-design-basis-patch.js";
import {
  DesignBasisProjectionError,
  materializeDesignBasisProjection,
} from "../design-basis-projection.js";
import { materializeLessonDesignChange } from "../lesson-design-change.js";
import { validateLessonDesignProposalReferences } from "./write-preflight.js";
import { predictLessonSemanticQuality } from "./semantic-quality.js";

type Emit = (event: NormalizedAgentEvent) => void | Promise<void>;

const threadMemorySummarySchema = z.object({
  summary: z.string().max(12_000),
  decisions: z.array(z.string().max(2_000)).max(100),
  sources: z.array(z.string().max(2_000)).max(100),
  unresolved: z.array(z.string().max(2_000)).max(100),
  rejected: z.array(z.string().max(2_000)).max(100),
});

const continuationMessagePattern = /^(?:继续|继续吧|接着|接着来|接着做|继续完成|从刚才继续|沿用刚才的分析|按刚才的继续)(?:[。！!\s]*)$/;

export function buildLessonAgentInput(
  message: string,
  context: Pick<LessonAgentContext, "activeSectionId" | "documentVersion" | "selection">,
  attachments: SourceRef[],
) {
  const confirmsPriorProposal = /^(?:确认|可以|同意|按(?:这个|上述|刚才的?)做|就(?:这样|按这个)|执行)(?:了|吧|即可|修改)?[。！!\s]*$/
    .test(message.trim());
  const continuesPriorTurn = continuationMessagePattern.test(message.trim());
  const selection = context.selection
    ? `\n当前选区：字段 ${context.selection.field}，绝对偏移 ${context.selection.start}-${context.selection.end}，文本：${JSON.stringify(context.selection.text)}`
    : "";
  return [
    "工作范围：当前整份教案",
    `当前焦点栏目：${context.activeSectionId}`,
    `当前文档版本：${context.documentVersion}`,
    selection,
    attachments.length
      ? [
          "本轮已验证的随消息附件资源：",
          ...attachments.map((attachment) => `- ${attachment.title}（sourceId: ${attachment.id}）`),
          "附件是本轮输入的一部分。根据教师问题决定读取范围；凡是引用、概括、比较或判断附件内容，必须先调用 read_attached_source 取得直接证据。不要用泛化搜索替代指定附件。",
        ].join("\n")
      : "本轮没有随消息附带资料。",
    confirmsPriorProposal
      ? "当前消息可能是在接受上一轮的具体修改方案。若紧邻的上一轮确有待执行方案，直接调用审批工具，不要再次复述方案或再次询问确认；当前资源版本与已有读取结果一致时直接复用，只有版本变化、读取不完整或本轮证据绑定要求存在时才做最小必要复核。若上一轮没有具体待执行方案，则按普通对话回应。"
      : "",
    continuesPriorTurn
      ? "当前消息是在继续上一轮。继承会话中已经形成的目标、分析、完整工具结果和未完成草稿，不要无条件从头重做；仅在资源版本变化、工具结果不完整，或本轮写入/证据绑定确有要求时，做最小范围复核。"
      : "",
    "教师消息：",
    message,
  ].join("\n");
}

export function buildSemesterFrameworkAgentInput(
  message: string,
  context: Pick<
    Extract<PreparationAgentContext, { resourceType: "semester_framework" }>,
    "frameworkVersion" | "activeUnitId"
  >,
) {
  const continuesPriorTurn = continuationMessagePattern.test(message.trim());
  return [
    "工作范围：当前学期教学框架",
    `当前框架版本：${context.frameworkVersion}`,
    context.activeUnitId
      ? `当前界面聚焦单元 ID：${context.activeUnitId}。它只是教师当前查看位置，不代表问题只能回答这个单元。`
      : "当前界面没有聚焦到特定单元。",
    continuesPriorTurn
      ? "当前消息是在继续上一轮。继承会话中已经形成的目标、分析、完整工具结果和未完成草稿；若框架版本未变，不要重新进行整框架读取和整套分析。写入前只复核实际目标字段，版本变化时再读取最新框架。"
      : "按当前问题需要读取框架；不要根据不存在的内容猜测当前框架，但也不要重复读取本轮或会话中同版本、仍完整可用的工具结果。",
    "教师消息：",
    message,
  ].join("\n");
}

type ActiveRun = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

const RUN_LEASE_MS = 30_000;
const RUN_HEARTBEAT_MS = 8_000;

function mergeContinuationPlan(
  current: CapabilityPlan,
  previous: CapabilityPlan | undefined,
  hasCurrentAttachments: boolean,
): CapabilityPlan {
  if (!previous) return current;
  const requiredEvidenceKinds = [...new Set([
    ...(previous.requiredEvidenceKinds ?? []),
    ...(current.requiredEvidenceKinds ?? []),
  ])].filter((kind) => hasCurrentAttachments || kind !== "attachment_read");
  return {
    skillIds: [...new Set([...previous.skillIds, ...current.skillIds])].slice(0, 3),
    toolGroups: [...new Set([...previous.toolGroups, ...current.toolGroups])].slice(0, 2),
    mcpServers: [...new Set([...previous.mcpServers, ...current.mcpServers])].slice(0, 2),
    specialistAgents: [...new Set([
      ...previous.specialistAgents,
      ...current.specialistAgents,
    ])].slice(0, 3),
    evidenceRequired: previous.evidenceRequired || current.evidenceRequired,
    writeMode: current.writeMode === "open" || !current.writeMode
      ? previous.writeMode ?? current.writeMode ?? "open"
      : current.writeMode,
    designBasisRequested: previous.designBasisRequested
      || current.designBasisRequested
      || false,
    designBasisWriteRequested: previous.designBasisWriteRequested
      || current.designBasisWriteRequested
      || false,
    minimalWriteRequested: previous.minimalWriteRequested
      || current.minimalWriteRequested
      || false,
    fullRewriteRequested: previous.fullRewriteRequested
      || current.fullRewriteRequested
      || false,
    classroomActionRequired: previous.classroomActionRequired
      || current.classroomActionRequired
      || false,
    continuityRequested: previous.continuityRequested
      || current.continuityRequested
      || Boolean(current.continuityWritebackFeedbackId)
      || Boolean(previous.continuityWritebackFeedbackId)
      || false,
    continuityWritebackFeedbackId: current.continuityWritebackFeedbackId
      ?? previous.continuityWritebackFeedbackId,
    requiredEvidenceKinds: requiredEvidenceKinds.length ? requiredEvidenceKinds : undefined,
  };
}

type StartRunInput = {
  userId: string;
  threadId: string;
  branchId: string;
  message: string;
  activeSectionId: string;
  activeUnitId?: string;
  documentVersion: number;
  selection?: LessonAgentSelection;
  attachmentIds: string[];
};

const callIdOf = (event: RunStreamEvent) => {
  if (event.type !== "run_item_stream_event") return undefined;
  const rawItem = event.item.rawItem as { callId?: string; call_id?: string; id?: string } | undefined;
  return rawItem?.callId ?? rawItem?.call_id ?? rawItem?.id;
};

const toolArgumentsOf = (event: RunStreamEvent) => {
  if (event.type !== "run_item_stream_event") return undefined;
  const rawItem = event.item.rawItem as { arguments?: unknown } | undefined;
  return rawItem?.arguments;
};

const toolNameOf = (event: RunStreamEvent) => {
  if (event.type !== "run_item_stream_event") return undefined;
  const rawItem = event.item.rawItem as { name?: string } | undefined;
  return rawItem?.name ?? ("name" in event.item ? String(event.item.name) : undefined);
};

export const toolOutputSucceeded = (event: RunStreamEvent) => {
  if (event.type !== "run_item_stream_event" || event.name !== "tool_output") return false;
  const item = event.item as {
    output?: unknown;
    customData?: { isError?: boolean };
    rawItem?: { output?: unknown; customData?: { isError?: boolean } };
  };
  const output = item.output ?? item.rawItem?.output;
  if (item.customData?.isError || item.rawItem?.customData?.isError) return false;
  if (typeof output === "string" && /^(?:error|aborted|cancelled)(?::|$)/i.test(output.trim())) {
    return false;
  }
  if (proposalRevisionCodeOf(output)) return false;
  return true;
};

const proposalRevisionGuidanceCodes: Array<[needle: string, code: string]> = [
  ["教案快照已经变化", "document_context_stale"],
  ["设计依据已经变化", "design_basis_context_stale"],
  ["学期框架快照已经变化", "resource_context_stale"],
  ["局部修改引用的原文在栏目中出现了多次", "patch_target_ambiguous"],
  ["提案没有产生实际变化", "no_effect_patch"],
  ["完整教案的语义质量预检未通过", "semantic_quality_rejected"],
];

export const proposalRevisionCodeOf = (output: unknown) => {
  if (typeof output === "string" && output.startsWith("【提案需调整】")) {
    const matched = proposalRevisionGuidanceCodes.find(([needle]) => output.includes(needle));
    if (matched) return matched[1];
    return "proposal_needs_revision";
  }
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    if (
      parsed
      && typeof parsed === "object"
      && "status" in parsed
      && parsed.status === "proposal_needs_revision"
      && "code" in parsed
      && typeof parsed.code === "string"
    ) return parsed.code;
  } catch {
    // Ordinary text tool output has no structured proposal revision code.
  }
  return undefined;
};

export class LessonAgentHarness {
  private readonly modelProvider: ModelProvider;
  private readonly runner: Runner;
  private readonly registry = new SkillRegistry();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly memoryCompactions = new Map<string, Promise<void>>();
  private readonly memoryCompactionRetryAfter = new Map<string, number>();
  private ready: Promise<SkillRegistry>;

  constructor(
    private readonly repository: LessonRepository,
    options: { modelProvider?: ModelProvider } = {},
  ) {
    this.modelProvider = options.modelProvider ?? new DeepSeekModelProvider();
    this.runner = new Runner({
      modelProvider: this.modelProvider,
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
      workflowName: "LessonUp lesson preparation",
      toolNotFoundBehavior: "return_error_to_model",
      toolExecution: { preApprovalInputGuardrails: true },
      reasoningItemIdPolicy: "omit",
    });
    this.ready = this.registry.load();
  }

  private registerActiveRun(key: string, controller: AbortController) {
    if (this.activeRuns.has(key)) throw new Error("active_run_exists");
    let settle = () => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.activeRuns.set(key, { controller, settled, settle });
  }

  private settleActiveRun(key: string) {
    const active = this.activeRuns.get(key);
    active?.settle();
    this.activeRuns.delete(key);
  }

  async cancel(userId: string, runId: string) {
    const active = this.activeRuns.get(`${userId}:${runId}`);
    const requested = await this.repository.requestRunCancellation(userId, runId)
      .catch(() => false);
    if (active) {
      active.controller.abort("user_cancelled");
      await active.settled;
    } else if (requested) {
      await this.repository.recoverExpiredRuns(userId).catch(() => undefined);
    }
    return requested;
  }

  private async startRunHeartbeat(args: {
    userId: string;
    runId: string;
    leaseToken: string;
    controller: AbortController;
  }) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight: Promise<void> = Promise.resolve();
    const heartbeat = async () => {
      const run = await this.repository.heartbeatRun({
        ownerId: args.userId,
        runId: args.runId,
        leaseToken: args.leaseToken,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
      });
      if (run.cancelRequestedAt && !args.controller.signal.aborted) {
        args.controller.abort("user_cancelled");
      }
    };
    await heartbeat();
    timer = setInterval(() => {
      inFlight = heartbeat().catch((error) => {
        if (!args.controller.signal.aborted) {
          args.controller.abort(error instanceof Error ? error.message : "run_lease_lost");
        }
      });
    }, RUN_HEARTBEAT_MS);
    return async () => {
      if (timer) clearInterval(timer);
      await inFlight.catch(() => undefined);
    };
  }

  private async createContext(args: {
    userId: string;
    threadId: string;
    branchId: string;
    runId: string;
    activeSectionId: string;
    activeUnitId?: string;
    selection?: LessonAgentSelection;
    expectedDocumentVersion?: number;
    attachmentSourceIds?: string[];
    signal: AbortSignal;
  }): Promise<PreparationAgentContext> {
    const thread = await this.repository.getThread(args.userId, args.threadId);
    const branch = await this.repository.getBranch(args.userId, args.threadId, args.branchId);
    if (!thread || !branch) throw new Error("thread_scope_invalid");
    if (thread.resourceType === "semester_framework") {
      if (args.selection || (args.attachmentSourceIds?.length ?? 0) > 0) {
        throw new Error("semester_framework_input_scope_invalid");
      }
      const aggregate = await this.repository.getSemesterFramework(
        args.userId,
        thread.semesterFrameworkId,
      );
      if (!aggregate || aggregate.framework.notebookId !== thread.notebookId) {
        throw new Error("semester_framework_scope_invalid");
      }
      if (
        args.expectedDocumentVersion !== undefined
        && aggregate.framework.version !== args.expectedDocumentVersion
      ) {
        throw new Error("resource_context_stale");
      }
      if (args.activeUnitId && !aggregate.units.some((unit) => unit.id === args.activeUnitId)) {
        throw new Error("semester_framework_scope_invalid");
      }
      return {
        resourceType: "semester_framework",
        userId: args.userId,
        notebookId: thread.notebookId,
        semesterFrameworkId: thread.semesterFrameworkId,
        threadId: thread.id,
        branchId: branch.id,
        runId: args.runId,
        frameworkVersion: aggregate.framework.version,
        activeUnitId: args.activeUnitId,
        contextProfile: aggregate.framework.contextProfile,
        allowedKnowledgeScopes: [
          "public",
          `user:${args.userId}`,
          `notebook:${thread.notebookId}`,
        ],
        attachmentSourceIds: [],
        abortSignal: args.signal,
      };
    }

    const [file, designBasis] = await Promise.all([
      this.repository.getLessonFile(args.userId, thread.lessonFileId),
      this.repository.getLessonDesignBasis(args.userId, thread.lessonFileId),
    ]);
    if (
      !file
      || file.notebookId !== thread.notebookId
      || !designBasis
      || designBasis.basis.notebookId !== thread.notebookId
    ) throw new Error("lesson_scope_invalid");
    assertCurrentDocumentVersion(file.documentVersion, args.expectedDocumentVersion);
    return {
      resourceType: "lesson_file",
      userId: args.userId,
      notebookId: thread.notebookId,
      lessonFileId: thread.lessonFileId,
      threadId: thread.id,
      branchId: branch.id,
      runId: args.runId,
      activeSectionId: args.activeSectionId,
      selection: args.selection,
      documentVersion: file.documentVersion,
      designBasisVersion: designBasis.basis.version,
      contextProfile: file.contextProfile,
      allowedKnowledgeScopes: [
        "public",
        `user:${args.userId}`,
        `notebook:${thread.notebookId}`,
        `file:${thread.lessonFileId}`,
      ],
      attachmentSourceIds: args.attachmentSourceIds ?? [],
      abortSignal: args.signal,
    };
  }

  private async repairSessionHistory(userId: string, threadId: string, branchId: string) {
    const itemCount = await this.repository.getSessionItemCount(userId, threadId, branchId);
    if (!itemCount) return { length: 0 };
    const tailStart = Math.max(0, itemCount - 96);
    const tail = await this.repository.getSessionItemsAfter(
      userId,
      threadId,
      branchId,
      tailStart,
    );
    const tailStartsInsideProtocolUnit = tailStart > 0
      && ["function_call", "function_call_result"].includes(
        (tail[0] as { type?: string } | undefined)?.type ?? "",
      );
    const safeTail = protocolSafeSessionHistory(tail);
    if (
      !tailStartsInsideProtocolUnit
      && JSON.stringify(safeTail) === JSON.stringify(tail)
    ) {
      return { length: itemCount };
    }
    const history = await this.repository.getSessionItems(userId, threadId, branchId);
    const safeHistory = protocolSafeSessionHistory(history);
    if (JSON.stringify(safeHistory) !== JSON.stringify(history)) {
      await this.repository.replaceSessionItems(userId, threadId, branchId, safeHistory);
    }
    return { length: safeHistory.length };
  }

  private async preserveInterruptedTurnContext(args: {
    userId: string;
    threadId: string;
    branchId: string;
    runId: string;
    sessionLengthBeforeRun: number;
    userContent: string;
    assistantContent?: string;
    error: string;
  }) {
    const repaired = await this.repairSessionHistory(
      args.userId,
      args.threadId,
      args.branchId,
    );
    const turnHistory = await this.repository.getSessionItemsAfter(
      args.userId,
      args.threadId,
      args.branchId,
      Math.min(args.sessionLengthBeforeRun, repaired.length),
      96,
    );
    const additions: AgentInputItem[] = [];
    if (!sessionHistoryIncludesMessage({
      history: turnHistory,
      role: "user",
      content: args.userContent,
    })) {
      additions.push({
        type: "message",
        role: "user",
        content: args.userContent,
      } as AgentInputItem);
    }
    const contentAlreadyInHistory = Boolean(args.assistantContent?.trim())
      && sessionHistoryIncludesMessage({
        history: turnHistory,
        role: "assistant",
        content: args.assistantContent ?? "",
      });
    additions.push(interruptedTurnContextItem({
      content: args.assistantContent,
      error: args.error,
      contentAlreadyInHistory,
    }));
    await this.repository.addSessionItems(
      args.userId,
      args.threadId,
      args.branchId,
      additions,
      `interrupted:${args.runId}`,
    );
    return this.repairSessionHistory(args.userId, args.threadId, args.branchId);
  }

  private buildInput(
    message: string,
    context: PreparationAgentContext,
    attachments: SourceRef[],
    plan: CapabilityPlan,
  ) {
    const baseInput = isSemesterFrameworkAgentContext(context)
      ? buildSemesterFrameworkAgentInput(message, context)
      : buildLessonAgentInput(message, context, attachments);
    const executionBoundary = plan.writeMode === "explicit"
      ? isSemesterFrameworkAgentContext(context)
        ? plan.minimalWriteRequested
          ? "本轮只修改当前聚焦单元第一个已有课时蓝图中最影响实施的一处内容。必须结合框架中的课时分钟和班级情境，在同一处表述中写清教师动作、学生任务、可观察产出和达成证据，并区分教材依据与本班教学取舍；随后直接生成一次框架修改确认项，不再次询问。"
          : "本轮明确要求修改学期框架。完成必要读取后直接生成一次框架修改确认项；不要用正文草案替代确认项，也不要再次口头询问是否提交。"
        : plan.designBasisWriteRequested
          ? "本轮明确要求维护结构化设计依据。只生成一次必要的修改确认项；不要拆成连续审批，也不要向教师展示工具名、参数名、校验码或内部重试过程。"
          : plan.fullRewriteRequested
            ? plan.designBasisRequested
              ? "本轮要求基于上游备课上下文完整生成 A4 教案。先读取当前整份教案、教学情境、一次教案设计依据和一次当前章节知识点；使用设计依据中已经限定到本课的单元目标、课时蓝图、教学衔接候选和同单元前序课堂反馈，不另行遍历教材或开放搜索，也不再重复读取课堂反馈工具。重点知识、目标、活动、学生产出、评价和必要的复习/铺垫必须彼此对应；前序薄弱衔接要落到具体任务或证据。随后直接生成一次整栏修改确认项，不要先展示草案或询问是否继续。"
              : "本轮要求整份重编 A4 教案。只读取当前整份教案、教学情境、当前章节已发布知识点，以及一次本课/前序课堂反馈（若有）；当前章节知识点工具不需要参数，最多调用一次。不要扩展为教材目录遍历、前后衔接检索、专业 Agent 审查或开放式资料搜索。随后只提交实际发生变化的栏目，直接生成一次整栏修改确认项，不要先展示草案或询问是否继续。"
            : plan.minimalWriteRequested
              ? "本轮只允许一处最小修改。只调用一次 read_document 读取必要栏目，再调用一次无需参数的 read_curriculum_knowledge_points 核对当前课题；随后下一次工具调用必须是 propose_document_patch。选择对教师目标影响最大的一处，只提交一个栏目操作并直接生成一次确认项；不要检索其他教材或设计依据，不要顺带修改其他栏目。"
              : "本轮明确要求修改 A4 教案。完成必要读取后直接生成一次教案修改确认项；知识点、教学依据、学生困难和评价证据直接写入合适栏目，不要先建立结构化设计依据，不要再次口头询问是否提交，也不要展示工具名、参数名、校验码或内部重试过程。"
      : plan.writeMode === "consultative"
        ? "本轮只做分析和建议，不生成修改确认项。"
        : "";
    const actionBoundary = plan.classroomActionRequired
      ? "教师明确需要可执行的课堂调整。最终回答或修改必须至少包含一组完整闭环：教师怎样做、学生完成什么任务、产生什么可观察结果或评价证据；本轮直接给出，不要以‘是否需要继续展开’结尾。"
      : "";
    const continuityBoundary = isSemesterFrameworkAgentContext(context)
      && plan.continuityRequested
      ? "本轮涉及学期、单元、课时蓝图规划或课堂反馈回写。提出规划前必须读取目标单元的教材章节、章节课时建议和教学衔接候选；若任务涉及后续课时调整，还要读取课堂反馈。一个蓝图只能代表一节真实课堂；使用蓝图自身 plannedMinutes（默认继承框架课时制、允许教师在 20–60 分钟内调整），不能把章节总分钟写成单课时，后续生成教案也必须沿用该蓝图时长。用 curriculumNodeId + chapterPeriodNo 表示同一章节第 1、第 2……课时：已有同课次会被更新，缺少课次才新增。教师只说补充时保留已有课次；教师明确说按当前建议重新调整、对齐或重建时，还要显式删除超出建议且不再需要的旧课次，不要把调整结果叠加成重复蓝图，也不要凭模糊措辞删除教师额外课次。让前一课时的学生产出成为后一课时起点。已审核关系可作为明确依据；词法召回只用于发现待判断关联，必须结合单元目标、教材顺序和本班学情取舍。选中的复习或铺垫不能停留在标签或说明里，要落实到某一课时的主要活动、学生可观察产出或达成证据；没有合适候选时如实跳过，不要硬塞。对偏弱或未落实的衔接效果，优先按反馈工具给出的同单元下一课时建议提出一次蓝图修改确认，不要静默写入。"
      : "";
    return [baseInput, executionBoundary, actionBoundary, continuityBoundary]
      .filter(Boolean)
      .join("\n");
  }

  private async titleFor(message: string) {
    try {
      const title = await requestDeepSeekFlashText({
        instructions: "为备课对话生成不超过14个汉字的标题。只输出标题，不加引号和标点。",
        input: message.slice(0, 2_000),
        temperature: 0,
        maxOutputTokens: 128,
        signal: AbortSignal.timeout(5_000),
      });
      return title.slice(0, 28) || message.slice(0, 14);
    } catch {
      return message.replace(/\s+/g, " ").trim().slice(0, 14) || "新会话";
    }
  }

  private createSessionHistoryLoader(
    context: PreparationAgentContext,
    phaseMetrics?: Record<string, number>,
  ) {
    return async () => {
      const startedAt = performance.now();
      const keepRecentItems = 24;
      const [storedMemory, itemCount] = await Promise.all([
        this.repository.getThreadMemory(
          context.userId,
          context.threadId,
          context.branchId,
        ),
        this.repository.getSessionItemCount(
          context.userId,
          context.threadId,
          context.branchId,
        ),
      ]);
      const memory = storedMemory && storedMemory.cursor <= itemCount
        ? storedMemory
        : null;
      const history = await this.repository.getSessionItemsAfter(
        context.userId,
        context.threadId,
        context.branchId,
        memory?.cursor ?? 0,
        96,
      );
      const selected = selectProtocolSafeSessionHistory({
        history,
        current: [],
        summary: memory?.summary,
        keepRecentItems,
      });
      const summaryItem = memory?.summary
        ? [threadMemorySummaryItem(memory.summary)]
        : [];
      if (phaseMetrics) {
        phaseMetrics.sessionLoadMs = Math.round(
          (phaseMetrics.sessionLoadMs ?? 0) + performance.now() - startedAt,
        );
        phaseMetrics.sessionStoredItems = itemCount;
        phaseMetrics.sessionSelectedItems = selected.length;
        phaseMetrics.memoryCursor = memory?.cursor ?? 0;
      }
      return [...summaryItem, ...selected];
    };
  }

  private scheduleThreadMemoryCompaction(context: PreparationAgentContext) {
    const key = `${context.userId}:${context.threadId}:${context.branchId}`;
    if (
      this.memoryCompactions.has(key)
      || (this.memoryCompactionRetryAfter.get(key) ?? 0) > Date.now()
    ) return;
    const task = this.compactThreadMemory(context)
      .then(() => {
        this.memoryCompactionRetryAfter.delete(key);
      })
      .catch((error) => {
        this.memoryCompactionRetryAfter.set(key, Date.now() + 60_000);
        console.warn("Agent session memory compaction failed", {
          threadId: context.threadId,
          branchId: context.branchId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      })
      .finally(() => this.memoryCompactions.delete(key));
    this.memoryCompactions.set(key, task);
  }

  private async compactThreadMemory(context: PreparationAgentContext) {
    const keepRecentItems = 24;
    const history = durableSessionHistoryItems(
      await this.repository.getSessionItems(
        context.userId,
        context.threadId,
        context.branchId,
      ),
    );
    const memory = await this.repository.getThreadMemory(
      context.userId,
      context.threadId,
      context.branchId,
    );
    const batch = selectCompactionBatch({
      history,
      startCursor: memory?.cursor ?? 0,
      endCursor: Math.max(0, history.length - keepRecentItems),
    });
    if (!batch.items.length || batch.endCursor <= (memory?.cursor ?? 0)) return;

    const rawSummary = await requestDeepSeekFlashText({
      temperature: 0,
      maxOutputTokens: 1_600,
      json: true,
      instructions: [
        "压缩备课对话为结构化 JSON。",
        "仅保留教师意图、已确认事实、已做决策、引用来源、未解决事项和被拒绝建议。",
        "不得补写原对话不存在的信息，不得包含内部推理。",
        "如果提供了此前摘要，必须把仍然有效的内容合并进新摘要，不能只总结新增片段。",
        "输出键：summary, decisions, sources, unresolved, rejected。",
      ].join("\n"),
      input: [
        `此前摘要：${memory?.summary ?? "无"}`,
        `新增历史范围：${batch.startCursor}-${batch.endCursor}`,
        batch.serialized,
      ].join("\n"),
      signal: AbortSignal.timeout(8_000),
    });
    const parsedSummary = threadMemorySummarySchema.safeParse(JSON.parse(rawSummary));
    if (!parsedSummary.success) return;
    const [currentHistory, currentMemory] = await Promise.all([
      this.repository.getSessionItems(
        context.userId,
        context.threadId,
        context.branchId,
      ),
      this.repository.getThreadMemory(
        context.userId,
        context.threadId,
        context.branchId,
      ),
    ]);
    if (
      (currentMemory?.cursor ?? 0) >= batch.endCursor
      || JSON.stringify(currentHistory.slice(0, batch.endCursor))
        !== JSON.stringify(history.slice(0, batch.endCursor))
    ) {
      return;
    }
    await this.repository.saveThreadMemory(
      context.userId,
      context.threadId,
      context.branchId,
      JSON.stringify(parsedSummary.data),
      batch.endCursor,
    );
  }

  async start(input: StartRunInput, emit: Emit) {
    await this.ready;
    await this.repository.recoverExpiredRuns(input.userId, input.threadId);
    const existingThread = await this.repository.getThread(input.userId, input.threadId);
    if (!existingThread) throw new Error("thread_not_found");
    if (existingThread.status === "running" || existingThread.status === "awaiting_approval") {
      throw new Error("active_run_exists");
    }
    const previousRun = continuationMessagePattern.test(input.message.trim())
      ? await this.repository.getLatestRun(input.userId, input.threadId, input.branchId)
      : null;

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const leaseToken = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const activeRunKey = `${input.userId}:${runId}`;
    this.registerActiveRun(activeRunKey, controller);
    let close = async () => {};
    let stopHeartbeat = async () => {};
    let runCreated = false;
    let assistant: AgentMessageRecord | undefined;
    let userMessage: AgentMessageRecord | undefined;
    let sessionLengthBeforeRun = 0;
    let contextForMemory: PreparationAgentContext | undefined;
    const phaseMetrics: Record<string, number> = {};
    try {
      const contextStartedAt = performance.now();
      const context = await this.createContext({
        ...input,
        expectedDocumentVersion: input.documentVersion,
        attachmentSourceIds: input.attachmentIds,
        runId,
        signal: controller.signal,
      });
      phaseMetrics.contextLoadMs = Math.round(performance.now() - contextStartedAt);
      contextForMemory = context;
      await this.repository.createRun({
        id: runId, ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        model: deepSeekModels.flash, status: "queued",
        agentDefinitionVersion,
        assistantMessageId,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
        heartbeatAt: new Date().toISOString(),
      });
      runCreated = true;
      stopHeartbeat = await this.startRunHeartbeat({
        userId: input.userId,
        runId,
        leaseToken,
        controller,
      });
      await this.repository.updateThread(input.userId, input.threadId, { status: "running" });
      const existingSessionItems = await this.repairSessionHistory(
        input.userId,
        input.threadId,
        input.branchId,
      );
      sessionLengthBeforeRun = existingSessionItems.length;
      userMessage = await this.repository.appendMessage({
        ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        role: "user", content: input.message, status: "completed",
        sessionCursor: existingSessionItems.length + 1,
      });
      assistant = await this.repository.appendMessage({
        id: assistantMessageId,
        ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        role: "assistant", content: "", status: "streaming",
      });
      await emit({ type: "run.started", runId, threadId: input.threadId, branchId: input.branchId });
      const attachments = isSemesterFrameworkAgentContext(context)
        ? []
        : await this.repository.attachKnowledgeSources(
          input.userId,
          context.lessonFileId,
          userMessage.id,
          input.attachmentIds,
        );
      if (attachments.length) {
        await this.repository.updateMessage(input.userId, userMessage.id, { sources: attachments });
      }
      context.attachmentSourceIds = attachments.map((attachment) => attachment.id);

      if (existingThread.title === "新会话") {
        void this.titleFor(input.message).then(async (title) => {
          const thread = await this.repository.updateThread(input.userId, input.threadId, { title });
          await emit({ type: "thread.updated", runId, thread });
        }).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      const routingStartedAt = performance.now();
      let routedPlan;
      if (isSemesterFrameworkAgentContext(context)) {
        const currentFramework = await this.repository.getSemesterFramework(
          input.userId,
          context.semesterFrameworkId,
        );
        if (!currentFramework || currentFramework.framework.version !== context.frameworkVersion) {
          throw new Error("resource_context_stale");
        }
        routedPlan = await routeCapabilities(input.message, {
          signal: controller.signal,
          attachmentSourceIds: [],
        });
        routedPlan = {
          ...routedPlan,
          skillIds: [],
          specialistAgents: [],
        };
      } else {
        const [routingFile, routingDesignBasis] = await Promise.all([
          this.repository.getLessonFile(input.userId, context.lessonFileId),
          this.repository.getLessonDesignBasis(input.userId, context.lessonFileId),
        ]);
        if (!routingFile || routingFile.documentVersion !== context.documentVersion) {
          throw new Error("document_context_stale");
        }
        routedPlan = await routeCapabilities(input.message, {
          signal: controller.signal,
          document: routingFile.document,
          attachmentSourceIds: context.attachmentSourceIds,
          hasUpstreamPlanningContext: Boolean(
            routingDesignBasis?.basis.frameworkId
            || routingDesignBasis?.basis.lessonBlueprintId
            || routingDesignBasis?.entries.length,
          ),
        });
      }
      phaseMetrics.routingMs = Math.round(performance.now() - routingStartedAt);
      controller.signal.throwIfAborted();
      const continuedPlan = mergeContinuationPlan(
        routedPlan,
        previousRun?.status === "failed" || previousRun?.status === "cancelled"
          ? previousRun.capabilityPlan
          : undefined,
        attachments.length > 0,
      );
      let plan = attachments.length && !continuedPlan.mcpServers.includes("knowledge")
        ? {
            ...continuedPlan,
            mcpServers: [...continuedPlan.mcpServers, "knowledge"],
          }
        : continuedPlan;
      if (
        plan.continuityWritebackFeedbackId
        && isSemesterFrameworkAgentContext(context)
      ) {
        const feedbackRecords = await this.repository.listLessonClassFeedback(input.userId, {
          semesterFrameworkId: context.semesterFrameworkId,
        });
        const scopedFeedbackId = resolveScopedWritebackFeedbackId(
          plan.continuityWritebackFeedbackId,
          feedbackRecords,
          context.semesterFrameworkId,
        );
        if (scopedFeedbackId !== plan.continuityWritebackFeedbackId) {
          plan = {
            ...plan,
            continuityWritebackFeedbackId: scopedFeedbackId,
          };
        }
      }
      const skills = this.registry.resolve(plan.skillIds);
      const managerStartedAt = performance.now();
      const runtime = await createManager({
        repository: this.repository,
        context,
        plan,
        skills,
        modelProvider: this.modelProvider,
      });
      phaseMetrics.managerSetupMs = Math.round(performance.now() - managerStartedAt);
      close = runtime.close;
      controller.signal.throwIfAborted();
      await this.repository.updateRun(input.userId, runId, {
        status: "running",
        capabilityPlan: plan,
        attachmentSourceIds: context.attachmentSourceIds,
        skillVersions: Object.fromEntries(skills.map((skill) => [skill.id, skill.version])),
      });

      await this.streamRun({
        userId: input.userId,
        manager: runtime.manager,
        context,
        plan,
        assistant,
        input: this.buildInput(input.message, context, attachments, plan),
        sessionPersistenceKey: `run:${runId}`,
        runLeaseToken: leaseToken,
        interruptedTurnContext: {
          userContent: userMessage.content,
          sessionLengthBeforeRun,
        },
        phaseMetrics,
        emit,
      });
    } catch (error) {
      if (!runCreated) throw error;
      const internalError = error instanceof Error ? error.message : "";
      console.warn("Agent run failed before settlement", {
        runId,
        error: internalError.slice(0, 500),
      });
      if (
        (controller.signal.aborted && controller.signal.reason === "user_cancelled")
        || internalError === "run_cancel_requested"
      ) {
        const safeHistory = await this.preserveInterruptedTurnContext({
          userId: input.userId,
          threadId: input.threadId,
          branchId: input.branchId,
          runId,
          sessionLengthBeforeRun,
          userContent: userMessage?.content ?? input.message,
          assistantContent: assistant?.content,
          error: "run_cancelled",
        }).catch(() => ({ length: sessionLengthBeforeRun }));
        await this.repository.settleRun({
          ownerId: input.userId,
          runId,
          leaseToken,
          status: "cancelled",
          messageStatus: "cancelled",
          messageContent: assistant?.content,
          sessionCursor: safeHistory.length,
        }).catch(() => undefined);
        await emit({ type: "run.cancelled", runId });
        return;
      }
      if (
        (controller.signal.aborted && controller.signal.reason === "run_lease_lost")
        || internalError === "run_lease_lost"
      ) {
        await this.preserveInterruptedTurnContext({
          userId: input.userId,
          threadId: input.threadId,
          branchId: input.branchId,
          runId,
          sessionLengthBeforeRun,
          userContent: userMessage?.content ?? input.message,
          assistantContent: assistant?.content,
          error: "run_interrupted",
        }).catch(() => undefined);
        await this.repository.recoverExpiredRuns(input.userId, input.threadId).catch(() => undefined);
        const failedMessage = assistant
          ? await this.repository.updateMessage(input.userId, assistant.id, {
              content: assistant.content,
              status: "failed",
              error: "run_interrupted",
              sources: assistant.sources,
            }).catch(() => null)
          : null;
        await emit({
          type: "run.failed",
          runId,
          error: "run_interrupted",
          message: failedMessage ?? undefined,
        });
        return;
      }
      const message = publicAgentError(error);
      const safeHistory = await this.preserveInterruptedTurnContext({
        userId: input.userId,
        threadId: input.threadId,
        branchId: input.branchId,
        runId,
        sessionLengthBeforeRun,
        userContent: userMessage?.content ?? input.message,
        assistantContent: assistant?.content,
        error: message,
      }).catch(() => ({ length: sessionLengthBeforeRun }));
      await this.repository.settleRun({
        ownerId: input.userId,
        runId,
        leaseToken,
        status: "failed",
        error: message,
        messageStatus: "failed",
        messageContent: assistant?.content,
        messageSources: assistant?.sources,
        sessionCursor: safeHistory.length,
      }).catch(() => undefined);
      const failedMessage = assistant
        ? await this.repository.getMessage(input.userId, assistant.id).catch(() => null)
        : null;
      await emit({
        type: "run.failed",
        runId,
        error: message,
        message: failedMessage ?? undefined,
      });
    } finally {
      await stopHeartbeat();
      this.settleActiveRun(activeRunKey);
      await close();
      if (contextForMemory) {
        this.scheduleThreadMemoryCompaction(contextForMemory);
      }
    }
  }

  private async streamRun(args: {
    userId: string;
    manager: Agent<PreparationAgentContext>;
    context: PreparationAgentContext;
    plan: CapabilityPlan;
    assistant: AgentMessageRecord;
    input: string | RunState<PreparationAgentContext, Agent<PreparationAgentContext>>;
    sessionPersistenceKey: string;
    runLeaseToken?: string;
    interruptedTurnContext?: {
      userContent: string;
      sessionLengthBeforeRun: number;
    };
    phaseMetrics?: Record<string, number>;
    emit: Emit;
    continuation?: {
      approvalId: string;
      leaseToken: string;
    };
  }) {
    const runId = args.context.runId;
    const previousMetrics = (await this.repository.getRun(args.userId, runId))?.tokenUsage;
    const startedAt = performance.now();
    const phaseMetrics = args.phaseMetrics ?? {};
    let firstTokenMs: number | undefined;
    let toolCalls = 0;
    let content = args.assistant.content;
    // Approval continuations append to an existing assistant turn. The client
    // already owns that prefix, so only stream content produced by this run.
    let emittedContentLength = content.length;
    let evidenceMayBeReady = false;
    let liveOutputAllowed = !args.plan.evidenceRequired;
    const sources = new Map(
      (args.assistant.sources ?? []).map((source) => [source.id, source]),
    );
    const toolCallsById = new Map<string, { name: string; presentation: SafeToolPresentation }>();
    const currentSessionCursor = () => this.repository.getSessionItemCount(
      args.userId,
      args.context.threadId,
      args.context.branchId,
    );
    const result = await this.runner.run(args.manager, args.input, {
      stream: true,
      context: args.context,
      signal: args.context.abortSignal,
      session: new RepositorySession(
        this.repository, args.userId, args.context.threadId, args.context.branchId,
        args.sessionPersistenceKey,
        this.createSessionHistoryLoader(args.context, phaseMetrics),
      ),
      // Full lesson generation commonly uses one parallel evidence turn, one
      // synthesis turn and one proposal turn. Some providers emit one extra
      // deterministic read before proposing, and a recoverable preflight may
      // require one correction. Five turns bounds cost without terminating a
      // valid proposal immediately after its last read.
      maxTurns: args.plan.fullRewriteRequested ? 5 : 12,
    });
    const metrics = () => this.runMetrics(
      result,
      startedAt,
      firstTokenMs,
      toolCalls,
      previousMetrics,
      phaseMetrics,
    );
    const emitAvailableContent = async () => {
      if (!liveOutputAllowed && evidenceMayBeReady) {
        evidenceMayBeReady = false;
        const validation = validateObservedEvidence({
          plan: args.plan,
          evidence: await this.repository.listRunEvidence(args.userId, runId),
        });
        liveOutputAllowed = !validation.tripwireTriggered;
      }
      if (!liveOutputAllowed || emittedContentLength >= content.length) return;
      const delta = content.slice(emittedContentLength);
      emittedContentLength = content.length;
      await args.emit({ type: "message.delta", runId, delta });
    };
    const settleContinuation = async (
      outcome: "ready" | "paused" | "completed" | "cancelled",
      error?: string,
    ) => {
      if (!args.continuation) return;
      await this.repository.settleApprovalContinuation({
        ownerId: args.userId,
        approvalId: args.continuation.approvalId,
        leaseToken: args.continuation.leaseToken,
        outcome,
        assistantMessageId: args.assistant.id,
        content,
        sources: [...sources.values()],
        sessionCursor: await currentSessionCursor(),
        tokenUsage: metrics(),
        encryptedRunState: encryptRunState(result.state.toString()),
        error,
      });
    };
    const finishCancelled = async () => {
      await result.completed.catch(() => undefined);
      const safeHistory = args.interruptedTurnContext
        ? await this.preserveInterruptedTurnContext({
            userId: args.userId,
            threadId: args.context.threadId,
            branchId: args.context.branchId,
            runId,
            sessionLengthBeforeRun: args.interruptedTurnContext.sessionLengthBeforeRun,
            userContent: args.interruptedTurnContext.userContent,
            assistantContent: content,
            error: "run_cancelled",
          }).catch(() => ({ length: args.interruptedTurnContext!.sessionLengthBeforeRun }))
        : await this.repairSessionHistory(
            args.userId,
            args.context.threadId,
            args.context.branchId,
          ).catch(() => ({ length: 0 }));
      if (args.continuation) {
        await this.repository.settleApprovalContinuation({
          ownerId: args.userId,
          approvalId: args.continuation.approvalId,
          leaseToken: args.continuation.leaseToken,
          outcome: "cancelled",
          assistantMessageId: args.assistant.id,
          content,
          sources: [...sources.values()],
          sessionCursor: safeHistory.length,
          tokenUsage: metrics(),
          encryptedRunState: encryptRunState(result.state.toString()),
        });
      } else if (args.runLeaseToken) {
        await this.repository.settleRun({
          ownerId: args.userId,
          runId,
          leaseToken: args.runLeaseToken,
          status: "cancelled",
          tokenUsage: metrics(),
          messageStatus: "cancelled",
          messageContent: content,
          messageSources: [...sources.values()],
          sessionCursor: safeHistory.length,
        });
      }
      await args.emit({ type: "run.cancelled", runId });
    };

    try {
      for await (const event of result) {
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
          if (firstTokenMs === undefined) {
            firstTokenMs = performance.now() - startedAt;
          }
          content += event.data.delta;
          await emitAvailableContent();
          continue;
        }
        if (event.type !== "run_item_stream_event") continue;
        const name = toolNameOf(event) ?? "tool";
        const toolCallId = callIdOf(event) ?? crypto.randomUUID();
        if (event.name === "tool_called") {
          toolCalls += 1;
          const presentation = safeToolPresentation(name, toolArgumentsOf(event));
          toolCallsById.set(toolCallId, { name, presentation });
          await args.emit({
            type: "tool.started", runId, toolCallId, name,
            ...presentation,
          });
        }
        if (event.name === "tool_output") {
          evidenceMayBeReady = true;
          const resolved = toolCallsById.get(toolCallId);
          const resolvedName = resolved?.name ?? name;
          const presentation = resolved?.presentation ?? safeToolPresentation(resolvedName);
          const output = (event.item as { output?: unknown }).output
            ?? (event.item.rawItem as { output?: unknown } | undefined)?.output;
          for (const source of extractSources(output)) {
            if (sources.has(source.id)) continue;
            sources.set(source.id, source);
            await args.emit({ type: "source.added", runId, source });
          }
          // After decideApproval commits, the SDK replays the same propose_*
          // call. A stale preflight on that acknowledgement must not surface as
          // a teacher-visible write failure — the resource is already updated.
          const committedReplay = Boolean(
            args.context.approvedToolReplayCallId
            && toolCallId === args.context.approvedToolReplayCallId
            && resolvedName.startsWith("propose_"),
          );
          const revisionCode = committedReplay
            ? undefined
            : proposalRevisionCodeOf(output);
          const ok = committedReplay ? true : toolOutputSucceeded(event);
          const outcome = toolCompletionOutcomeOf({ ok, revisionCode });
          await args.emit({
            type: "tool.completed",
            runId,
            toolCallId,
            name: resolvedName,
            ok,
            revisionCode,
            outcome,
            ...presentation,
            label: toolCompletionLabelForOutcome(presentation.label, outcome),
            groupKey: presentation.groupKey,
          });
          toolCallsById.delete(toolCallId);
        }
      }
      await result.completed;
      if (emittedContentLength < content.length) {
        liveOutputAllowed = true;
        await emitAvailableContent();
      }
    } catch (error) {
      args.assistant.content = content;
      args.assistant.sources = [...sources.values()];
      if (
        args.context.abortSignal.aborted
        && args.context.abortSignal.reason === "user_cancelled"
      ) {
        await emitAvailableContent();
        await finishCancelled();
        return;
      }
      // A failed evidence/output guardrail makes the answer an unverified
      // draft, not disposable data. Stream what was already generated and let
      // the durable failed message + UI status communicate that it was not
      // validated and no write was performed.
      evidenceMayBeReady = false;
      liveOutputAllowed = true;
      await emitAvailableContent();
      const recoverableItems = recoverableFailedRunItems(result.output as AgentInputItem[]);
      if (recoverableItems.length) {
        await this.repository.addSessionItems(
          args.userId,
          args.context.threadId,
          args.context.branchId,
          recoverableItems,
          `failed-output:${runId}`,
        ).catch(() => undefined);
      }
      if (args.runLeaseToken) {
        await this.repository.updateRun(args.userId, runId, {
          tokenUsage: metrics(),
        }).catch(() => undefined);
      }
      const message = publicAgentError(
        error,
        args.continuation ? "approval_resume_failed" : "agent_run_failed",
      );
      if (args.continuation) {
        await settleContinuation("ready", message);
      }
      throw error;
    }

    try {
      if (
        args.context.abortSignal.aborted
        && args.context.abortSignal.reason !== "user_cancelled"
      ) {
        throw new Error(String(args.context.abortSignal.reason || "run_lease_lost"));
      }
      if (result.cancelled || args.context.abortSignal.aborted) {
        await finishCancelled();
        return;
      }

      if (result.interruptions.length) {
        let patch: ResourcePatch;
        let approvalScope: Pick<
          import("../domain.js").AgentApprovalRecord,
          "resourceType" | "patchKind" | "lessonFileId" | "semesterFrameworkId"
            | "baseResourceVersion" | "documentVersion"
        >;
        if (isSemesterFrameworkAgentContext(args.context)) {
          const interruption = result.interruptions.find((item) => (
            item.name === "propose_semester_framework_patch"
          )) ?? result.interruptions[0];
          try {
            const proposal = semesterFrameworkPatchToolSchema.parse(
              JSON.parse(interruption.arguments ?? "{}"),
            );
            const aggregate = await this.repository.getSemesterFramework(
              args.userId,
              args.context.semesterFrameworkId,
            );
            if (!aggregate) throw new Error("semester_framework_not_found");
            if (aggregate.framework.version !== args.context.frameworkVersion) {
              throw new Error("resource_context_stale");
            }
            patch = materializeSemesterFrameworkPatch({ proposal, aggregate });
            approvalScope = {
              resourceType: "semester_framework",
              patchKind: "semester_framework",
              semesterFrameworkId: args.context.semesterFrameworkId,
              baseResourceVersion: aggregate.framework.version,
            };
          } catch (error) {
            if (error instanceof Error && [
              "semester_framework_not_found",
              "resource_context_stale",
            ].includes(error.message)) throw error;
            throw new Error("invalid_patch_proposal");
          }
        } else {
          const writeInterruptions = result.interruptions.filter((item) => (
            item.name === "propose_document_patch"
            || item.name === "propose_lesson_design_change"
            || item.name === "propose_design_basis_projection"
            || item.name === "propose_lesson_design_basis_patch"
          ));
          if (writeInterruptions.length !== 1) throw new Error("invalid_patch_proposal");
          const interruption = writeInterruptions[0];
          if (interruption.name === "propose_lesson_design_change") {
            try {
              const proposal = lessonDesignChangeToolSchema.parse(
                JSON.parse(interruption.arguments ?? "{}"),
              );
              const [file, aggregate, observedEvidence] = await Promise.all([
                this.repository.getLessonFile(args.userId, args.context.lessonFileId),
                this.repository.getLessonDesignBasis(args.userId, args.context.lessonFileId),
                this.repository.listRunEvidence(args.userId, runId),
              ]);
              if (!file) throw new Error("lesson_file_not_found");
              if (!aggregate) throw new Error("lesson_design_basis_not_found");
              if (file.documentVersion !== args.context.documentVersion) {
                throw new Error("document_context_stale");
              }
              if (aggregate.basis.version !== args.context.designBasisVersion) {
                throw new Error("design_basis_context_stale");
              }
              await validateLessonDesignProposalReferences({
                repository: this.repository,
                context: args.context,
                proposal: {
                  summary: proposal.summary,
                  operations: proposal.designBasisOperations,
                },
              });
              patch = materializeLessonDesignChange({
                proposal,
                aggregate,
                file,
                observedEvidence,
              });
              approvalScope = {
                resourceType: "lesson_file",
                patchKind: "document",
                lessonFileId: args.context.lessonFileId,
                baseResourceVersion: file.documentVersion,
                documentVersion: file.documentVersion,
              };
            } catch (error) {
              if (error instanceof Error && [
                "lesson_file_not_found",
                "lesson_design_basis_not_found",
                "document_context_stale",
                "design_basis_context_stale",
              ].includes(error.message)) throw error;
              throw new Error(publicAgentError(error, "invalid_patch_proposal"));
            }
          } else if (interruption.name === "propose_design_basis_projection") {
            try {
              const proposal = designBasisProjectionToolSchema.parse(
                JSON.parse(interruption.arguments ?? "{}"),
              );
              const [file, aggregate] = await Promise.all([
                this.repository.getLessonFile(args.userId, args.context.lessonFileId),
                this.repository.getLessonDesignBasis(args.userId, args.context.lessonFileId),
              ]);
              if (!file) throw new Error("lesson_file_not_found");
              if (!aggregate) throw new Error("lesson_design_basis_not_found");
              if (file.documentVersion !== args.context.documentVersion) {
                throw new Error("document_context_stale");
              }
              if (aggregate.basis.version !== args.context.designBasisVersion) {
                throw new Error("design_basis_context_stale");
              }
              patch = materializeDesignBasisProjection({ proposal, aggregate, file });
              approvalScope = {
                resourceType: "lesson_file",
                patchKind: "document",
                lessonFileId: args.context.lessonFileId,
                baseResourceVersion: file.documentVersion,
                documentVersion: file.documentVersion,
              };
            } catch (error) {
              if (error instanceof Error && [
                "lesson_file_not_found",
                "lesson_design_basis_not_found",
                "document_context_stale",
                "design_basis_context_stale",
              ].includes(error.message)) throw error;
              if (error instanceof DesignBasisProjectionError) {
                throw new Error(publicAgentError(error, "invalid_patch_proposal"));
              }
              throw new Error(publicAgentError(error, "invalid_patch_proposal"));
            }
          } else if (interruption.name === "propose_lesson_design_basis_patch") {
            try {
              const proposal = lessonDesignBasisPatchToolSchema.parse(
                JSON.parse(interruption.arguments ?? "{}"),
              );
              const aggregate = await this.repository.getLessonDesignBasis(
                args.userId,
                args.context.lessonFileId,
              );
              if (!aggregate) throw new Error("lesson_design_basis_not_found");
              if (aggregate.basis.version !== args.context.designBasisVersion) {
                throw new Error("design_basis_context_stale");
              }
              await validateLessonDesignProposalReferences({
                repository: this.repository,
                context: args.context,
                proposal,
              });
              patch = materializeLessonDesignBasisPatch({
                proposal,
                aggregate,
                observedEvidence: await this.repository.listRunEvidence(args.userId, runId),
              });
              approvalScope = {
                resourceType: "lesson_file",
                patchKind: "lesson_design_basis",
                lessonFileId: args.context.lessonFileId,
                baseResourceVersion: aggregate.basis.version,
              };
            } catch (error) {
              if (error instanceof Error && [
                "lesson_design_basis_not_found",
                "design_basis_context_stale",
              ].includes(error.message)) throw error;
              throw new Error(publicAgentError(error, "invalid_patch_proposal"));
            }
          } else {
            let proposal;
            try {
              proposal = documentPatchToolSchema.parse(
                JSON.parse(interruption.arguments ?? "{}"),
              );
            } catch {
              throw new Error("invalid_patch_proposal");
            }
            const file = await this.repository.getLessonFile(args.userId, args.context.lessonFileId);
            if (!file) throw new Error("lesson_file_not_found");
            if (file.documentVersion !== args.context.documentVersion) {
              throw new Error("document_context_stale");
            }
            let currentPatch;
            try {
              currentPatch = materializeDocumentPatchProposal({
                proposal,
                fileId: args.context.lessonFileId,
                documentVersion: file.documentVersion,
                plan: file.document,
              });
            } catch (error) {
              if (error instanceof DocumentPatchError) {
                throw new Error(publicAgentError(error, "invalid_patch_proposal"));
              }
              throw error;
            }
            patch = bindPatchToObservedEvidence({
              patch: {
                ...currentPatch,
                ...(args.plan.fullRewriteRequested ? {
                  qualityPrediction: predictLessonSemanticQuality(
                    applyDocumentPatch(file.document, currentPatch),
                    { lessonDurationMinutes: file.contextProfile.lessonDurationMinutes },
                  ),
                } : {}),
              },
              evidence: await this.repository.listRunEvidence(args.userId, runId),
              evidenceRequired: args.plan.evidenceRequired,
            });
            approvalScope = {
              resourceType: "lesson_file",
              patchKind: "document",
              lessonFileId: args.context.lessonFileId,
              baseResourceVersion: args.context.documentVersion,
              documentVersion: args.context.documentVersion,
            };
          }
        }
        const approvalId = crypto.randomUUID();
        await this.repository.saveApproval({
          id: approvalId,
          ownerId: args.userId,
          runId,
          threadId: args.context.threadId,
          branchId: args.context.branchId,
          assistantMessageId: args.assistant.id,
          state: "pending",
          patch,
          encryptedRunState: encryptRunState(result.state.toString()),
          agentDefinitionVersion,
          ...approvalScope,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        });
        const sessionCursor = await currentSessionCursor();
        if (args.continuation) {
          // A chained interruption during approval continuation only owns the
          // continuation lease, not the original run lease. Pause the previous
          // continuation, then explicitly park the run/thread on the new pending
          // approval. Leaving status=running with a cleared lease created
          // unrecovered zombies that blocked later teacher turns.
          await this.repository.updateMessage(args.userId, args.assistant.id, {
            content,
            status: "completed",
            sources: [...sources.values()],
            sessionCursor,
          });
          await settleContinuation("paused");
          await this.repository.updateRun(args.userId, runId, {
            status: "awaiting_approval",
            tokenUsage: metrics(),
            completedAt: undefined,
            leaseToken: undefined,
            leaseExpiresAt: undefined,
            heartbeatAt: new Date().toISOString(),
          });
          await this.repository.updateThread(args.userId, args.context.threadId, {
            status: "awaiting_approval",
          });
        } else if (args.runLeaseToken) {
          await this.repository.settleRun({
            ownerId: args.userId,
            runId,
            leaseToken: args.runLeaseToken,
            status: "awaiting_approval",
            tokenUsage: metrics(),
            messageStatus: "completed",
            messageContent: content,
            messageSources: [...sources.values()],
            sessionCursor,
          });
        }
        const message = await this.repository.getMessage(args.userId, args.assistant.id)
          ?? { ...args.assistant, content, status: "completed", sources: [...sources.values()] };
        await args.emit({ type: "message.completed", runId, message });
        await args.emit({
          type: "approval.required",
          runId,
          approvalId,
          assistantMessageId: args.assistant.id,
          patch,
        });
        return;
      }

      let message: AgentMessageRecord;
      if (args.continuation) {
        await settleContinuation("completed");
        message = await this.repository.getMessage(args.userId, args.assistant.id)
          ?? { ...args.assistant, content, status: "completed", sources: [...sources.values()] };
      } else if (args.runLeaseToken) {
        const sessionCursor = await currentSessionCursor();
        await this.repository.settleRun({
          ownerId: args.userId,
          runId,
          leaseToken: args.runLeaseToken,
          status: "completed",
          tokenUsage: metrics(),
          messageStatus: "completed",
          messageContent: content,
          messageSources: [...sources.values()],
          sessionCursor,
        });
        message = await this.repository.getMessage(args.userId, args.assistant.id)
          ?? { ...args.assistant, content, status: "completed", sources: [...sources.values()] };
      } else {
        throw new Error("run_lease_missing");
      }
      await args.emit({ type: "message.completed", runId, message });
      await args.emit({ type: "run.completed", runId });
    } catch (error) {
      args.assistant.content = content;
      args.assistant.sources = [...sources.values()];
      if (args.continuation) {
        const message = publicAgentError(error, "approval_resume_failed");
        await settleContinuation("ready", message);
      }
      throw error;
    }
  }

  private runMetrics(
    result: { runContext: { usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number } } },
    startedAt: number,
    firstTokenMs: number | undefined,
    toolCalls: number,
    previous: Record<string, number> | undefined,
    phases: Record<string, number> = {},
  ) {
    const usage = result.runContext.usage;
    return {
      requests: (previous?.requests ?? 0) + usage.requests,
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
      durationMs: (previous?.durationMs ?? 0) + Math.round(performance.now() - startedAt),
      firstTokenMs: previous?.firstTokenMs || Math.round(firstTokenMs ?? 0),
      toolCalls: (previous?.toolCalls ?? 0) + toolCalls,
      ...Object.fromEntries(
        Object.entries(phases).map(([key, value]) => [
          key,
          (previous?.[key] ?? 0) + value,
        ]),
      ),
    };
  }

  async resumeApproval(args: {
    userId: string;
    runId: string;
    approvalId: string;
    approved: boolean;
    idempotencyKey: string;
    emit: Emit;
  }) {
    await this.ready;
    let approval = await this.repository.getApproval(args.userId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.runId !== args.runId) throw new Error("run_scope_invalid");
    if (approval.state === "expired") throw new Error("approval_expired");
    const matchesDecision = approval.state === "pending"
      || (approval.state === "approved") === args.approved;
    if (!matchesDecision) throw new Error("approval_already_resolved");
    const approvalPatch = approval.patch;
    const run = await this.repository.getRun(args.userId, approval.runId);
    if (!run?.capabilityPlan) throw new Error("run_not_found");
    const getApprovedResource = () => isSemesterFrameworkPatch(approvalPatch)
      ? this.repository.getSemesterFramework(args.userId, approvalPatch.frameworkId)
      : isLessonDesignBasisPatch(approvalPatch)
        ? this.repository.getLessonDesignBasis(args.userId, approvalPatch.fileId)
        : this.repository.getLessonFile(args.userId, approvalPatch.fileId);
    if (
      approval.state !== "pending"
      && (approval.continuationStatus === "completed" || run.status === "completed")
    ) {
      const resource = args.approved ? await getApprovedResource() : null;
      await args.emit({
        type: "run.started", runId: approval.runId,
        threadId: approval.threadId, branchId: approval.branchId,
      });
      await args.emit({
        type: "approval.decided",
        runId: approval.runId,
        approvalId: approval.id,
        decision: args.approved ? "approved" : "rejected",
      });
      if (resource && isSemesterFrameworkPatch(approvalPatch)) {
        await args.emit({
          type: "resource.updated",
          runId: approval.runId,
          resourceType: "semester_framework",
          framework: resource as import("../domain.js").SemesterFrameworkAggregate,
        });
      } else if (resource && isLessonDesignBasisPatch(approvalPatch)) {
        await args.emit({
          type: "design_basis.updated",
          runId: approval.runId,
          basis: resource as import("../domain.js").LessonDesignBasisAggregate,
        });
      } else if (resource) {
        await args.emit({
          type: "document.updated",
          runId: approval.runId,
          file: resource as import("../domain.js").LessonFileRecord,
        });
      }
      await args.emit({ type: "run.completed", runId: approval.runId });
      return resource;
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      if (approval.state === "pending") {
        await this.repository.expireApprovalLifecycle(args.userId, args.approvalId);
      }
      throw new Error("approval_expired");
    }
    if (approval.agentDefinitionVersion !== agentDefinitionVersion) throw new Error("agent_definition_unavailable");
    const controller = new AbortController();
    const activeRunKey = `${args.userId}:${approval.runId}`;
    this.registerActiveRun(activeRunKey, controller);
    let close = async () => {};
    let assistant: AgentMessageRecord | undefined;
    const leaseToken = `approval:${args.approvalId}:${args.idempotencyKey}`;
    let continuationClaimed = false;
    try {
      const context = await this.createContext({
        userId: args.userId,
        threadId: approval.threadId,
        branchId: approval.branchId,
        runId: approval.runId,
        activeSectionId: isSemesterFrameworkPatch(approvalPatch)
          ? "overview"
          : isLessonDesignBasisPatch(approvalPatch)
            ? "design-basis"
            : approvalPatch.operations[0]?.field ?? "basics",
        attachmentSourceIds: isSemesterFrameworkPatch(approvalPatch)
          ? []
          : run.attachmentSourceIds ?? [],
        signal: controller.signal,
      });
      await this.repairSessionHistory(
        args.userId,
        approval.threadId,
        approval.branchId,
      );
      const skills = run.skillVersions && Object.keys(run.skillVersions).length
        ? this.registry.resolveVersions(run.skillVersions)
        : this.registry.resolve(run.capabilityPlan.skillIds);
      const runtime = await createManager({
        repository: this.repository,
        context,
        plan: { ...run.capabilityPlan, writeMode: "open" },
        skills,
        modelProvider: this.modelProvider,
      });
      close = runtime.close;
      let state = await RunState.fromStringWithContext(
        runtime.manager,
        decryptRunState(approval.encryptedRunState),
        new RunContext<PreparationAgentContext>(context),
        { contextStrategy: "replace" },
      );
      const interruption = state.getInterruptions().find((item: RunToolApprovalItem) => (
        item.name === (isSemesterFrameworkPatch(approvalPatch)
          ? "propose_semester_framework_patch"
          : isLessonDesignBasisPatch(approvalPatch)
            ? "propose_lesson_design_basis_patch"
            : isLessonDesignChangePatch(approvalPatch)
              ? "propose_lesson_design_change"
              : approvalPatch.projection
              ? "propose_design_basis_projection"
              : "propose_document_patch")
      )) ?? state.getInterruptions()[0];

      if (interruption) {
        if (args.approved) {
          state.approve(interruption);
        } else {
          state.reject(interruption, { message: "教师拒绝了这项修改，请保留原文并继续对话。" });
        }
        const decision = await this.repository.decideApproval({
          ownerId: args.userId,
          approvalId: args.approvalId,
          approved: args.approved,
          encryptedRunState: encryptRunState(state.toString()),
        });
        approval = decision.approval;
        await args.emit({
          type: "approval.decided",
          runId: approval.runId,
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
        });
        if (decision.file) {
          await args.emit({
            type: "document.updated",
            runId: approval.runId,
            file: decision.file,
          });
        }
        if (decision.framework) {
          await args.emit({
            type: "resource.updated",
            runId: approval.runId,
            resourceType: "semester_framework",
            framework: decision.framework,
          });
          const writebackFeedbackId = run.capabilityPlan?.continuityWritebackFeedbackId;
          if (
            args.approved
            && writebackFeedbackId
            && isSemesterFrameworkPatch(approvalPatch)
          ) {
            try {
              const feedbackRecords = await this.repository.listLessonClassFeedback(args.userId, {
                semesterFrameworkId: approvalPatch.frameworkId,
              });
              const scopedFeedbackId = resolveScopedWritebackFeedbackId(
                writebackFeedbackId,
                feedbackRecords,
                approvalPatch.frameworkId,
              );
              if (scopedFeedbackId) {
                await this.repository.markLessonClassFeedbackWriteback(
                  args.userId,
                  scopedFeedbackId,
                  "applied",
                );
              }
            } catch {
              // Writeback marker must not roll back an already-approved framework patch.
            }
          }
        }
        if (decision.basis) {
          await args.emit({
            type: "design_basis.updated",
            runId: approval.runId,
            basis: decision.basis,
          });
        }
        // RunState restoration needs the pre-decision context to identify the
        // interrupted tool call. Once the approved transaction has committed,
        // however, all subsequent tools must use the canonical post-decision
        // snapshot. The RunState is explicitly rehydrated below because mutating
        // this source object alone does not replace its restored RunContext.
        if (decision.framework && isSemesterFrameworkAgentContext(context)) {
          context.frameworkVersion = decision.framework.framework.version;
          context.contextProfile = decision.framework.framework.contextProfile;
        }
        if (!isSemesterFrameworkAgentContext(context)) {
          if (decision.file) {
            context.documentVersion = decision.file.documentVersion;
            context.contextProfile = decision.file.contextProfile;
          }
          if (decision.basis) {
            context.designBasisVersion = decision.basis.basis.version;
          }
        }
        if (args.approved) {
          const replayCallId = "callId" in interruption.rawItem
            ? interruption.rawItem.callId
            : undefined;
          if (typeof replayCallId === "string" && replayCallId.trim()) {
            // Agents SDK intentionally runs tool input guardrails both before
            // the approval interruption and again before approved execution.
            // LessonUp has already committed the teacher-approved transaction
            // atomically, so rerunning the old proposal against the new
            // snapshot would falsely report it as stale. Rehydrate the approved
            // RunState with a narrowly scoped replay token for this call only.
            context.approvedToolReplayCallId = replayCallId;
            state = await RunState.fromStringWithContext(
              runtime.manager,
              state.toString(),
              new RunContext<PreparationAgentContext>(context),
              { contextStrategy: "replace" },
            );
            const replayInterruption = state.getInterruptions().find((item) => (
              "callId" in item.rawItem
              && item.rawItem.callId === context.approvedToolReplayCallId
            ));
            if (!replayInterruption) {
              throw new Error("approval_interruption_missing_after_context_refresh");
            }
            // Approval decisions live in RunContext rather than the serialized
            // step, so replacing the context requires applying the same decision
            // to the rehydrated interruption once more. This does not touch the
            // database transaction; it only lets the SDK execute its
            // post-approval acknowledgement path.
            state.approve(replayInterruption);
          }
        }
      } else if (approval.state === "pending") {
        throw new Error("approval_interruption_missing");
      } else {
        await args.emit({
          type: "approval.decided",
          runId: approval.runId,
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
        });
      }

      approval = await this.repository.claimApprovalContinuation({
        ownerId: args.userId,
        approvalId: args.approvalId,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      if (approval.continuationStatus === "completed") {
        await args.emit({
          type: "run.started", runId: approval.runId,
          threadId: approval.threadId, branchId: approval.branchId,
        });
        await args.emit({ type: "run.completed", runId: approval.runId });
        return args.approved
          ? getApprovedResource()
          : null;
      }
      continuationClaimed = true;
      await this.repository.updateRun(args.userId, approval.runId, { status: "running" });
      await this.repository.updateThread(args.userId, approval.threadId, { status: "running" });
      const continuationMessageId = approval.continuationMessageId;
      if (!continuationMessageId) throw new Error("approval_continuation_message_missing");
      assistant = await this.repository.getMessage(args.userId, continuationMessageId)
        ?? await this.repository.appendMessage({
          id: continuationMessageId,
          ownerId: args.userId,
          threadId: approval.threadId,
          branchId: approval.branchId,
          role: "assistant",
          content: "",
          status: "streaming",
        });
      assistant = await this.repository.updateMessage(args.userId, assistant.id, {
        status: "streaming",
      });
      await args.emit({
        type: "run.started", runId: approval.runId,
        threadId: approval.threadId, branchId: approval.branchId,
      });
      await this.streamRun({
        userId: args.userId,
        manager: runtime.manager,
        context,
        plan: run.capabilityPlan,
        assistant,
        input: state,
        sessionPersistenceKey: `approval:${args.approvalId}:${args.approved ? "approved" : "rejected"}`,
        emit: args.emit,
        continuation: {
          approvalId: args.approvalId,
          leaseToken,
        },
      });
      return args.approved
        ? getApprovedResource()
        : null;
    } catch (error) {
      await this.repairSessionHistory(
        args.userId,
        approval.threadId,
        approval.branchId,
      ).catch(() => undefined);
      const message = publicAgentError(error, "approval_resume_failed");
      if (
        (
          message === "stale_document"
          || message === "stale_resource"
          || message === "stale_design_basis"
        )
        && approval.state === "pending"
      ) {
        await this.repository.expireApprovalLifecycle(args.userId, args.approvalId);
      }
      if (continuationClaimed) {
        const canonical = await this.repository.getApproval(args.userId, args.approvalId)
          .catch(() => null);
        if (canonical?.continuationStatus === "running") {
          await this.repository.settleApprovalContinuation({
            ownerId: args.userId,
            approvalId: args.approvalId,
            leaseToken,
            outcome: "ready",
            assistantMessageId: assistant?.id,
            content: assistant?.content,
            sources: assistant?.sources,
            error: message,
          }).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.settleActiveRun(activeRunKey);
      await close();
    }
  }
}
