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
  knowledgePoints: "知识点",
  continuity: "",
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
  readonly requests: string[] = [];

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

  async getResponse(request: ModelRequest) {
    this.requests.push(JSON.stringify(request));
    return this.nextResponse();
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(JSON.stringify(request));
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
  it("routes whole-semester planning through continuity in the real SDK loop", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-semester-agent",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-semester-agent",
      {
        textbookId: "textbook-math-bnu",
        title: "七年级上学期教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: { classSummary: "计算基础差异较大" },
      },
      "framework-agent-test",
    );
    const scope = await repository.createThread(userId, {
      notebookId: "notebook-semester-agent",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
    });
    const model = new CapturingSdkModel();
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: scope.thread.id,
      branchId: scope.branch.id,
      message: "请生成整学期六个单元的课时蓝图。",
      activeSectionId: "overview",
      documentVersion: framework.framework.version,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.started" }),
      expect.objectContaining({ type: "message.delta", delta: "已收到。" }),
      expect.objectContaining({ type: "run.completed" }),
    ]));
    expect(model.requests[0]).toContain("工作范围：当前学期教学框架");
    expect(model.requests[0]).toContain("read_semester_framework");
    expect(model.requests[0]).toContain("read_semester_framework_continuity");
    expect(model.requests[0]).toContain("本轮涉及学期、单元或课时蓝图规划");
    expect(model.requests[0]).toContain("词法召回只用于发现待判断关联");
    expect(await repository.listMessages(
      userId,
      scope.thread.id,
      scope.branch.id,
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("整学期六个单元") }),
      expect.objectContaining({ role: "assistant", content: "已收到。" }),
    ]));
  });

  it("routes a whole-lesson rewrite through one direct A4 write surface", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-direct-rewrite",
      title: "语文备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-direct-rewrite",
        title: "春",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-direct-rewrite",
      lessonFileId: "file-direct-rewrite",
    });
    const model = new CapturingSdkModel();
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "重新编写教案",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const request = model.requests[0];
    expect(request).toContain('"toolChoice":"required"');
    expect(request).toContain("直接生成一次整栏修改确认项");
    expect(request).toContain("propose_document_patch");
    expect(request).not.toContain("read_lesson_design_basis");
    expect(request).not.toContain("propose_lesson_design_change");
    expect(request).not.toContain("propose_design_basis_projection");
    expect(request).not.toContain("propose_lesson_design_basis_patch");
    const exposedTools = (JSON.parse(request) as {
      tools: Array<{ name: string }>;
    }).tools.map((candidate) => candidate.name);
    expect(exposedTools).toContain("read_curriculum_knowledge_points");
    expect(exposedTools).not.toContain("read_section");
    expect(exposedTools).not.toContain("read_document_outline");
    expect(exposedTools).not.toContain("read_curriculum_outline");
    expect(exposedTools).not.toContain("trace_curriculum_learning_path");
    expect(exposedTools).not.toContain("curriculum_analysis");
  });

  it("carries blueprint knowledge and continuity into a full lesson generation run", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-blueprint-generation",
      title: "高中数学备课本",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-blueprint-generation",
      {
        textbookId: "textbook-math-bnu",
        title: "数学必修第二册教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: { classSummary: "能识别重复现象，但解释规律时证据不足" },
      },
      "blueprint-generation-framework",
    );
    const planned = await repository.createLessonBlueprint(
      userId,
      framework.framework.id,
      {
        semesterUnitId: framework.units[0]!.id,
        curriculumNodeId: "ch1-1",
        title: "周期变化",
        mainActivity: "比较昼夜、季节和钟摆数据，圈出重复片段并归纳周期",
        observableProduct: "一张包含重复片段和周期长度的证据表",
        assessmentEvidence: "能依据数据指出重复单位并解释周期长度",
        anticipatedDifficulties: ["把重复出现误解为数值始终相同"],
        teacherNotes: "为后续三角函数描述周期变化铺垫",
      },
      "blueprint-generation-lesson",
    );
    const blueprint = planned.blueprints[0]!;
    const file = await repository.createLessonFile(userId, {
      notebookId: "notebook-blueprint-generation",
      title: blueprint.title,
      type: "课时蓝图教案",
      document: { ...document, topic: blueprint.title, knowledgePoints: "" },
      contextProfile: {
        textbookId: framework.framework.textbookId,
        unitNodeId: planned.units[0]!.curriculumNodeId,
        lessonNodeId: blueprint.curriculumNodeId,
        lessonDurationMinutes: 40,
      },
      lessonBlueprintId: blueprint.id,
      pageCount: 1,
    }, "blueprint-generation-file");
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: file.notebookId,
      lessonFileId: file.id,
    });
    const model = new CapturingSdkModel();
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请读取教案设计依据，完整编写当前教案，并落实知识点、复习与铺垫。",
      activeSectionId: "basics",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const request = model.requests[0];
    expect(request).toContain("read_lesson_design_basis");
    expect(request).toContain("read_curriculum_knowledge_points");
    expect(request).toContain("来源学期框架、单元目标、课时蓝图、章节知识点和教学衔接候选");
    expect(request).toContain("重点知识、目标、活动、学生产出、评价");
    expect(request).toContain("knowledgePoints");
    const tools = (JSON.parse(request) as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).not.toContain("search_curriculum_knowledge_points");
  });

  it("enforces one operation when the teacher asks for one minimal change", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-minimal-change",
      title: "语文备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-minimal-change",
        title: "春",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-minimal-change",
      lessonFileId: "file-minimal-change",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-minimal", "read_document", { fields: ["objectives", "assessment"] })],
      [functionCall("invalid-minimal", "propose_document_patch", {
        summary: "同时修改两栏",
        operations: [
          { field: "objectives", replacement: "可观察目标" },
          { field: "assessment", replacement: "可观察评价" },
        ],
      })],
      [functionCall("valid-minimal", "propose_document_patch", {
        summary: "只修改最关键的目标栏",
        operations: [{ field: "objectives", replacement: "可观察目标" }],
      })],
      [assistantMessage("已按确认完成最小调整。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "只对最关键一处问题提交最小修改建议，等待我确认后再写入",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const approvals = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({
      operations: [{ field: "objectives" }],
    });
    expect(model.requests[1]).toContain('"toolChoice":"required"');
    expect(model.requests[2]).toContain("教师本轮只要求一处最小修改");
    expect(model.requests[2]).not.toContain("too_many_document_operations");
  });

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
    expect(model.requests[0]).toContain('"toolChoice":"required"');
    expect(model.requests[0]).toContain("propose_document_patch");
    expect(model.requests[0]).not.toContain("propose_lesson_design_change");
    expect(model.requests[0]).not.toContain("propose_design_basis_projection");
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
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.completed",
        name: "propose_document_patch",
        ok: false,
      }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.completed",
        name: "propose_document_patch",
        ok: true,
      }),
    ]));
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

  it("persists and applies a lesson-design-basis patch through SDK approval", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-design-basis",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-design-basis",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-design-basis",
      lessonFileId: "file-design-basis",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-basis", "read_lesson_design_basis", {})],
      [functionCall("propose-basis", "propose_lesson_design_basis_patch", {
        summary: "记录学生可能卡住的位置",
        operations: [{
          op: "create_design_basis_entry",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生可能只罗列景物，不能说明描写如何表达情感。",
          rationale: "需要在课堂提问中要求学生同时给出原文证据和解释。",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
      })],
      [assistantMessage("学生困难已经按你的确认保存到设计依据。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "把这个学生困难保存为本课设计依据",
      activeSectionId: "focus",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({
      state: "pending",
      patchKind: "lesson_design_basis",
    });
    await harness.resumeApproval({
      userId,
      runId: approval.runId,
      approvalId: approval.id,
      approved: true,
      idempotencyKey: "design-basis-decision",
      emit: (event) => { events.push(event); },
    });

    expect(await repository.getLessonDesignBasis(userId, "file-design-basis"))
      .toMatchObject({
        basis: { version: 1 },
        entries: [expect.objectContaining({
          kind: "student_difficulty",
          teacherConfirmed: true,
          statement: "学生可能只罗列景物，不能说明描写如何表达情感。",
        })],
      });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "design_basis.updated" }),
      expect.objectContaining({ type: "run.completed" }),
    ]));
  });

  it("saves a teaching decision and updates A4 through one SDK approval", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-complete-change",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-complete-change",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-complete-change",
      lessonFileId: "file-complete-change",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-change-basis", "read_lesson_design_basis", {})],
      [functionCall("read-change-assessment", "read_section", { field: "assessment" })],
      [functionCall("propose-complete-change", "propose_lesson_design_change", {
        summary: "记录学生困难并完善评价",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "reasoning-gap",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生可能只给出判断，不能说明理由。",
          rationale: "评价时需要追问证据。",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "完成判断，并说明所依据的文本或现象。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["reasoning-gap"],
          usesLearnerContext: false,
        }],
      })],
      [assistantMessage("已完成本次备课调整。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "把这个学生困难保存为设计依据，并落实到评价练习",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({
      state: "pending",
      patchKind: "document",
      patch: {
        designBasisPatch: { baseBasisVersion: 0 },
        projection: { baseBasisVersion: 1 },
      },
    });
    await harness.resumeApproval({
      userId,
      runId: approval.runId,
      approvalId: approval.id,
      approved: true,
      idempotencyKey: "complete-change-decision",
      emit: (event) => { events.push(event); },
    });

    expect((await repository.getLessonFile(userId, "file-complete-change"))?.document.assessment)
      .toBe("完成判断，并说明所依据的文本或现象。");
    expect(await repository.getLessonDesignBasis(userId, "file-complete-change"))
      .toMatchObject({
        basis: { version: 1 },
        entries: [{ statement: "学生可能只给出判断，不能说明理由。" }],
      });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "design_basis.updated" }),
      expect.objectContaining({ type: "document.updated" }),
      expect.objectContaining({ type: "run.completed" }),
    ]));
  });

  it("returns an invalid approval proposal to the agent for correction before interrupting", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-change-preflight",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-change-preflight",
        title: "秋天的怀念",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-change-preflight",
      lessonFileId: "file-change-preflight",
    });
    const invalidKnowledgeOperation = {
      op: "create_design_basis_entry" as const,
      referenceKey: "unsupported-knowledge",
      kind: "knowledge_point" as const,
      semanticEntityId: "00000000-0000-4000-8000-00000000b001",
      relatedSemanticEntityId: null,
      relatedCurriculumNodeId: null,
      statement: "分析人物情感变化。",
      rationale: "作为本课知识点。",
      evidenceSourceIds: [],
      decision: "accepted" as const,
    };
    const validTeachingDecision = {
      ...invalidKnowledgeOperation,
      referenceKey: "classroom-evidence-decision",
      kind: "teaching_decision" as const,
      semanticEntityId: null,
      statement: "要求学生用两处原文说明人物情感变化。",
      rationale: "这是根据当前教案形成的课堂取舍，不冒充平台知识点。",
    };
    const documentOperation = (referenceKey: string) => ({
      field: "assessment" as const,
      replacement: "学生圈画两处原文，并说明人物情感变化及其依据。",
      basisEntryIds: [],
      createdBasisEntryRefs: [referenceKey],
      usesLearnerContext: false,
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-change-preflight", "read_lesson_design_basis", {})],
      [functionCall("invalid-change-preflight", "propose_lesson_design_change", {
        summary: "建立知识点并完善评价",
        designBasisOperations: [invalidKnowledgeOperation],
        documentOperations: [documentOperation(invalidKnowledgeOperation.referenceKey)],
      })],
      [functionCall("valid-change-preflight", "propose_lesson_design_change", {
        summary: "记录课堂取舍并完善评价",
        designBasisOperations: [validTeachingDecision],
        documentOperations: [documentOperation(validTeachingDecision.referenceKey)],
      })],
      [assistantMessage("已按确认完成课堂评价调整。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "完善《秋天的怀念》的课堂评价，并形成必要设计依据",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({ state: "pending", patchKind: "document" });
    expect(model.requests[2]).toContain("尚未取得直接依据");
    expect(model.requests[2]).not.toContain("proposal_needs_revision");
    expect(model.requests[2]).not.toContain("design_basis_evidence_required");
    expect(model.requests[2]).toContain("teaching_decision");
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.failed" }),
    ]));
  });

  it("accepts a curriculum knowledge proposal only after the current run observes its entity and source", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-knowledge-preflight",
      title: "数学备课本",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [{
        id: "file-knowledge-preflight",
        title: "周期变化",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    await repository.updateLessonFile(userId, "file-knowledge-preflight", {
      contextProfile: {
        textbookId: "textbook-math-bnu",
        lessonNodeId: "ch1-1",
      },
    });
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-knowledge-preflight",
      lessonFileId: "file-knowledge-preflight",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-current-knowledge", "read_curriculum_knowledge_points", {
        textbookId: "textbook-math-bnu",
        nodeId: "ch1-1",
      })],
      [functionCall("propose-grounded-knowledge", "propose_lesson_design_change", {
        summary: "记录当前章节知识点并落实到评价",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "periodic-change",
          kind: "knowledge_point",
          semanticEntityId: "00000000-0000-4000-8000-000000000401",
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "识别现象随时间重复出现的变化规律。",
          rationale: "用于判断学生是否理解周期变化。",
          evidenceSourceIds: ["curriculum-semantic-source:periodic-change"],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "给出一个变化现象，要求学生标出重复单位并说明判断依据。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["periodic-change"],
          usesLearnerContext: false,
        }],
      })],
      [assistantMessage("已按确认完成调整。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "读取当前章节知识点，保存为设计依据并落实到评价练习",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({
      state: "pending",
      patch: {
        designBasisPatch: {
          operations: [expect.objectContaining({
            kind: "knowledge_point",
            semanticEntityId: "00000000-0000-4000-8000-000000000401",
          })],
        },
      },
    });
  });

  it("projects confirmed design-basis decisions into A4 through SDK approval", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-basis-projection",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-basis-projection",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const initialBasis = await repository.getLessonDesignBasis(
      userId,
      "file-basis-projection",
    );
    if (!initialBasis) throw new Error("lesson_design_basis_not_found");
    const entryId = "00000000-0000-4000-8000-00000000e901";
    await repository.applyManualLessonDesignBasisPatch(userId, {
      basisId: initialBasis.basis.id,
      fileId: "file-basis-projection",
      baseBasisVersion: 0,
      summary: "记录评价依据",
      operations: [{
        op: "create_design_basis_entry",
        entryId,
        sortNo: 1,
        kind: "student_difficulty",
        semanticEntityId: null,
        relatedSemanticEntityId: null,
        relatedCurriculumNodeId: null,
        statement: "学生可能给出判断，但不能说明理由。",
        rationale: "评价时需要追问证据。",
        evidence: [],
        decision: "accepted",
        teacherConfirmed: true,
        origin: "teacher",
      }],
    }, "seed-projection-basis");
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-basis-projection",
      lessonFileId: "file-basis-projection",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-basis", "read_lesson_design_basis", {})],
      [functionCall("read-assessment", "read_section", { field: "assessment" })],
      [functionCall("propose-projection", "propose_design_basis_projection", {
        summary: "把已确认的学生困难落实到评价",
        operations: [{
          field: "assessment",
          replacement: "要求学生完成判断，并说明所依据的文本或现象",
          basisEntryIds: [entryId],
          usesLearnerContext: false,
        }],
      })],
      [assistantMessage("已将确认过的学生困难落实到评价练习。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "把已确认的设计依据落实到教案评价中",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({
      state: "pending",
      patchKind: "document",
      patch: {
        projection: {
          entryRefs: [{ entryId, expectedVersion: 0 }],
        },
      },
    });
    await harness.resumeApproval({
      userId,
      runId: approval.runId,
      approvalId: approval.id,
      approved: true,
      idempotencyKey: "projection-decision",
      emit: (event) => { events.push(event); },
    });

    expect((await repository.getLessonFile(userId, "file-basis-projection"))?.document.assessment)
      .toBe("要求学生完成判断，并说明所依据的文本或现象");
    expect((await repository.getLessonDesignBasis(userId, "file-basis-projection"))?.basis.version)
      .toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "document.updated" }),
      expect.objectContaining({ type: "run.completed" }),
    ]));
  });

  it("persists and applies a semester-framework ResourcePatch through SDK RunState", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-framework-approval",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-framework-approval",
      {
        textbookId: "textbook-math-bnu",
        title: "七年级上学期教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: {},
      },
      "framework-approval-create",
    );
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-framework-approval",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
      title: "学期框架审批测试",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-framework", "read_semester_framework", {})],
      [functionCall(
        "read-framework-continuity",
        "read_semester_framework_continuity",
        {},
      )],
      [functionCall("propose-framework-patch", "propose_semester_framework_patch", {
        summary: "把滚动规划窗口调整为三周",
        operations: [{
          op: "replace_framework_field",
          field: "planningHorizonWeeks",
          expectedValue: 2,
          replacement: 3,
        }],
      })],
      [assistantMessage("学期框架已按你的决定更新。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请把滚动规划窗口从两周调整为三周。",
      activeSectionId: "overview",
      documentVersion: framework.framework.version,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval).toMatchObject({
      state: "pending",
      resourceType: "semester_framework",
      patchKind: "semester_framework",
      semesterFrameworkId: framework.framework.id,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval.required",
      approvalId: approval!.id,
    }));

    await harness.resumeApproval({
      userId,
      runId: approval!.runId,
      approvalId: approval!.id,
      approved: true,
      idempotencyKey: "framework-decision-1",
      emit: (event) => { events.push(event); },
    });

    const updated = await repository.getSemesterFramework(userId, framework.framework.id);
    expect(updated?.framework).toMatchObject({ planningHorizonWeeks: 3, version: 1 });
    expect((await repository.getApproval(userId, approval!.id))?.continuationStatus).toBe("completed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "resource.updated",
      resourceType: "semester_framework",
    }));

    await harness.resumeApproval({
      userId,
      runId: approval!.runId,
      approvalId: approval!.id,
      approved: true,
      idempotencyKey: "framework-decision-1",
      emit: () => undefined,
    });
    expect((await repository.getSemesterFramework(
      userId,
      framework.framework.id,
    ))?.framework.version).toBe(1);
  });

  it("creates multiple formal lesson blueprints through one SDK approval", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-blueprint-approval",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-blueprint-approval",
      {
        textbookId: "textbook-math-bnu",
        title: "七年级上学期教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: {},
      },
      "blueprint-approval-create",
    );
    const unit = framework.units[0]!;
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-blueprint-approval",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
    });
    const operations = ["认识周期变化", "解释周期规律"].map((title, index) => ({
      op: "create_lesson_blueprint",
      semesterUnitId: unit.id,
      curriculumNodeId: "ch1-1",
      chapterPeriodNo: index + 1,
      title,
      mainActivity: `比较第 ${index + 1} 组周期现象`,
      observableProduct: `周期证据表 ${index + 1}`,
      assessmentEvidence: `能够解释规律 ${index + 1}`,
      anticipatedDifficulties: [],
      plannedMinutes: 40,
      teacherNotes: "",
    }));
    const model = new ScriptedSdkModel([
      [functionCall("read-framework", "read_semester_framework", {})],
      [functionCall("propose-blueprints", "propose_semester_framework_patch", {
        summary: "补全第一单元两条正式课时蓝图",
        operations,
      })],
      [assistantMessage("两条课时蓝图已按你的决定处理。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请补全第一单元的两条正式课时蓝图。",
      activeSectionId: "overview",
      documentVersion: framework.framework.version,
      attachmentIds: [],
    }, () => undefined);
    const [approval] = await repository.listApprovals(userId, thread.id, branch.id);
    expect(approval?.patch.operations).toEqual([
      expect.objectContaining({ op: "create_lesson_blueprint", plannedPeriod: 1 }),
      expect.objectContaining({ op: "create_lesson_blueprint", plannedPeriod: 2 }),
    ]);

    await harness.resumeApproval({
      userId,
      runId: approval!.runId,
      approvalId: approval!.id,
      approved: true,
      idempotencyKey: "blueprint-decision-1",
      emit: () => undefined,
    });
    const updated = await repository.getSemesterFramework(userId, framework.framework.id);
    expect(updated?.blueprints.map((blueprint) => blueprint.title)).toEqual([
      "认识周期变化",
      "解释周期规律",
    ]);
    expect(updated?.units[0]).toMatchObject({ plannedPeriods: 2, status: "planned" });
    expect(updated?.framework.version).toBe(1);
  });

  it("uses the committed resource snapshot when the same SDK run proposes another approval", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-framework-chained-approval",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-framework-chained-approval",
      {
        textbookId: "textbook-math-bnu",
        title: "七年级上学期教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: {},
      },
      "framework-chained-approval-create",
    );
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-framework-chained-approval",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-framework-chain", "read_semester_framework", {})],
      [functionCall("first-framework-patch", "propose_semester_framework_patch", {
        summary: "先调整滚动规划窗口",
        operations: [{
          op: "replace_framework_field",
          field: "planningHorizonWeeks",
          expectedValue: 2,
          replacement: 3,
        }],
      })],
      [functionCall("second-framework-patch", "propose_semester_framework_patch", {
        summary: "再调整每周课时",
        operations: [{
          op: "replace_framework_field",
          field: "weeklyPeriods",
          expectedValue: 5,
          replacement: 4,
        }],
      })],
      [assistantMessage("两项框架调整均已按你的确认写入。")],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请连续完成两项框架调整。",
      activeSectionId: "overview",
      documentVersion: framework.framework.version,
      attachmentIds: [],
    }, () => undefined);
    let approvals = await repository.listApprovals(userId, thread.id, branch.id);
    const firstApproval = approvals.find((approval) => approval.state === "pending")!;

    await harness.resumeApproval({
      userId,
      runId: firstApproval.runId,
      approvalId: firstApproval.id,
      approved: true,
      idempotencyKey: "framework-chain-decision-1",
      emit: () => undefined,
    });

    approvals = await repository.listApprovals(userId, thread.id, branch.id);
    const secondApproval = approvals.find((approval) => approval.state === "pending")!;
    expect(secondApproval).toBeDefined();
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(secondApproval.patch).toMatchObject({ baseFrameworkVersion: 1 });
    expect(await repository.getRun(userId, secondApproval.runId)).toMatchObject({
      status: "awaiting_approval",
    });
    expect(await repository.getThread(userId, thread.id)).toMatchObject({
      status: "awaiting_approval",
    });

    await harness.resumeApproval({
      userId,
      runId: secondApproval.runId,
      approvalId: secondApproval.id,
      approved: true,
      idempotencyKey: "framework-chain-decision-2",
      emit: () => undefined,
    });

    expect((await repository.getSemesterFramework(
      userId,
      framework.framework.id,
    ))?.framework).toMatchObject({
      version: 2,
      planningHorizonWeeks: 3,
      weeklyPeriods: 4,
    });
  });

  it("keeps a failed lesson draft durable and gives the next run protocol-safe continuity", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-failed-continuity",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "file-failed-continuity",
        title: "课题",
        type: "新授课",
        pages: 1,
        lessonPlan: document,
      }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-failed-continuity",
      lessonFileId: "file-failed-continuity",
    });
    const model = new ScriptedSdkModel([
      [functionCall("read-failed-objectives", "read_section", { field: "objectives" })],
      [
        assistantMessage("我已经完成目标分析，下一步只需修正修改定位。"),
        functionCall("invalid-proposal", "propose_document_patch", {
          summary: "调整目标",
          operations: [{
            field: "objectives",
            expectedText: "并不存在的原文",
            replacement: "形成可观察、可评价的学习目标",
          }],
        }),
      ],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const failedEvents: NormalizedAgentEvent[] = [];

    const continuationModel = new ScriptedSdkModel([
      [assistantMessage("已沿用上一轮分析继续处理。")],
    ]);
    const continuationHarness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(continuationModel),
    });
    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "请分析并调整教学目标",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { failedEvents.push(event); });

    const failedMessage = (await repository.listMessages(
      userId,
      thread.id,
      branch.id,
    )).at(-1);
    expect(failedMessage).toMatchObject({
      role: "assistant",
      status: "failed",
      content: "我已经完成目标分析，下一步只需修正修改定位。",
    });
    expect(failedEvents).toContainEqual(expect.objectContaining({
      type: "run.failed",
      message: expect.objectContaining({
        status: "failed",
        content: "我已经完成目标分析，下一步只需修正修改定位。",
      }),
    }));
    expect(JSON.stringify(await repository.getSessionItems(
      userId,
      thread.id,
      branch.id,
    ))).toContain("上一轮未完成的助手输出");

    await continuationHarness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "继续",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    expect(continuationModel.requests.at(-1)).toContain("我已经完成目标分析");
    expect(continuationModel.requests.at(-1)).toContain("只用于衔接对话");
    expect((await repository.listMessages(userId, thread.id, branch.id)).at(-1))
      .toMatchObject({ status: "completed", content: "已沿用上一轮分析继续处理。" });
  });

  it("keeps post-validation failure content in the semester-framework conversation", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(userId, [{
      id: "notebook-framework-failed-draft",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      userId,
      "notebook-framework-failed-draft",
      {
        textbookId: "textbook-math-bnu",
        title: "七年级上学期教学框架",
        term: "上学期",
        startDate: "2026-09-01",
        totalWeeks: 18,
        weeklyPeriods: 5,
        lessonDurationMinutes: 40,
        capacityRatio: 0.9,
        planningHorizonWeeks: 2,
        contextProfile: {},
      },
      "framework-failed-draft-create",
    );
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "notebook-framework-failed-draft",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
    });
    const unit = framework.units[0]!;
    const model = new ScriptedSdkModel([
      [functionCall("read-framework-for-failure", "read_semester_framework", {})],
      [
        assistantMessage("第一单元的目标和课时安排已经分析完成。"),
        functionCall("stale-framework-patch", "propose_semester_framework_patch", {
          summary: "补充第一单元目标",
          operations: [{
            op: "replace_unit_field",
            unitId: unit.id,
            field: "learningGoals",
            expectedValue: "不是当前值",
            replacement: "形成可观察的单元学习成果",
          }],
        }),
      ],
    ]);
    const harness = new LessonAgentHarness(repository, {
      modelProvider: new ScriptedSdkProvider(model),
    });
    const events: NormalizedAgentEvent[] = [];

    await harness.start({
      userId,
      threadId: thread.id,
      branchId: branch.id,
      message: "完善第一单元框架",
      activeSectionId: "semester-framework",
      documentVersion: framework.framework.version,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    expect((await repository.listMessages(userId, thread.id, branch.id)).at(-1))
      .toMatchObject({
        status: "failed",
        content: "第一单元的目标和课时安排已经分析完成。",
      });
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.failed",
      message: expect.objectContaining({
        content: "第一单元的目标和课时安排已经分析完成。",
      }),
    }));
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
    const sessionAfterCancellation = JSON.stringify(await repository.getSessionItems(
      userId,
      thread.id,
      branch.id,
    ));
    expect(sessionAfterCancellation).toContain("上一轮未完成的助手输出");
    expect(sessionAfterCancellation).toContain("已开始分析");
  });
});
