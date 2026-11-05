import { createHmac } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { LessonRepository } from "../../repository.js";
import { type PlatformSkill } from "../../agent/skill-registry.js";
import { decodePiAgentMessages, encodePiAgentMessages } from "./message-codec.js";
import { piContextBudgetExceeded, piProviderPromptOverheadBytes, validatePiThreadMemory } from "./memory.js";
import { bindFastProviderContext, bindProviderContext, FAST_SYSTEM_INSTRUCTIONS, STATIC_SYSTEM_INSTRUCTIONS } from "./prompt-layout.js";
import { DEFAULT_TEACHER_THINKING_LEVEL, type TeacherThinkingLevel } from "./thinking-level.js";
import { firstChangedRuntimeMessageIndex } from "../../repositories/runtime-session-persist.js";
import { assertSkillTools, assistantText, durableProtocolSnapshot, isApprovalRequiredToolResult, isSettledTranscriptTail, rejectOrphanApprovalRequiredResults, repairDurableHistory, systemPromptWithSkills, type PiAgentRunResult, type PiRequiredCompletion, type PiRunScope } from "./session-state.js";
import { toLessonUpProviderMessages } from "./runtime-messages.js";
import { projectPublicPiEvents } from "./public-event-projection.js";
import { PiTransportTimer } from "./transport-timing.js";
import { PiMemoryCompactor } from "./memory-compactor.js";
import { type Emit } from "./contracts.js";
import { DashiPlanningError } from "../../presentations/dashi-planning-errors.js";
import type { PiRunLifecycle } from "./run-lifecycle.js";

/** Adapts native Pi execution to durable branch transcripts and public events.
 * Pi owns its model/tool loop. This class has no approval or delivery policy. */
