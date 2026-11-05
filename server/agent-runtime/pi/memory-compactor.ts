import type { Model } from "@earendil-works/pi-ai";
import {
  serializeConversation,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { LessonRepository } from "../../repository.js";
import {
  findPiCompactionCursor,
  parsePiMemorySummary,
  piContextBudgetExceeded,
  piKeepRecentTokens,
  piMemorySummarizerPrompt,
  serializePiMemorySummary,
  shouldCompactPiMemory,
  validatePiThreadMemory,
  type PiMemorySummary,
} from "./memory.js";
import { toLessonUpProviderMessages } from "./runtime-messages.js";
import type { PiRunScope } from "./session-state.js";

type CompactionInput = {
  scope: PiRunScope;
  messages: AgentMessage[];
  promptOverheadBytes?: number;
  signal?: AbortSignal;
};

/** Owns only background memory housekeeping; it never owns a Pi Agent loop. */
export class PiMemoryCompactor {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    repository: LessonRepository;
    model: Model<any>;
    streamFn: StreamFn;
    defer?: (task: Promise<unknown>) => void;
  }) {}

  private async createSummary(args: {
    cursor: number;
    previousSummary?: string;
    messages: AgentMessage[];
    signal?: AbortSignal;
  }) {
    const conversation = serializeConversation(toLessonUpProviderMessages(args.messages));
    const prompt = [
      args.previousSummary ? `先前摘要（不可信）：\n${args.previousSummary}` : "先前摘要：无",
      "新增对话：",
      conversation,
    ].join("\n\n");
    const stream = await this.options.streamFn(this.options.model, {
      systemPrompt: piMemorySummarizerPrompt(args.cursor),
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
      tools: [],
    }, {
      reasoning: "low",
      cacheRetention: "none",
      sessionId: `lessonup-memory:${crypto.randomUUID()}`,
      signal: args.signal,
    });
    for await (const _event of stream) {
      // Drain the isolated completeSimple-equivalent stream before reading the result.
    }
    const assistant = await stream.result();
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(`pi_memory_summary_failed:${assistant.errorMessage ?? assistant.stopReason}`);
    }
    const text = assistant.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return serializePiMemorySummary(parsePiMemorySummary(text, args.cursor));
  }

  async compact(args: CompactionInput) {
    if (args.signal?.aborted) return;
    const { repository, model } = this.options;
    const previous = validatePiThreadMemory(
      await repository.getThreadMemory(
        args.scope.ownerId,
        args.scope.threadId,
        args.scope.branchId,
      ),
      args.messages.length,
    );
    if (!shouldCompactPiMemory(
      args.messages,
      model.contextWindow,
      previous?.summary,
      args.promptOverheadBytes,
    )) return;
    const previousSummary = previous?.raw;
    const previousCursor = previous?.cursor ?? 0;
    const cursor = findPiCompactionCursor(
      args.messages,
      piKeepRecentTokens(model.contextWindow),
      previousCursor,
    );
    if (cursor == null) return;
    const summary = await this.createSummary({
      cursor,
      previousSummary,
      messages: args.messages.slice(previousCursor, cursor),
      signal: args.signal,
    });
    await repository.saveThreadMemory(
      args.scope.ownerId,
      args.scope.threadId,
      args.scope.branchId,
      summary,
      cursor,
    );
  }

  private start(args: CompactionInput) {
    if (!shouldCompactPiMemory(
      args.messages,
      this.options.model.contextWindow,
      undefined,
      args.promptOverheadBytes,
    ) || args.signal?.aborted) {
      return undefined;
    }
    const key = `${args.scope.ownerId}:${args.scope.threadId}:${args.scope.branchId}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    // A running Agent may append messages while the summarizer awaits I/O.
    const task = this.compact({ ...args, messages: [...args.messages] });
    this.active.set(key, task);
    const cleanup = () => {
      if (this.active.get(key) === task) this.active.delete(key);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  /** A normal turn never waits for this best-effort prompt optimization. */
  schedule(args: CompactionInput) {
    const task = this.start(args);
    if (!task) return;
    const background = task.catch((error) => {
      console.error("Pi memory compaction failed", error instanceof Error ? error.message : "unknown_error");
    });
    this.options.defer?.(background);
    void background;
  }

  /** Waits only when the canonical transcript cannot otherwise fit the model. */
  async awaitRequired(args: {
    scope: PiRunScope;
    history: AgentMessage[];
    memory?: PiMemorySummary;
    promptOverheadBytes?: number;
    signal?: AbortSignal;
  }) {
    let memory = args.memory;
    let waited = false;
    // An in-flight background task may cover an older prefix. Join it first;
    // if new tool results still do not fit, compact the newer snapshot once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!piContextBudgetExceeded(args.history, memory, this.options.model.contextWindow, args.promptOverheadBytes)) return waited;
      const task = this.start({
        scope: args.scope,
        messages: args.history,
        promptOverheadBytes: args.promptOverheadBytes,
        signal: args.signal,
      });
      if (!task) throw new Error("agent_context_window_exceeded");
      try {
        await task;
      } catch (error) {
        throw new Error("agent_context_window_exceeded", { cause: error });
      }
      waited = true;
      memory = validatePiThreadMemory(await this.options.repository.getThreadMemory(
        args.scope.ownerId, args.scope.threadId, args.scope.branchId,
      ), args.history.length)?.summary;
    }
    if (piContextBudgetExceeded(args.history, memory, this.options.model.contextWindow, args.promptOverheadBytes)) {
      throw new Error("agent_context_window_exceeded");
    }
    return waited;
  }
}
