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
  DocumentPatchError,
  materializeDocumentPatchProposal,
} from "../document-patch.js";
import {
  protocolSafeSessionHistory,
  selectCompactionBatch,
  selectProtocolSafeSessionHistory,
  threadMemorySummaryItem,
  durableSessionHistoryItems,
} from "./session-history.js";
import type {
  AgentMessageRecord,
  CapabilityPlan,
  DocumentPatch,
  LessonAgentContext,
  LessonAgentSelection,
  NormalizedAgentEvent,
  SourceRef,
} from "../domain.js";
import { documentPatchToolSchema } from "../domain.js";
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
import { bindPatchToObservedEvidence } from "./evidence.js";
import { validateObservedEvidence } from "./output-guardrails.js";

type Emit = (event: NormalizedAgentEvent) => void | Promise<void>;

const threadMemorySummarySchema = z.object({
  summary: z.string().max(12_000),
  decisions: z.array(z.string().max(2_000)).max(100),
  sources: z.array(z.string().max(2_000)).max(100),
  unresolved: z.array(z.string().max(2_000)).max(100),
  rejected: z.array(z.string().max(2_000)).max(100),
});

export function buildLessonAgentInput(
  message: string,
  context: Pick<LessonAgentContext, "activeSectionId" | "documentVersion" | "selection">,
  attachments: SourceRef[],
) {
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

type StartRunInput = {
  userId: string;
  threadId: string;
  branchId: string;
  message: string;
  activeSectionId: string;
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
  return true;
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
    selection?: LessonAgentSelection;
    expectedDocumentVersion?: number;
    attachmentSourceIds?: string[];
    signal: AbortSignal;
  }): Promise<LessonAgentContext> {
    const thread = await this.repository.getThread(args.userId, args.threadId);
    const branch = await this.repository.getBranch(args.userId, args.threadId, args.branchId);
    if (!thread || !branch) throw new Error("thread_scope_invalid");
    const file = await this.repository.getLessonFile(args.userId, thread.lessonFileId);
    if (!file || file.notebookId !== thread.notebookId) throw new Error("lesson_scope_invalid");
    assertCurrentDocumentVersion(file.documentVersion, args.expectedDocumentVersion);
    return {
      userId: args.userId,
      notebookId: thread.notebookId,
      lessonFileId: thread.lessonFileId,
      threadId: thread.id,
      branchId: branch.id,
      runId: args.runId,
      activeSectionId: args.activeSectionId,
      selection: args.selection,
      documentVersion: file.documentVersion,
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

  private buildInput(message: string, context: LessonAgentContext, attachments: SourceRef[]) {
    return buildLessonAgentInput(message, context, attachments);
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
    context: LessonAgentContext,
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

  private scheduleThreadMemoryCompaction(context: LessonAgentContext) {
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

  private async compactThreadMemory(context: LessonAgentContext) {
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
    let contextForMemory: LessonAgentContext | undefined;
    const phaseMetrics: Record<string, number> = {};
    try {
      const contextStartedAt = performance.now();
      const context = await this.createContext({
        ...input,
        expectedDocumentVersion: input.documentVersion,
        runId,
        signal: controller.signal,
      });
      phaseMetrics.contextLoadMs = Math.round(performance.now() - contextStartedAt);
      contextForMemory = context;
      await this.repository.createRun({
        id: runId, ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        model: deepSeekModels.pro, status: "queued",
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
      const attachments = await this.repository.attachKnowledgeSources(
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
      const routingFile = await this.repository.getLessonFile(input.userId, context.lessonFileId);
      if (!routingFile || routingFile.documentVersion !== context.documentVersion) {
        throw new Error("document_context_stale");
      }
      const routingStartedAt = performance.now();
      const routedPlan = await routeCapabilities(input.message, {
        signal: controller.signal,
        document: routingFile.document,
        attachmentSourceIds: context.attachmentSourceIds,
      });
      phaseMetrics.routingMs = Math.round(performance.now() - routingStartedAt);
      controller.signal.throwIfAborted();
      const plan = attachments.length && !routedPlan.mcpServers.includes("knowledge")
        ? {
            ...routedPlan,
            mcpServers: [...routedPlan.mcpServers, "knowledge"],
          }
        : routedPlan;
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
        input: this.buildInput(input.message, context, attachments),
        sessionPersistenceKey: `run:${runId}`,
        runLeaseToken: leaseToken,
        phaseMetrics,
        emit,
      });
    } catch (error) {
      if (!runCreated) throw error;
      const internalError = error instanceof Error ? error.message : "";
      if (
        (controller.signal.aborted && controller.signal.reason === "user_cancelled")
        || internalError === "run_cancel_requested"
      ) {
        let safeHistory = await this.repairSessionHistory(
          input.userId,
          input.threadId,
          input.branchId,
        ).catch(() => []);
        if (userMessage && safeHistory.length <= sessionLengthBeforeRun) {
          await this.repository.addSessionItems(
            input.userId,
            input.threadId,
            input.branchId,
            [{ type: "message", role: "user", content: userMessage.content }],
            `cancelled:${runId}`,
          ).catch(() => undefined);
          safeHistory = await this.repairSessionHistory(
            input.userId,
            input.threadId,
            input.branchId,
          ).catch(() => safeHistory);
        }
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
        await this.repository.recoverExpiredRuns(input.userId, input.threadId).catch(() => undefined);
        await emit({ type: "run.failed", runId, error: "run_interrupted" });
        return;
      }
      await this.repairSessionHistory(input.userId, input.threadId, input.branchId)
        .catch(() => undefined);
      const message = publicAgentError(error);
      await this.repository.settleRun({
        ownerId: input.userId,
        runId,
        leaseToken,
        status: "failed",
        error: message,
        messageStatus: "failed",
        messageContent: assistant?.content,
      }).catch(() => undefined);
      await emit({ type: "run.failed", runId, error: message });
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
    manager: Agent<LessonAgentContext>;
    context: LessonAgentContext;
    plan: CapabilityPlan;
    assistant: AgentMessageRecord;
    input: string | RunState<LessonAgentContext, Agent<LessonAgentContext>>;
    sessionPersistenceKey: string;
    runLeaseToken?: string;
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
      maxTurns: 12,
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
      const safeHistory = await this.repairSessionHistory(
        args.userId,
        args.context.threadId,
        args.context.branchId,
      ).catch(() => []);
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
          await args.emit({
            type: "tool.completed",
            runId,
            toolCallId,
            name: resolvedName,
            ok: toolOutputSucceeded(event),
            ...presentation,
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
      if (
        args.context.abortSignal.aborted
        && args.context.abortSignal.reason === "user_cancelled"
      ) {
        await emitAvailableContent();
        await finishCancelled();
        return;
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
        const interruption = result.interruptions.find((item) => item.name === "propose_document_patch")
          ?? result.interruptions[0];
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
            throw new Error("invalid_patch_proposal");
          }
          throw error;
        }
        const patch = bindPatchToObservedEvidence({
          patch: currentPatch,
          evidence: await this.repository.listRunEvidence(args.userId, runId),
          evidenceRequired: args.plan.evidenceRequired,
        });
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
          documentVersion: args.context.documentVersion,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        });
        const sessionCursor = await currentSessionCursor();
        if (args.continuation) {
          await this.repository.updateMessage(args.userId, args.assistant.id, {
            content,
            status: "completed",
            sources: [...sources.values()],
            sessionCursor,
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
        if (args.continuation) {
          await settleContinuation("paused");
        }
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
    const run = await this.repository.getRun(args.userId, approval.runId);
    if (!run?.capabilityPlan) throw new Error("run_not_found");
    if (
      approval.state !== "pending"
      && (approval.continuationStatus === "completed" || run.status === "completed")
    ) {
      const file = args.approved
        ? await this.repository.getLessonFile(args.userId, approval.patch.fileId)
        : null;
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
      if (file) await args.emit({ type: "document.updated", runId: approval.runId, file });
      await args.emit({ type: "run.completed", runId: approval.runId });
      return file;
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
        activeSectionId: approval.patch.operations[0]?.field ?? "basics",
        attachmentSourceIds: run.attachmentSourceIds ?? [],
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
        plan: run.capabilityPlan,
        skills,
        modelProvider: this.modelProvider,
      });
      close = runtime.close;
      const state = await RunState.fromStringWithContext(
        runtime.manager,
        decryptRunState(approval.encryptedRunState),
        new RunContext(context),
        { contextStrategy: "replace" },
      );
      const interruption = state.getInterruptions().find((item: RunToolApprovalItem) => (
        item.name === "propose_document_patch"
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
          ? this.repository.getLessonFile(args.userId, approval.patch.fileId)
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
        ? this.repository.getLessonFile(args.userId, approval.patch.fileId)
        : null;
    } catch (error) {
      await this.repairSessionHistory(
        args.userId,
        approval.threadId,
        approval.branchId,
      ).catch(() => undefined);
      const message = publicAgentError(error, "approval_resume_failed");
      if (message === "stale_document" && approval.state === "pending") {
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
