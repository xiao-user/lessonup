import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { config } from "../../config.js";
import { isSemesterFrameworkAgentContext, type AgentApprovalRecord, type AgentMessageRecord, type AgentRunRecord, type CapabilityPlan, type LessonAgentContext, type LessonAgentSelection, type SourceRef } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { routeCapabilities } from "../../agent/capability-router.js";
import { validateObservedEvidence } from "../../agent/evidence-validation.js";
import { publicPiAgentError } from "../../agent/public-error.js";
import { SkillRegistry, type PlatformSkill } from "../../agent/skill-registry.js";
import type { PresentationService } from "../../presentations/service.js";
import { presentationLanguageForRequest, resolvePresentationTurn } from "../../presentations/presentation-turn.js";
import type { WebSearchProvider } from "../../providers/web-search.js";
import { UnavailableWebSearchProvider } from "../../providers/unavailable-web-search.js";
import { createPiModelRuntime } from "./model-provider.js";
import { createMessageCheckpoint } from "./message-checkpoint.js";
import { type PiCapturedProposal } from "./proposal-tools.js";
import { resolveRunThinkingLevel, type TeacherThinkingLevel } from "./thinking-level.js";
import { resolveTurn } from "../../conversation/turn-resolver.js";
import { emptyRuntimeTools, isFastExecution, lessonTurnContext, semesterTurnContext } from "./turn-context.js";
import { loadPreparationContext } from "./preparation-context.js";
import { type Emit, type PiDashi, RUN_LEASE_MS, piAgentDefinitionVersion } from "./contracts.js";
import { PiRunLifecycle } from "./run-lifecycle.js";
import { PiAgentExecutor } from "./executor.js";
import { PiToolSurface } from "./tool-surface.js";
import { PiApprovalWorkflow } from "./approval-workflow.js";
import { emitRunEvidence } from "./run-evidence.js";

export { piAgentDefinitionVersion } from "./contracts.js";

export type PiStartRunInput = {
  userId: string;
  threadId: string;
  branchId: string;
  message: string;
  activeSectionId: string;
  activeUnitId?: string;
  documentVersion: number;
  selection?: LessonAgentSelection;
  attachmentIds: string[];
  continuation?: boolean;
  thinkingLevel?: TeacherThinkingLevel;
  /** A server-owned generation request for this lesson, claimed by this run. */
  generationIntentId?: string;
  /** A server-owned classroom-feedback writeback for this framework. */
  frameworkWritebackIntentId?: string;
  /** Stable across network retries of the same browser command. */
  clientCommandId?: string;
};

/** Public facade and new-turn orchestration. Collaborators own execution, tools, and approvals. */
export class PiLessonAgentCoordinator {
  private readonly dashi: PiDashi | null;
  private readonly ready: Promise<SkillRegistry>;
  private readonly modelId: string;
  private readonly lifecycle: PiRunLifecycle;
  private readonly executor: PiAgentExecutor;
  private readonly toolSurface: PiToolSurface;
  private readonly approvals: PiApprovalWorkflow;
  constructor(
    private readonly repository: LessonRepository,
    options: {
      model?: Model<any>;
      streamFn?: StreamFn;
      sessionSecret?: string;
      presentations?: PresentationService | null;
      dashi?: PiDashi | null;
      webProvider?: WebSearchProvider;
      registry?: SkillRegistry;
      /** Worker/DO-owned background lifetime; absent in the local Node runtime. */
      defer?: (task: Promise<unknown>) => void;
    } = {},
  ) {
    const definition = options.model && options.streamFn
      ? { primary: options.model, streamFn: options.streamFn }
      : createPiModelRuntime({
          apiKey: config.MODEL_API_KEY ?? "",
          baseUrl: config.MODEL_BASE_URL ?? "",
          modelId: config.MODEL_ID ?? "",
          api: config.MODEL_API!,
          contextWindow: config.MODEL_CONTEXT_WINDOW!,
          maxTokens: config.MODEL_MAX_TOKENS!,
        });
    const model = definition.primary;
    const streamFn: StreamFn = (model, context, options) => definition.streamFn(model, context, {
      ...options, cacheRetention: options?.cacheRetention ?? "short",
    });
    this.modelId = model.id;
    const sessionSecret = options.sessionSecret ?? config.AGENT_STATE_ENCRYPTION_KEY
      ?? "lessonup-development-pi-session-secret";
    if (sessionSecret.length < 32) throw new Error("pi_session_secret_invalid");
    this.dashi = options.dashi ?? null;
    const registry = options.registry ?? new SkillRegistry();
    this.ready = registry.load();
    // Fast turns do not wait for skills; observe load failures until a turn needs them.
    void this.ready.catch(() => undefined);
    this.lifecycle = new PiRunLifecycle(repository);
    this.executor = new PiAgentExecutor(repository, model, streamFn, sessionSecret, this.lifecycle, options.defer);
    this.toolSurface = new PiToolSurface(repository, registry,
      options.webProvider ?? new UnavailableWebSearchProvider(), this.dashi);
    this.approvals = new PiApprovalWorkflow(repository, this.lifecycle, this.executor,
      this.toolSurface, this.ready, this.dashi, options.presentations ?? null);
  }