export class PiAgentExecutor {
  private readonly memoryCompactor: PiMemoryCompactor;
  constructor(
    private readonly repository: LessonRepository,
    private readonly model: Model<any>,
    private readonly streamFn: StreamFn,
    private readonly sessionSecret: string,
    private readonly lifecycle: Pick<PiRunLifecycle, "attachActiveAgent">,
    defer?: (task: Promise<unknown>) => void,
  ) {
    this.memoryCompactor = new PiMemoryCompactor({ repository, model, streamFn, defer });
  }
  async run(args: {
    runId: string;
    scope: PiRunScope;
    turnContext: unknown;
    input: string | AgentMessage;
    continueExisting?: boolean;
    tools?: AgentTool<any>[];
    skills?: PlatformSkill[];
    maxTurns?: number;
    requiredCompletion?: PiRequiredCompletion;
    signal?: AbortSignal;
    onTextDelta?: (delta: string, turn: number) => void | boolean | Promise<void | boolean>;
    emit: Emit;
    thinkingLevel?: TeacherThinkingLevel;
    lane?: "fast" | "agent";
    onCapturedProposal?: (session: { revision: number; cursor: number }) => void | Promise<void>;
    documentDraftScope?: { fileId: string; baseDocumentVersion: number };
    getTerminalToolError?: () => Error | null;
  }): Promise<PiAgentRunResult> {
    const { ownerId, threadId, branchId } = args.scope;
    const lane = args.lane ?? "agent";
    const [thread, branch, snapshot, storedMemory, approvals] = await Promise.all([
      this.repository.getThread(ownerId, threadId),
      this.repository.getBranch(ownerId, threadId, branchId),
      this.repository.getAgentRuntimeSession(ownerId, threadId, branchId, "pi"),
      lane === "fast"
        ? Promise.resolve(null)
        : this.repository.getThreadMemory(ownerId, threadId, branchId),
      this.repository.listApprovals(ownerId, threadId, branchId),
    ]);
    if (!thread || !branch) throw new Error("pi_run_scope_invalid");

    const tools = args.tools ?? [];
    const skills = args.skills ?? [];
    assertSkillTools(skills, tools);
    const systemPrompt = lane === "fast"
      ? FAST_SYSTEM_INSTRUCTIONS
      : systemPromptWithSkills(STATIC_SYSTEM_INSTRUCTIONS, skills);
    let durableHistory = repairDurableHistory(decodePiAgentMessages(snapshot?.messages ?? []));
    const knownApprovalToolCallIds = new Set(
      approvals
        .map((item) => item.toolCallId)
        .filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
    );
    // A4 decisions no longer run another model turn. Supply their durable facts
    // in the dynamic context on the next turn without rewriting raw history.
    const turnContext = {
      ...(args.turnContext && typeof args.turnContext === "object" ? args.turnContext : {}),
      documentDecisions: approvals.filter((item) => "baseDocumentVersion" in item.patch).map((item) => ({
        id: item.id, toolCallId: item.toolCallId, state: item.state, summary: item.patch.summary,
      })),
    };
    const promptOverheadBytes = piProviderPromptOverheadBytes({ systemPrompt, tools, turnContext });
    durableHistory = rejectOrphanApprovalRequiredResults(durableHistory, knownApprovalToolCallIds);
    let expectedRevision = snapshot?.revision ?? 0;
    let lastSaved = snapshot ?? null;
    let persistedCount = durableHistory.length;
    const repairedMessages = encodePiAgentMessages(durableHistory);
    if (snapshot && JSON.stringify(repairedMessages) !== JSON.stringify(snapshot.messages)) {
      lastSaved = await this.repository.saveAgentRuntimeSession({
        ownerId,
        threadId,
        branchId,
        runtime: "pi",
        expectedRevision,
        messages: repairedMessages,
        rewriteFrom: firstChangedRuntimeMessageIndex(snapshot.messages, repairedMessages),
      });
      expectedRevision = lastSaved.revision;
      persistedCount = lastSaved.messages.length;
    }
    let memory = validatePiThreadMemory(storedMemory, durableHistory.length)?.summary;
    if (lane !== "fast" && await this.memoryCompactor.awaitRequired({
      scope: args.scope,
      history: durableHistory,
      memory,
      promptOverheadBytes,
      signal: args.signal,
    })) {
      memory = validatePiThreadMemory(
        await this.repository.getThreadMemory(ownerId, threadId, branchId),
        durableHistory.length,
      )?.summary;
      if (piContextBudgetExceeded(
        durableHistory,
        memory,
        this.model.contextWindow,
        promptOverheadBytes,
      )) {
        throw new Error("agent_context_window_exceeded");
      }
    }
    if (lane !== "fast") this.memoryCompactor.schedule({
      scope: args.scope,
      messages: durableHistory,
      promptOverheadBytes,
      signal: args.signal,
    });

    let turnCount = 0;
    let completionAttempts = 0;
    let turnToolTerminates: boolean[] = [];
    let compactBeforeNextLlm = false;
    let pendingCompletionFollowUp: string | undefined;
    let proposalFailure: string | undefined;
    let repeatedProposalError: Error | null = null;
    const terminalToolError = () => repeatedProposalError ?? args.getTerminalToolError?.() ?? null;
    const providerSessionId = createHmac("sha256", this.sessionSecret)
      .update(JSON.stringify([ownerId, threadId, branchId]))
      .digest("hex");
    const transportTimer = new PiTransportTimer();
    let agent: Agent;
    agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.model,
        thinkingLevel: args.thinkingLevel ?? DEFAULT_TEACHER_THINKING_LEVEL,
        tools,
        messages: durableHistory,
      },
      streamFn: this.streamFn,
      onPayload: (payload) => {
        transportTimer.onPayload(payload);
      },
      onResponse: (response) => {
        transportTimer.onResponse(response);
      },
      convertToLlm: toLessonUpProviderMessages,
      sessionId: providerSessionId,
      toolExecution: "parallel",
      transformContext: async (messages) => (
        lane === "fast"
          ? bindFastProviderContext({
            messages,
            turnContext,
          })
          : bindProviderContext({
            messages,
            memory,
            turnContext,
          })
      ),
      shouldStopAfterTurn: (context) => {
        turnCount += 1;
        if (terminalToolError()) return true;
        const toolCalls = context.message.content.filter((block) => block.type === "toolCall");
        const innerLoopContinues = toolCalls.length > 0
          && !(turnToolTerminates.length > 0 && turnToolTerminates.every(Boolean));
        turnToolTerminates = [];
        if (turnCount >= (args.maxTurns ?? 16)) return true;
        const compactNow = piContextBudgetExceeded(
          context.context.messages,
          memory,
          this.model.contextWindow,
          promptOverheadBytes,
        );
        if (lane !== "fast" && !compactNow) this.memoryCompactor.schedule({
          scope: args.scope,
          messages: context.context.messages,
          promptOverheadBytes,
          signal: args.signal,
        });
        if (innerLoopContinues) {
          if (compactNow) {
            compactBeforeNextLlm = true;
            return true;
          }
          return false;
        }
        if (
          args.requiredCompletion
          && !args.requiredCompletion.isComplete()
          && !args.signal?.aborted
          && completionAttempts < (args.requiredCompletion.maxFollowUps ?? 1)
        ) {
          completionAttempts += 1;
          if (compactNow) {
            compactBeforeNextLlm = true;
            pendingCompletionFollowUp = args.requiredCompletion.followUp;
            return true;
          }
          agent.followUp({
            role: "user",
            content: [{ type: "text", text: args.requiredCompletion.followUp }],
            timestamp: Date.now(),
          });
        }
        return false;
      },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const persistSettledTranscript = async () => {
      const prefix = durableProtocolSnapshot(agent.state.messages);
      if (prefix.length === 0) return lastSaved;
      if (prefix.length <= persistedCount && lastSaved) return lastSaved;
      lastSaved = await this.repository.saveAgentRuntimeSession({
        ownerId,
        threadId,
        branchId,
        runtime: "pi",
        expectedRevision,
        messages: encodePiAgentMessages(prefix),
      });
      expectedRevision = lastSaved.revision;
      persistedCount = prefix.length;
      const tail = prefix.at(-1);
      if (
        tail
        && isApprovalRequiredToolResult(tail)
        && !args.signal?.aborted
      ) {
        await args.onCapturedProposal?.({
          revision: lastSaved.revision,
          cursor: lastSaved.messages.length,
        });
      }
      return lastSaved;
    };
    const unsubscribeTiming = agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        if (event.toolName === "propose_classroom_presentation") {
          const failure = event.isError ? JSON.stringify(event.result) : undefined;
          if (failure && failure === proposalFailure) {
            repeatedProposalError = new DashiPlanningError("presentation_proposal_blocked");
          }
          proposalFailure = failure;
        }
        turnToolTerminates.push(
          Boolean(event.result && typeof event.result === "object" && event.result.terminate === true),
        );
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        transportTimer.onAssistantMessageStart();
      }
      if (
        event.type === "message_update"
        && event.assistantMessageEvent.type === "text_delta"
        && event.assistantMessageEvent.delta.length > 0
      ) {
        transportTimer.onAssistantTextDelta();
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        transportTimer.onAssistantMessageEnd();
      }
    });
    const unsubscribePersist = agent.subscribe(async (event) => {
      if (event.type !== "message_end") return;
      const role = event.message.role;
      if (
        role !== "user"
        && role !== "assistant"
        && role !== "toolResult"
        && role !== "approval_outcome"
      ) return;
      await persistSettledTranscript();
    });
    this.lifecycle.attachActiveAgent(`${ownerId}:${args.runId}`, agent);
    const projection = projectPublicPiEvents({
      agent,
      runId: args.runId,
      signal: args.signal,
      emit: args.emit,
      onTextDelta: args.onTextDelta,
      documentDraftScope: args.documentDraftScope,
      getTerminalToolError: terminalToolError,
    });
    const abort = () => agent.abort();
    if (args.signal?.aborted) agent.abort();
    else args.signal?.addEventListener("abort", abort, { once: true });
    const initialMessageCount = durableHistory.length;
    try {
      if (args.continueExisting) {
        if (agent.state.messages.at(-1)?.role === "assistant") {
          agent.followUp({
            role: "user",
            content: [{
              type: "text",
              text: "Continue the interrupted task from the existing context. Preserve the teacher's original intent and language; do not restart or repeat completed reads and tool work.",
            }],
            timestamp: Date.now(),
          });
        }
        await agent.continue();
      } else if (typeof args.input === "string") {
        await agent.prompt(args.input);
      } else {
        await agent.prompt(args.input);
      }
      await agent.waitForIdle();
      let compactCycles = 0;
      while (
        compactBeforeNextLlm
        && compactCycles < 2
        && !args.signal?.aborted
        && !agent.state.errorMessage
        && !terminalToolError()
      ) {
        compactCycles += 1;
        compactBeforeNextLlm = false;
        await this.memoryCompactor.awaitRequired({
          scope: args.scope,
          history: agent.state.messages,
          memory,
          promptOverheadBytes,
          signal: args.signal,
        });
        memory = validatePiThreadMemory(
          await this.repository.getThreadMemory(ownerId, threadId, branchId),
          agent.state.messages.length,
        )?.summary;
        if (piContextBudgetExceeded(agent.state.messages, memory, this.model.contextWindow, promptOverheadBytes)) {
          throw new Error("agent_context_window_exceeded");
        }
        if (pendingCompletionFollowUp) {
          agent.followUp({
            role: "user",
            content: [{ type: "text", text: pendingCompletionFollowUp }],
            timestamp: Date.now(),
          });
          pendingCompletionFollowUp = undefined;
        }
        await persistSettledTranscript();
        await agent.continue();
        await agent.waitForIdle();
      }
      const terminalError = terminalToolError();
      if (terminalError) throw terminalError;
      if (projection.hasProtocolViolation()) throw new Error("pi_provider_protocol_text_detected");
      if (agent.state.errorMessage) throw new Error(`pi_run_failed:${agent.state.errorMessage}`);
      const newMessages = agent.state.messages.slice(initialMessageCount);
      if (!isSettledTranscriptTail(newMessages, 0)) throw new Error("pi_run_transcript_incomplete");
      const saved = await persistSettledTranscript();
      if (!saved) throw new Error("pi_runtime_session_missing");
      const tokenUsage = newMessages.reduce((usage, message) => {
        if (message.role !== "assistant") return usage;
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        usage.totalTokens += message.usage.totalTokens;
        return usage;
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      const transportTiming = transportTimer.snapshot();
      // Native transports report payload callbacks when available. The faux
      // provider intentionally omits them, but each completed assistant
      // message still represents exactly one successful provider request.
      const completedProviderRequests = newMessages.filter((message) => message.role === "assistant").length;
      this.memoryCompactor.schedule({
        scope: args.scope,
        messages: agent.state.messages,
        promptOverheadBytes,
        signal: args.signal,
      });
      return {
        content: assistantText(newMessages),
        sessionCursor: saved.messages.length,
        sessionRevision: saved.revision,
        skillVersions: Object.fromEntries(skills.map((skill) => [skill.id, skill.version])),
        tokenUsage: {
          ...tokenUsage,
          // Keep the established fields while also serving the evaluator's
          // durable metric contract. `cacheRead` is provider-reported cached
          // input rather than an application-side estimate.
          requests: Math.max(transportTiming.providerRequestCount, completedProviderRequests),
          inputTokens: tokenUsage.input,
          cachedInputTokens: tokenUsage.cacheRead,
        },
        transportTiming,
      };
    } catch (error) {
      await persistSettledTranscript().catch(() => undefined);
      throw error;
    } finally {
      args.signal?.removeEventListener("abort", abort);
      unsubscribePersist();
      unsubscribeTiming();
      projection.unsubscribe();
    }
  }

}
