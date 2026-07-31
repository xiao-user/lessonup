import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import type { LessonPlan, NormalizedAgentEvent } from "../domain.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { LessonAgentHarness } from "./harness.js";

const document: LessonPlan = {
  unit: "单元",
  period: "1",
  totalPeriods: "1",
  topic: "课题",
  objectives: "目标",
  focus: "重点",
  preparation: "准备",
  process: "过程",
  assessment: "评价",
  homework: "作业",
  board: "板书",
  reflection: "反思",
};

const usageData = {
  requests: 1,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};
const userId = "00000000-0000-4000-8000-000000000001";

class ScriptedSdkModel implements Model {
  private cursor = 0;

  constructor(private readonly rounds: AgentOutputItem[][]) {}

  private nextResponse(): ModelResponse {
    const output = this.rounds[this.cursor++];
    if (!output) throw new Error("scripted_model_exhausted");
    return {
      responseId: `response-${this.cursor}`,
      usage: new Usage(usageData),
      output,
    };
  }

  async getResponse(_request: ModelRequest) {
    return this.nextResponse();
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = this.nextResponse();
    yield { type: "response_started" };
    let text = "";
    for (const item of response.output) {
      if (item.type !== "message" || item.role !== "assistant") continue;
      for (const content of item.content) {
        if (content.type === "output_text") text += content.text;
      }
    }
    if (text) yield { type: "output_text_delta", delta: text };
    yield {
      type: "response_done",
      response: {
        id: response.responseId ?? crypto.randomUUID(),
        usage: usageData,
        output: response.output as any,
      },
    };
  }
}

class ScriptedSdkProvider implements ModelProvider {
  constructor(private readonly model: Model) {}
  getModel() {
    return this.model;
  }
}

class AbortableSdkModel implements Model {
  constructor(private readonly onDelta?: () => void) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("streaming_only");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: "response_started" };
    yield { type: "output_text_delta", delta: "已开始分析" };
    this.onDelta?.();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) {
        resolve();
        return;
      }
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class PausedStreamingSdkModel implements Model {
  private releaseSecondDelta = () => {};
  readonly continue = new Promise<void>((resolve) => {
    this.releaseSecondDelta = resolve;
  });

  release() {
    this.releaseSecondDelta();
  }

  async getResponse(): Promise<ModelResponse> {
    throw new Error("streaming_only");
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    const output = [assistantMessage("第一段第二段")];
    yield { type: "response_started" };
    yield { type: "output_text_delta", delta: "第一段" };
    await this.continue;
    yield { type: "output_text_delta", delta: "第二段" };
    yield {
      type: "response_done",
      response: {
        id: "response-streaming",
        usage: usageData,
        output: output as any,
      },
    };
  }
}

const functionCall = (callId: string, name: string, args: object): AgentOutputItem => ({
  type: "function_call",
  callId,
  name,
  status: "completed",
  arguments: JSON.stringify(args),
});

const assistantMessage = (text: string): AgentOutputItem => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});

class CapturingSdkModel implements Model {
  readonly requests: string[] = [];

  async getResponse(): Promise<ModelResponse> {
    throw new Error("streaming_only");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(JSON.stringify(request));
    const output = [assistantMessage("已收到。")];
    yield { type: "response_started" };
    yield { type: "output_text_delta", delta: "已收到。" };
    yield {
      type: "response_done",
      response: {
        id: `response-capture-${this.requests.length}`,
        usage: usageData,
        output: output as any,
      },
    };
  }
}