  cancel(...args: Parameters<PiRunLifecycle["cancel"]>) { return this.lifecycle.cancel(...args); }
  queueInput(...args: Parameters<PiRunLifecycle["queueInput"]>) { return this.lifecycle.queueInput(...args); }
  clearQueuedInputs(...args: Parameters<PiRunLifecycle["clearQueuedInputs"]>) { return this.lifecycle.clearQueuedInputs(...args); }
  resumeApproval(...args: Parameters<PiApprovalWorkflow["resume"]>) { return this.approvals.resume(...args); }

  private async replayRun(run: AgentRunRecord, emit: Emit) {
    const events = await this.repository.listRunEvents(run.ownerId, run.id);
    if (!events.some((event) => event.type === "run.started")) {
      await emit({
        type: "run.started",
        runId: run.id,
        threadId: run.threadId,
        branchId: run.branchId,
        startedAt: run.startedAt,
      }, { persist: false });
    }
    for (const event of events) await emit(event, { persist: false });
  }

  async start(input: PiStartRunInput, emit: Emit) {
    await this.repository.recoverExpiredRuns(input.userId, input.threadId);
    const commandFingerprint = fingerprintRunCommand(input);
    if (input.clientCommandId) {
      const replay = await this.repository.getRunByClientCommand(
        input.userId,
        input.threadId,
        input.clientCommandId,
      );
      if (replay) {
        if (replay.commandFingerprint !== commandFingerprint) throw new Error("idempotency_conflict");
        // A duplicate HTTP request is a recovery reader, not a second waiter
        // on the full model run. Replay the current durable waterline now; the
        // browser will keep following an active run through snapshot recovery.
        await this.replayRun(replay, emit);
        return;
      }
    }
    const [existingThread, pendingOnBranch] = await Promise.all([
      this.repository.getThread(input.userId, input.threadId),
      this.repository.listPendingApprovals(input.userId, input.threadId, input.branchId),
    ]);
    if (!existingThread) throw new Error("thread_not_found");
    if (["running", "awaiting_approval"].includes(existingThread.status)) {
      throw new Error("active_run_exists");
    }
    if (pendingOnBranch.some((item) => item.state === "pending")) {
      throw new Error("active_run_exists");
    }
    if (input.generationIntentId && input.frameworkWritebackIntentId) {
      throw new Error("multiple_start_intents_invalid");
    }
    if (input.generationIntentId) {
      if (existingThread.resourceType !== "lesson_file") {
        throw new Error("lesson_generation_intent_scope_invalid");
      }
      const intent = await this.repository.getPendingLessonGenerationIntent(
        input.userId,
        existingThread.lessonFileId,
      );
      if (!intent || intent.id !== input.generationIntentId) {
        throw new Error("lesson_generation_intent_unavailable");
      }
    }
    if (input.frameworkWritebackIntentId) {
      if (existingThread.resourceType !== "semester_framework") {
        throw new Error("semester_framework_writeback_intent_scope_invalid");
      }
      const intent = await this.repository.getPendingSemesterFrameworkWritebackIntent(
        input.userId,
        existingThread.semesterFrameworkId,
      );
      if (!intent || intent.id !== input.frameworkWritebackIntentId) {
        throw new Error("semester_framework_writeback_intent_unavailable");
      }
    }
    const continuationRun = input.continuation
      ? await this.repository.getLatestRun(input.userId, input.threadId, input.branchId)
      : null;
    if (input.continuation && continuationRun?.status !== "failed") {
      throw new Error("run_not_continuable");
    }
    const effectiveInput = continuationRun
      ? { ...input, attachmentIds: continuationRun.attachmentSourceIds ?? [] }
      : input;
    const runId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    // Message order is part of the durable transcript contract. D1 orders by
    // timestamp then opaque id, so make the placeholder deterministically
    // follow the accepted user message even when both records share one batch.
    const assistantPlaceholderAt = new Date(Date.parse(startedAt) + 1).toISOString();
    const userMessageId = continuationRun ? undefined : crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const controller = new AbortController();
    let execution: ReturnType<PiRunLifecycle["open"]> | undefined;
    let userMessage: AgentMessageRecord | undefined;
    let assistant: AgentMessageRecord | undefined;
    let content = "";
    let created = false;
    let capturedProposal: (() => PiCapturedProposal | null) | undefined;
    try {
      const runRecord = {
        id: runId,
        ownerId: input.userId,
        threadId: input.threadId,
        branchId: input.branchId,
        model: this.modelId,
        status: "queued",
        agentDefinitionVersion: piAgentDefinitionVersion,
        generationIntentId: input.generationIntentId ?? input.frameworkWritebackIntentId,
        clientCommandId: input.clientCommandId,
        commandFingerprint,
        userMessageId,
        assistantMessageId,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
        heartbeatAt: startedAt,
        startedAt,
      } satisfies AgentRunRecord;
      const assistantRecord: AgentMessageRecord = {
        id: assistantMessageId,
        ownerId: input.userId,
        threadId: input.threadId,
        branchId: input.branchId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: assistantPlaceholderAt,
      };
      const userRecord: AgentMessageRecord | undefined = userMessageId
        ? {
          id: userMessageId,
          ownerId: input.userId,
          threadId: input.threadId,
          branchId: input.branchId,
          role: "user",
          content: input.message,
          status: "completed",
          createdAt: startedAt,
        }
        : undefined;
      const initialPlan = continuationRun?.capabilityPlan
        ?? await routeCapabilities(input.message, {
          signal: controller.signal,
          attachmentSourceIds: effectiveInput.attachmentIds,
          activeSectionId: input.activeSectionId,
          selectionField: input.selection?.field,
        });
      const skipDesignBasis = isFastExecution(initialPlan, effectiveInput, continuationRun);
      const contextP = loadPreparationContext(this.repository, {
        ...effectiveInput,
        runId,
        signal: controller.signal,
        skipDesignBasis,
      });
      let persisted: Awaited<ReturnType<LessonRepository["createRunWithInitialMessages"]>>;
      try {
        persisted = await this.repository.createRunWithInitialMessages({
          run: runRecord,
          userMessage: userRecord,
          assistantMessage: assistantRecord,
        });
      } catch (error) {
        await contextP.catch(() => undefined);
        if (input.clientCommandId) {
          const replay = await this.repository.getRunByClientCommand(
            input.userId,
            input.threadId,
            input.clientCommandId,
          ).catch(() => null);
          if (replay) {
            if (replay.commandFingerprint !== commandFingerprint) throw new Error("idempotency_conflict");
            await this.replayRun(replay, emit);
            return;
          }
        }
        throw error;
      }
      created = true;
      if (input.generationIntentId) {
        if (
          continuationRun
          || existingThread.resourceType !== "lesson_file"
          || existingThread.lessonFileId === undefined
        ) throw new Error("lesson_generation_intent_scope_invalid");
        await this.repository.claimLessonGenerationIntent({
          ownerId: input.userId,
          lessonFileId: existingThread.lessonFileId,
          intentId: input.generationIntentId,
          runId,
        });
      }
      if (input.frameworkWritebackIntentId) {
        if (
          continuationRun
          || existingThread.resourceType !== "semester_framework"
        ) throw new Error("semester_framework_writeback_intent_scope_invalid");
        await this.repository.claimSemesterFrameworkWritebackIntent({
          ownerId: input.userId,
          frameworkId: existingThread.semesterFrameworkId,
          intentId: input.frameworkWritebackIntentId,
          runId,
        });
      }
      userMessage = persisted.userMessage ?? (continuationRun
        ? [...await this.repository.listMessages(input.userId, input.threadId, input.branchId)]
            .reverse().find((message) => message.role === "user")
        : undefined);
      assistant = persisted.assistantMessage;
      if (!userMessage) throw new Error("run_not_continuable");
      execution = this.lifecycle.open({ userId: input.userId, runId, leaseToken, controller }, emit);
      await execution.startHeartbeat();
      await emit({
        type: "run.started",
        runId,
        threadId: input.threadId,
        branchId: input.branchId,
        startedAt: persisted.run.startedAt,
      });
      const loaded = await contextP;
      const context = loaded.context;
      const lessonContext = isSemesterFrameworkAgentContext(context)
        ? null
        : context as LessonAgentContext;
      const attachments: SourceRef[] = !lessonContext
        ? []
        : continuationRun
          ? userMessage.sources ?? []
          : await this.repository.attachKnowledgeSources(
            input.userId,
            lessonContext.lessonFileId,
            userMessage.id,
            input.attachmentIds,
          );
      if (attachments.length) {
        await this.repository.updateMessage(input.userId, userMessage.id, { sources: attachments });
      }
      let plan: CapabilityPlan;
      let skills: PlatformSkill[];
      let pinnedSkills: PlatformSkill[];
      let runtimeTools: ReturnType<PiToolSurface["toolsForLesson"]>;
      let runtimeTurnContext: unknown;
      if (isSemesterFrameworkAgentContext(context)) {
        plan = { ...initialPlan, skillIds: [], specialistAgents: [], presentationRequested: false };
        const fast = isFastExecution(plan, effectiveInput, continuationRun);
        const resolvedTurn = resolveTurn({ plan });
        skills = [];
        pinnedSkills = [];
        if (!fast) await this.ready;
        runtimeTools = fast ? emptyRuntimeTools() : this.toolSurface.toolsForSemester(context, plan, resolvedTurn.toolSurface);
        runtimeTurnContext = semesterTurnContext(context, plan, fast ? "none" : resolvedTurn.toolSurface);
      } else {
        const currentLesson = context as LessonAgentContext;
        currentLesson.attachmentSourceIds = attachments.map((source) => source.id);
        plan = continuationRun?.capabilityPlan ?? (
          skipDesignBasis
            ? initialPlan
            : await routeCapabilities(input.message, {
              signal: controller.signal,
              document: loaded.document,
              attachmentSourceIds: currentLesson.attachmentSourceIds,
              hasUpstreamPlanningContext: loaded.hasUpstreamPlanningContext,
              activeSectionId: currentLesson.activeSectionId,
              selectionField: currentLesson.selection?.field,
            })
        );
        const branch = await this.repository.getBranch(input.userId, input.threadId, input.branchId);
        if (!branch) throw new Error("thread_scope_invalid");
        const presentationTurn = continuationRun ? null : resolvePresentationTurn({
          message: input.message,
          routedPlan: plan,
          pendingInteraction: branch.pendingInteraction,
          documentVersion: currentLesson.documentVersion,
        });
        if (presentationTurn) plan = presentationTurn.plan;
        const presentationRequest = presentationTurn?.presentationRequest
          ?? branch.pendingInteraction?.originalRequest
          ?? input.message;
        if (presentationTurn && JSON.stringify(branch.pendingInteraction ?? null) !== JSON.stringify(presentationTurn.pendingInteraction)) {
          await this.repository.updateBranch(input.userId, input.threadId, input.branchId, {
            pendingInteraction: presentationTurn.pendingInteraction,
          });
        }
        if (plan.presentationRequested && !this.dashi) {
          throw new Error("presentation_renderer_unavailable");
        }
        const fast = isFastExecution(plan, effectiveInput, continuationRun);
        const resolvedTurn = resolveTurn({ plan });
        if (fast) {
          pinnedSkills = [];
          skills = [];
          runtimeTools = emptyRuntimeTools();
          runtimeTurnContext = lessonTurnContext(currentLesson, attachments, plan, "none", presentationRequest);
        } else {
          // Skill discovery is irrelevant to Fast chat. Its cold-start work
          // runs in parallel from construction and is awaited only once this
          // turn has actually selected the Agent lane.
          await this.ready;
          if (skipDesignBasis) {
            const basis = await this.repository.getLessonDesignBasis(input.userId, currentLesson.lessonFileId);
            if (!basis) throw new Error("thread_scope_invalid");
            currentLesson.designBasisVersion = basis.basis.version;
          }
          const recentPresentationDesigns = plan.presentationRequested && !plan.presentationThemeConfirmationRequired
            ? (await this.repository.listRecentClassroomPresentations(input.userId, 8)).map((presentation) => ({
                theme: presentation.theme,
                layouts: presentation.dashiGoal?.slides.map((slide) => slide.layout) ?? [],
              }))
            : [];
          pinnedSkills = this.toolSurface.skillsForSurface(plan, resolvedTurn.toolSurface);
          skills = pinnedSkills;
          runtimeTools = this.toolSurface.toolsForLesson(
            currentLesson,
            plan,
            pinnedSkills,
            resolvedTurn.toolSurface,
            runId,
            presentationLanguageForRequest(presentationRequest),
          );
          runtimeTurnContext = lessonTurnContext(
            currentLesson,
            attachments,
            plan,
            resolvedTurn.toolSurface,
            presentationRequest,
            recentPresentationDesigns,
          );
        }
      }
      const fastLane = isFastExecution(plan, effectiveInput, continuationRun);
      capturedProposal = () => runtimeTools.getProposal() as PiCapturedProposal | null;
      await this.repository.updateRun(input.userId, runId, {
        status: "running",
        capabilityPlan: plan,
        attachmentSourceIds: context.attachmentSourceIds,
        skillVersions: Object.fromEntries(pinnedSkills.map((skill) => [skill.id, skill.version])),
      });
      const checkpoint = createMessageCheckpoint({
        persist: (snapshot) => this.repository.updateMessage(
          input.userId,
          assistant!.id,
          { content: snapshot, status: "streaming" },
        ),
      });
      const presentationCompletionPrompt = [
        "你还没有完成教师要求的课堂演示任务。",
        "继续使用会话中同一教案版本的完整读取结果和已经取得的 Dashi 候选，避免重复查询。保留已经判断为必要的课堂材料、学生行动、揭示与检验，不要为尽快通过而删减。若最终 layout 尚未检查则批量检查，然后直接提交 title、goal 和 slides 到 propose_classroom_presentation。",
        "不要输出过程说明，不要创建中间脚本。",
      ].join("\n");
      const writeCompletionPrompt = isSemesterFrameworkAgentContext(context)
        ? [
            "教师要求修改当前学期框架，但本轮尚未产生可确认的修改提案。",
            "继续使用当前会话里已经读取的规范框架与工具错误；仅在信息确实缺失时补读，然后调用 propose_semester_framework_patch。",
            "如果上一次提案被工具拒绝，按返回的结构化错误修正，不要用文字宣称已完成。",
          ].join("\n")
        : [
            "教师要求修改当前 A4 教案，但本轮尚未产生可确认的修改提案。",
            "继续使用当前会话里已经读取的规范教案与工具错误；每项修改提交完整语义字段 replacement，由服务端绑定当前字段快照，不要复述或猜测定位原文。",
            "调用 propose_document_patch；如果上一次提案被工具拒绝，按返回的结构化错误修正，不要用文字宣称已完成。",
          ].join("\n");
      const requiredCompletion = fastLane
        ? undefined
        : plan.presentationRequested && !plan.presentationThemeConfirmationRequired
        ? {
            isComplete: () => runtimeTools.getProposal()?.patchKind === "presentation_storyboard",
            followUp: presentationCompletionPrompt,
            maxFollowUps: 2,
          }
        : plan.writeMode === "explicit"
          ? {
              isComplete: () => {
                const proposal = runtimeTools.getProposal();
                return proposal != null && proposal.patchKind !== "presentation_storyboard";
              },
              followUp: writeCompletionPrompt,
              maxFollowUps: 2,
            }
          : undefined;
      const result = await this.executor.run({
        runId,
        scope: { ownerId: input.userId, threadId: input.threadId, branchId: input.branchId },
        turnContext: runtimeTurnContext,
        input: input.message,
        continueExisting: Boolean(continuationRun),
        tools: runtimeTools.tools,
        skills,
        maxTurns: fastLane
          ? 2
          : plan.presentationRequested && !plan.presentationThemeConfirmationRequired
          ? 24
          : plan.fullRewriteRequested ? 8 : 16,
        requiredCompletion,
        thinkingLevel: resolveRunThinkingLevel({
          lane: fastLane ? "fast" : "agent",
          requested: input.thinkingLevel,
        }),
        lane: fastLane ? "fast" : "agent",
        signal: controller.signal,
        emit,
        onCapturedProposal: async (session) => {
          const proposal = capturedProposal?.();
          if (!proposal || !assistant) return;
          await this.approvals.commit({
            userId: input.userId,
            threadId: input.threadId,
            branchId: input.branchId,
            runId,
            leaseToken,
            assistant,
            proposal,
            content,
            sessionRevision: session.revision,
            sessionCursor: session.cursor,
            skillVersions: Object.fromEntries(pinnedSkills.map((skill) => [skill.id, skill.version])),
            emit,
            settle: false,
          });
        },
        onTextDelta: async (delta, turn) => {
          // Presentation prose between tool calls remains private work. The
          // validated approval card is the public artifact for that workflow.
          if (plan.presentationRequested && !plan.presentationThemeConfirmationRequired) return false;
          content += delta;
          assistant!.content = content;
          checkpoint.update(content);
          await emit({ type: "message.delta", runId, delta, turn });
          return true;
        },
      });
      await checkpoint.flush(content);
      controller.signal.throwIfAborted();
      const proposal = runtimeTools.getProposal() as PiCapturedProposal | null;
      if (
        plan.presentationRequested
        && !plan.presentationThemeConfirmationRequired
        && proposal?.patchKind !== "presentation_storyboard"
      ) {
        throw new Error("presentation_proposal_missing");
      }
      if (plan.writeMode === "explicit" && (!proposal || proposal.patchKind === "presentation_storyboard")) {
        throw new Error("write_proposal_missing");
      }
      const evidence = await this.repository.listRunEvidence(input.userId, runId);
      if (!proposal && validateObservedEvidence({ plan, evidence }).tripwireTriggered) {
        throw new Error("evidence_required");
      }
      const sources = await emitRunEvidence(this.repository, input.userId, runId, emit);
      // Keep the model's own process narration on ordinary write turns so the
      // teacher can see which tool group a sentence belongs to. Dashi still
      // hides mid-run prose: the approval card is that workflow's public artifact.
      const hidePresentationProse = Boolean(proposal)
        && plan.presentationRequested
        && !plan.presentationThemeConfirmationRequired;
      content = hidePresentationProse ? "" : result.content || content || "";
      if (proposal) {
        await this.approvals.commit({
          userId: input.userId,
          threadId: input.threadId,
          branchId: input.branchId,
          runId,
          leaseToken,
          assistant,
          proposal,
          content,
          sources,
          sessionRevision: result.sessionRevision,
          sessionCursor: result.sessionCursor,
          skillVersions: result.skillVersions,
          tokenUsage: result.tokenUsage,
          emit,
          transportTiming: result.transportTiming,
          clearPresentationPending: plan.presentationRequested,
        });
        return;
      }
      await this.repository.settleRun({
        ownerId: input.userId,
        runId,
        leaseToken,
        status: "completed",
        tokenUsage: result.tokenUsage,
        messageStatus: "completed",
        messageContent: content,
        messageSources: sources,
        sessionCursor: result.sessionCursor,
      });
      const message = await this.repository.getMessage(input.userId, assistant.id) ?? assistant;
      await emit({ type: "message.completed", runId, message });
      await emit({ type: "run.completed", runId, transportTiming: result.transportTiming });
    } catch (error) {
      if (!created) throw error;
      if (controller.signal.aborted && controller.signal.reason === "user_cancelled") {
        await this.repository.settleRun({
          ownerId: input.userId,
          runId,
          leaseToken,
          status: "cancelled",
          messageStatus: "cancelled",
          messageContent: content,
        }).catch(() => undefined);
        await emit({ type: "run.cancelled", runId });
        return;
      }
      const pendingForRun = (await this.repository.listPendingApprovals(
        input.userId,
        input.threadId,
        input.branchId,
      ).catch(() => [])).find((item) => item.runId === runId && item.state === "pending");
      const proposal = capturedProposal?.() ?? proposalFromPendingApproval(pendingForRun);
      const assistantRecord = assistant
        ?? (pendingForRun?.assistantMessageId
          ? await this.repository.getMessage(input.userId, pendingForRun.assistantMessageId).catch(() => null)
          : null);
      if (proposal && assistantRecord) {
        try {
          const session = await this.repository.getAgentRuntimeSession(
            input.userId,
            input.threadId,
            input.branchId,
            "pi",
          );
          const sources = await emitRunEvidence(this.repository, input.userId, runId, emit).catch(() => undefined);
          await this.approvals.commit({
            userId: input.userId,
            threadId: input.threadId,
            branchId: input.branchId,
            runId,
            leaseToken,
            assistant: assistantRecord,
            proposal,
            content,
            sources,
            sessionRevision: session?.revision ?? 0,
            sessionCursor: session?.messages.length ?? 0,
            skillVersions: {},
            emit,
            clearPresentationPending: true,
          });
          return;
        } catch {
          // Keep the existing failure settlement if the captured proposal cannot be committed.
        }
      }
      const code = publicPiAgentError(error);
      await this.repository.settleRun({
        ownerId: input.userId,
        runId,
        leaseToken,
        status: "failed",
        error: code,
        messageStatus: "failed",
        messageContent: content,
      }).catch(() => undefined);
      const message = assistant
        ? await this.repository.getMessage(input.userId, assistant.id).catch(() => null)
        : null;
      await emit({ type: "run.failed", runId, error: code, message: message ?? undefined });
    } finally {
      await execution?.close();
    }
  }

}

