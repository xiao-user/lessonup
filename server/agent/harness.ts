import {
  RunContext,
  Runner,
  RunState,
  type Agent,
  type AgentInputItem,
  type RunStreamEvent,
  type RunToolApprovalItem,
} from "@openai/agents";
import { canonicalizeDocumentPatchRanges, DocumentPatchError } from "../document-patch.js";
import {
  protocolSafeSessionHistory,
  selectCompactionBatch,
  selectProtocolSafeSessionHistory,
  threadMemorySummaryItem,
  withoutThreadMemorySummaryItems,
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
import { documentPatchSchema } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { RepositorySession } from "../repository.js";
import { decryptRunState, encryptRunState } from "../security/state-crypto.js";
import { routeCapabilities } from "./capability-router.js";
import { createDeepSeekClient, DeepSeekModelProvider, deepSeekModels } from "./deepseek-provider.js";
import { assertCurrentDocumentVersion } from "./document-version.js";
import { agentDefinitionVersion, createManager } from "./manager.js";
import { SkillRegistry } from "./skill-registry.js";
import { extractSources } from "./source-extraction.js";
import { publicAgentError } from "./public-error.js";
import { safeToolPresentation, type SafeToolPresentation } from "./tool-presentation.js";

type Emit = (event: NormalizedAgentEvent) => void | Promise<void>;

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

export class LessonAgentHarness {
  private readonly modelProvider: DeepSeekModelProvider;
  private readonly runner: Runner;
  private readonly registry = new SkillRegistry();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private ready: Promise<SkillRegistry>;

  constructor(private readonly repository: LessonRepository) {
    this.modelProvider = new DeepSeekModelProvider();
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
    if (!active) return false;
    active.controller.abort("user_cancelled");
    await active.settled;
    return true;
  }

  private async createContext(args: {
    userId: string;
    threadId: string;
    branchId: string;
    runId: string;
    activeSectionId: string;
    selection?: LessonAgentSelection;
    expectedDocumentVersion?: number;
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
      allowedKnowledgeScopes: [
        "public",
        `user:${args.userId}`,
        `notebook:${thread.notebookId}`,
        `file:${thread.lessonFileId}`,
      ],
      abortSignal: args.signal,
    };
  }

  private async repairSessionHistory(userId: string, threadId: string, branchId: string) {
    const history = await this.repository.getSessionItems(userId, threadId, branchId);
    const safeHistory = protocolSafeSessionHistory(history);
    if (JSON.stringify(safeHistory) !== JSON.stringify(history)) {
      await this.repository.replaceSessionItems(userId, threadId, branchId, safeHistory);
    }
    return safeHistory;
  }

  private buildInput(message: string, context: LessonAgentContext, attachments: SourceRef[]) {
    return buildLessonAgentInput(message, context, attachments);
  }

  private async titleFor(message: string) {
    try {
      const response = await createDeepSeekClient().chat.completions.create({
        model: deepSeekModels.flash,
        temperature: 0,
        max_tokens: 32,
        messages: [
          { role: "system", content: "为备课对话生成不超过14个汉字的标题。只输出标题，不加引号和标点。" },
          { role: "user", content: message.slice(0, 2_000) },
        ],
      });
      return response.choices[0]?.message?.content?.trim().slice(0, 28) || message.slice(0, 14);
    } catch {
      return message.replace(/\s+/g, " ").trim().slice(0, 14) || "新会话";
    }
  }

  private createSessionInputCallback(context: LessonAgentContext) {
    return async (history: AgentInputItem[], current: AgentInputItem[]) => {
      const keepRecentItems = 24;
      const compactableHistory = withoutThreadMemorySummaryItems(history);
      const memory = await this.repository.getThreadMemory(
        context.userId, context.threadId, context.branchId,
      );
      const compactableCount = Math.max(0, compactableHistory.length - keepRecentItems);
      let summary = memory?.summary;

      const batch = selectCompactionBatch({
        history: compactableHistory,
        startCursor: memory?.cursor ?? 0,
        endCursor: compactableCount,
      });
      if (batch.items.length) {
        try {
          const response = await createDeepSeekClient().chat.completions.create({
            model: deepSeekModels.flash,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: [
                  "压缩备课对话为结构化 JSON。",
                  "仅保留教师意图、已确认事实、已做决策、引用来源、未解决事项和被拒绝建议。",
                  "不得补写原对话不存在的信息，不得包含内部推理。",
                  "如果提供了此前摘要，必须把仍然有效的内容合并进新摘要，不能只总结新增片段。",
                  "输出键：summary, decisions, sources, unresolved, rejected。",
                ].join("\n"),
              },
              {
                role: "user",
                content: [
                  `此前摘要：${summary ?? "无"}`,
                  `新增历史范围：${batch.startCursor}-${batch.endCursor}`,
                  batch.serialized,
                ].join("\n"),
              },
            ],
          });
          summary = response.choices[0]?.message?.content?.trim() || summary;
          if (summary) {
            await this.repository.saveThreadMemory(
              context.userId, context.threadId, context.branchId, summary, batch.endCursor,
            );
          }
        } catch {
          // A failed compaction must never block the foreground run. The raw
          // session remains durable and the next run can retry compaction.
        }
      }

      const selected = selectProtocolSafeSessionHistory({
        history: compactableHistory,
        current,
        summary,
        keepRecentItems,
      });
      const summaryItem = summary
        ? [threadMemorySummaryItem(summary)]
        : [];
      return [...summaryItem, ...selected, ...current];
    };
  }

  async start(input: StartRunInput, emit: Emit) {
    await this.ready;
    const existingThread = await this.repository.getThread(input.userId, input.threadId);
    if (!existingThread) throw new Error("thread_not_found");
    if (existingThread.status === "running" || existingThread.status === "awaiting_approval") {
      throw new Error("active_run_exists");
    }

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const activeRunKey = `${input.userId}:${runId}`;
    this.registerActiveRun(activeRunKey, controller);
    let close = async () => {};
    let runCreated = false;
    let assistant: AgentMessageRecord | undefined;
    let userMessage: AgentMessageRecord | undefined;
    let sessionLengthBeforeRun = 0;
    try {
      const context = await this.createContext({
        ...input,
        expectedDocumentVersion: input.documentVersion,
        runId,
        signal: controller.signal,
      });
      await this.repository.createRun({
        id: runId, ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        model: deepSeekModels.pro, status: "queued",
        agentDefinitionVersion,
      });
      runCreated = true;
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
      const attachments = await this.repository.attachKnowledgeSources(
        input.userId,
        context.lessonFileId,
        userMessage.id,
        input.attachmentIds,
      );
      if (attachments.length) {
        await this.repository.updateMessage(input.userId, userMessage.id, { sources: attachments });
      }
      assistant = await this.repository.appendMessage({
        ownerId: input.userId, threadId: input.threadId, branchId: input.branchId,
        role: "assistant", content: "", status: "streaming",
      });
      await emit({ type: "run.started", runId, threadId: input.threadId, branchId: input.branchId });

      if (existingThread.title === "新会话") {
        void this.titleFor(input.message).then(async (title) => {
          const thread = await this.repository.updateThread(input.userId, input.threadId, { title });
          await emit({ type: "thread.updated", runId, thread });
        }).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      const routedPlan = await routeCapabilities(input.message, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const plan = input.attachmentIds.length && !routedPlan.mcpServers.includes("knowledge")
        ? { ...routedPlan, mcpServers: [...routedPlan.mcpServers, "knowledge"] }
        : routedPlan;
      const skills = this.registry.resolve(plan.skillIds);
      const runtime = await createManager({
        repository: this.repository,
        context,
        plan,
        skills,
        modelProvider: this.modelProvider,
      });
      close = runtime.close;
      controller.signal.throwIfAborted();
      await this.repository.updateRun(input.userId, runId, {
        status: "running",
        capabilityPlan: plan,
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
        emit,
      });
    } catch (error) {
      if (!runCreated) throw error;
      if (controller.signal.aborted) {
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
        await this.repository.updateRun(input.userId, runId, {
          status: "cancelled", completedAt: new Date().toISOString(),
        });
        await this.repository.updateThread(input.userId, input.threadId, { status: "idle" });
        if (assistant) {
          await this.repository.updateMessage(input.userId, assistant.id, {
            content: assistant.content,
            status: "completed",
            sessionCursor: safeHistory.length,
          });
        }
        await emit({ type: "run.cancelled", runId });
        return;
      }
      await this.repairSessionHistory(input.userId, input.threadId, input.branchId)
        .catch(() => undefined);
      const message = publicAgentError(error);
      await this.repository.updateRun(input.userId, runId, {
        status: "failed", error: message, completedAt: new Date().toISOString(),
      });
      await this.repository.updateThread(input.userId, input.threadId, { status: "failed" });
      if (assistant) {
        await this.repository.updateMessage(input.userId, assistant.id, {
          content: assistant.content, status: "failed",
        });
      }
      await emit({ type: "run.failed", runId, error: message });
    } finally {
      this.settleActiveRun(activeRunKey);
      await close();
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
    emit: Emit;
  }) {
    const runId = args.context.runId;
    const previousMetrics = (await this.repository.getRun(args.userId, runId))?.tokenUsage;
    const startedAt = performance.now();
    let firstTokenMs: number | undefined;
    let toolCalls = 0;
    let content = args.assistant.content;
    const sources = new Map<string, SourceRef>();
    const toolCallsById = new Map<string, { name: string; presentation: SafeToolPresentation }>();
    const currentSessionCursor = async () => (
      await this.repository.getSessionItems(
        args.userId,
        args.context.threadId,
        args.context.branchId,
      )
    ).length;
    const result = await this.runner.run(args.manager, args.input, {
      stream: true,
      context: args.context,
      signal: args.context.abortSignal,
      session: new RepositorySession(
        this.repository, args.userId, args.context.threadId, args.context.branchId,
        args.sessionPersistenceKey,
      ),
      sessionInputCallback: this.createSessionInputCallback(args.context),
      maxTurns: 12,
    });

    try {
      for await (const event of result) {
        if (event.type === "raw_model_stream_event" && firstTokenMs === undefined) {
          firstTokenMs = performance.now() - startedAt;
        }
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
          content += event.data.delta;
          await args.emit({ type: "message.delta", runId, delta: event.data.delta });
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
            type: "tool.completed", runId, toolCallId, name: resolvedName, ok: true,
            ...presentation,
          });
          toolCallsById.delete(toolCallId);
        }
      }
      await result.completed;
    } catch (error) {
      if (args.context.abortSignal.aborted) {
        const safeHistory = await this.repairSessionHistory(
          args.userId,
          args.context.threadId,
          args.context.branchId,
        ).catch(() => []);
        await this.repository.updateRun(args.userId, runId, {
          status: "cancelled", completedAt: new Date().toISOString(),
          tokenUsage: this.runMetrics(result, startedAt, firstTokenMs, toolCalls, previousMetrics),
        });
        await this.repository.updateThread(args.userId, args.context.threadId, { status: "idle" });
        await this.repository.updateMessage(args.userId, args.assistant.id, {
          content,
          status: "completed",
          sources: [...sources.values()],
          sessionCursor: safeHistory.length,
        });
        await args.emit({ type: "run.cancelled", runId });
        return;
      }
      await this.repository.updateRun(args.userId, runId, {
        tokenUsage: this.runMetrics(result, startedAt, firstTokenMs, toolCalls, previousMetrics),
      });
      throw error;
    }

    if (result.interruptions.length) {
      const interruption = result.interruptions.find((item) => item.name === "propose_document_patch")
        ?? result.interruptions[0];
      const patchInput = documentPatchSchema.parse({
        ...JSON.parse(interruption.arguments ?? "{}"),
        fileId: args.context.lessonFileId,
      });
      const file = await this.repository.getLessonFile(args.userId, args.context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      if (patchInput.baseDocumentVersion !== file.documentVersion) {
        throw new DocumentPatchError("stale_document", "教案版本已经变化");
      }
      const patch = canonicalizeDocumentPatchRanges(patchInput, file.document);
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
      const message = await this.repository.updateMessage(args.userId, args.assistant.id, {
        content,
        status: "completed",
        sources: [...sources.values()],
        sessionCursor: await currentSessionCursor(),
      });
      await this.repository.updateRun(args.userId, runId, {
        status: "awaiting_approval",
        tokenUsage: this.runMetrics(result, startedAt, firstTokenMs, toolCalls, previousMetrics),
      });
      await this.repository.updateThread(args.userId, args.context.threadId, { status: "awaiting_approval" });
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

    const message = await this.repository.updateMessage(args.userId, args.assistant.id, {
      content,
      status: "completed",
      sources: [...sources.values()],
      sessionCursor: await currentSessionCursor(),
    });
    await this.repository.updateRun(args.userId, runId, {
      status: "completed", completedAt: new Date().toISOString(),
      tokenUsage: this.runMetrics(result, startedAt, firstTokenMs, toolCalls, previousMetrics),
    });
    await this.repository.updateThread(args.userId, args.context.threadId, { status: "idle" });
    await args.emit({ type: "message.completed", runId, message });
    await args.emit({ type: "run.completed", runId });
  }

  private runMetrics(
    result: { runContext: { usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number } } },
    startedAt: number,
    firstTokenMs: number | undefined,
    toolCalls: number,
    previous: Record<string, number> | undefined,
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
      await args.emit({
        type: "run.started", runId: approval.runId,
        threadId: approval.threadId, branchId: approval.branchId,
      });
      await args.emit({ type: "run.completed", runId: approval.runId });
      return args.approved
        ? this.repository.getLessonFile(args.userId, approval.patch.fileId)
        : null;
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      if (approval.state === "pending") {
        await this.repository.resolveApproval(args.userId, args.approvalId, "expired");
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
      } else if (approval.state === "pending") {
        throw new Error("approval_interruption_missing");
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
        content: "",
        status: "streaming",
        sources: [],
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
      });
      await this.repository.finishApprovalContinuation({
        ownerId: args.userId,
        approvalId: args.approvalId,
        leaseToken,
        status: "completed",
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
        await this.repository.resolveApproval(args.userId, args.approvalId, "expired");
      }
      if (continuationClaimed) {
        await this.repository.finishApprovalContinuation({
          ownerId: args.userId,
          approvalId: args.approvalId,
          leaseToken,
          status: "ready",
          error: message,
        }).catch(() => undefined);
      }
      await this.repository.updateRun(args.userId, approval.runId, {
        status: "failed", error: message, completedAt: new Date().toISOString(),
      });
      await this.repository.updateThread(args.userId, approval.threadId, { status: "failed" });
      if (assistant) {
        await this.repository.updateMessage(args.userId, assistant.id, {
          content: assistant.content, status: "failed",
        });
      }
      throw error;
    } finally {
      this.settleActiveRun(activeRunKey);
      await close();
    }
  }
}