describe("real OpenAI Agents SDK harness path", () => {
  it("isolates real SDK input by thread and by forked branch", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-isolation",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-isolation",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const first = await repository.createThread(userId, {
      notebookId: "notebook-isolation",
      lessonFileId: "file-isolation",
      title: "会话 A",
    });
    const second = await repository.createThread(userId, {
      notebookId: "notebook-isolation",
      lessonFileId: "file-isolation",
      title: "会话 B",
    });
    const model = new CapturingSdkModel();
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const run = (scope: typeof first, marker: string) => harness.start({
      userId,
      threadId: scope.thread.id,
      branchId: scope.branch.id,
      message: `请优化教学目标，标记 ${marker}`,
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    await run(first, "THREAD_A_ONLY");
    await run(second, "THREAD_B_ONLY");

    expect(model.requests[0]).toContain("THREAD_A_ONLY");
    expect(model.requests[0]).not.toContain("THREAD_B_ONLY");
    expect(model.requests[1]).toContain("THREAD_B_ONLY");
    expect(model.requests[1]).not.toContain("THREAD_A_ONLY");

    const firstMessages = await repository.listMessages(
      userId,
      first.thread.id,
      first.branch.id,
    );
    const fork = await repository.createBranch(
      userId,
      first.thread.id,
      first.branch.id,
      firstMessages.at(-1)!.id,
    );
    await run(first, "PARENT_AFTER_FORK_ONLY");
    await run(
      { thread: first.thread, branch: fork },
      "CHILD_BRANCH_ONLY",
    );

    expect(model.requests[3]).toContain("THREAD_A_ONLY");
    expect(model.requests[3]).toContain("CHILD_BRANCH_ONLY");
    expect(model.requests[3]).not.toContain("PARENT_AFTER_FORK_ONLY");
  });

  it("builds foreground input from memory plus recent protocol-safe items without model compaction", async () => {
    const repository = new MemoryLessonRepository();
    const history = Array.from({ length: 30 }, (_, index) => ({
      type: "message",
      role: index % 2 ? "assistant" : "user",
      status: "completed",
      content: index % 2
        ? [{ type: "output_text", text: `assistant-${index}` }]
        : `user-${index}`,
    })) as AgentOutputItem[];
    await repository.addSessionItems(
      userId,
      "thread-memory",
      "branch-memory",
      history,
    );
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(new ScriptedSdkModel([])),
    });
    const fullHistoryRead = vi.spyOn(repository, "getSessionItems");
    const metrics: Record<string, number> = {};
    const loadHistory = (harness as unknown as {
      createSessionHistoryLoader: (
        context: object,
        phaseMetrics: Record<string, number>,
      ) => () => Promise<AgentOutputItem[]>;
    }).createSessionHistoryLoader({
      userId,
      threadId: "thread-memory",
      branchId: "branch-memory",
    }, metrics);

    const selected = await loadHistory();

    expect(fullHistoryRead).not.toHaveBeenCalled();
    expect(selected).toHaveLength(24);
    expect(JSON.stringify(selected)).toContain("assistant-29");
    expect(JSON.stringify(selected)).not.toContain("user-0");
    expect(metrics).toMatchObject({
      sessionStoredItems: 30,
      sessionSelectedItems: 24,
      memoryCursor: 0,
    });

    await repository.saveThreadMemory(
      userId,
      "thread-memory",
      "branch-memory",
      "summary-through-item-10",
      10,
    );
    const selectedWithMemory = await loadHistory();
    expect(selectedWithMemory).toHaveLength(21);
    expect(JSON.stringify(selectedWithMemory)).toContain("summary-through-item-10");
    expect(JSON.stringify(selectedWithMemory)).not.toContain("user-0");
    expect(metrics.memoryCursor).toBe(10);
  });

  it("forwards text deltas before the SDK run completes without replaying the final text", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-stream",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-stream",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-stream",
      lessonFileId: "file-stream",
      title: "SDK 流式测试",
    });
    const model = new PausedStreamingSdkModel();
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const deltas: string[] = [];
    let resolveFirstDelta = () => {};
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    let settled = false;

    const running = harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请优化教学目标",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => {
      if (event.type !== "message.delta") return;
      deltas.push(event.delta);
      resolveFirstDelta();
    }).finally(() => {
      settled = true;
    });

    await firstDelta;
    expect(deltas).toEqual(["第一段"]);
    expect(settled).toBe(false);

    model.release();
    await running;
    expect(deltas).toEqual(["第一段", "第二段"]);
  });

  it("persists an SDK interruption, restores RunState, and settles approval once", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-a",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-a",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-a",
      lessonFileId: "file-a",
      title: "SDK 集成测试",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-objectives", "read_section", { field: "objectives" })],
      [functionCall("propose-patch", "propose_document_patch", {
        summary: "让目标可观察",
        operations: [{
          field: "objectives",
          expectedText: "目标",
          replacement: "可观察目标",
        }],
      })],
      [assistantMessage("修改已按你的决定处理。")],
    ]);
    const harness = new LessonAgentHarness(
      repository,
      { modelProvider: new ScriptedSdkProvider(model) },
    );
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请修改教学目标",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => {
      events.push(event);
    });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval?.state, JSON.stringify(events)).toBe("pending");
    expect((await repository.getRun(userId, approval.runId))?.status).toBe("awaiting_approval");
    expect(events.some((event) => event.type === "approval.required")).toBe(true);

    await harness.resumeApproval({
      userId,
      runId: approval.runId,
      approvalId: approval.id,
      approved: true,
      idempotencyKey: "decision-1",
      emit: (event) => {
        events.push(event);
      },
    });

    const settled = await repository.getApproval(userId, approval.id);
    const file = await repository.getLessonFile(userId, "file-a");
    const messages = await repository.listMessages(userId, thread.id, branch.id);
    expect(settled?.state).toBe("approved");
    expect(settled?.continuationStatus).toBe("completed");
    expect(file?.document.objectives).toBe("可观察目标");
    expect((await repository.getRun(userId, approval.runId))?.status).toBe("completed");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "completed",
      content: "修改已按你的决定处理。",
    });

    await harness.resumeApproval({
      userId,
      runId: approval.runId,
      approvalId: approval.id,
      approved: true,
      idempotencyKey: "decision-1",
      emit: () => undefined,
    });
    expect((await repository.getLessonFile(userId, "file-a"))?.documentVersion).toBe(1);
  });

  it("treats a normally resolved cancelled SDK stream as cancelled business state", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-cancel",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-cancel",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-cancel",
      lessonFileId: "file-cancel",
      title: "SDK 取消测试",
    });
    let runId = "";
    let releaseDelta = () => {};
    const sawDelta = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(new AbortableSdkModel(releaseDelta)),
    });
    const events: NormalizedAgentEvent[] = [];
    const running = harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请修改教学目标",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => {
      events.push(event);
      if (event.type === "run.started") runId = event.runId;
    });

    await sawDelta;
    expect(await harness.cancel(userId, runId)).toBe(true);
    await running;

    const run = await repository.getRun(userId, runId);
    const messages = await repository.listMessages(userId, thread.id, branch.id);
    expect(run?.status).toBe("cancelled");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已开始分析",
      status: "cancelled",
    });
    expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });
});