function fingerprintRunCommand(input: PiStartRunInput) {
  return JSON.stringify({
    threadId: input.threadId,
    branchId: input.branchId,
    message: input.message,
    activeSectionId: input.activeSectionId,
    activeUnitId: input.activeUnitId ?? null,
    documentVersion: input.documentVersion,
    selection: input.selection ?? null,
    attachmentIds: input.attachmentIds,
    continuation: input.continuation ?? false,
    generationIntentId: input.generationIntentId ?? null,
    frameworkWritebackIntentId: input.frameworkWritebackIntentId ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
  });
}

function proposalFromPendingApproval(
  approval: AgentApprovalRecord | undefined,
): PiCapturedProposal | null {
  if (!approval?.toolCallId) return null;
  const patchKind = approval.patchKind === "semester_framework"
    || approval.patchKind === "lesson_design_basis"
    || approval.patchKind === "presentation_storyboard"
    ? approval.patchKind
    : "document";
  return {
    toolCallId: approval.toolCallId,
    patch: approval.patch,
    resourceType: approval.resourceType
      ?? (patchKind === "semester_framework" ? "semester_framework" : "lesson_file"),
    patchKind,
    lessonFileId: approval.lessonFileId,
    semesterFrameworkId: approval.semesterFrameworkId,
    baseResourceVersion: approval.baseResourceVersion ?? 0,
    documentVersion: approval.documentVersion,
  };
}
