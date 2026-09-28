import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import type { LessonPlan } from "../../domain.js";
import type { DashiGoal } from "../../presentations/dashi-goal.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import { PresentationService } from "../../presentations/service.js";
import { createNodeSkillRegistry } from "../../agent/skill-registry-node.js";
import { deterministicCapabilityPlan } from "../../agent/capability-router.js";
import { encodePiAgentMessages } from "./message-codec.js";
import { PiLessonAgentCoordinator } from "./coordinator.js";
import { publicApproval } from "../../conversation/public-approval.js";

const ownerId = "pi-coordinator-owner";
const lessonFileId = "11111111-1111-4111-8111-111111111111";
const lesson: LessonPlan = {
  unit: "第一单元",
  period: "1",
  totalPeriods: "1",
  topic: "济南的冬天",
  objectives: "从景物描写中寻找温晴的证据",
  knowledgePoints: "抓住景物特征；比喻和拟人的表达效果",
  continuity: "从写景句中提取证据",
  focus: "用文本证据解释景物特征",
  preparation: "课文",
  process: "提出中心问题，小组圈画证据并说明表达效果",
  assessment: "用两处证据回答中心问题",
  homework: "仿写一段景物描写",
  board: "温晴—景物—证据",
  reflection: "",
};

const goal: DashiGoal = {
  title: "济南的冬天 · 课堂演示",
  goal: "济南的冬天为什么温晴？",
  themePack: "theme01",
  slides: [
    {
      layout: "theme01_page001",
      props: { title: "济南的冬天", question: "济南的冬天为什么温晴？" },
    },
    {
      layout: "theme01_page021",
      props: { title: "圈画景物证据", task: "找出两处能表现温晴的景物描写", action: "圈画并解释关键词", output: "证据卡" },
    },
    {
      layout: "theme01_page051",
      props: { title: "回答中心问题", prompt: "用两处证据解释温晴", output: "证据与结论" },
    },
  ],
};

/**
 * Per-turn server policy must stay out of the cacheable prefix, so it rides as
 * the final message instead. Reading it back through the tail keeps these
 * assertions honest about where the Agent actually receives it.
 */
const turnContextOf = (context: { messages?: unknown }) => {
  const messages = (context.messages ?? []) as Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  const text = messages.at(-1)?.content?.find((part) => part.type === "text")?.text ?? "";
  return text.startsWith("<lessonup_turn_context") ? text : "";
};

const presentationProposal = (value: DashiGoal, summary: string) => ({
  summary,
  title: value.title,
  goal: value.goal,
  audience: value.audience,
  slides: value.slides,
});

async function fixture() {
  const repository = new MemoryLessonRepository();
  await repository.importNotebookGraph(ownerId, [{
    id: "notebook-a",
    title: "语文备课本",
    className: "一班",
    year: "2026",
    subject: "语文",
    files: [{ id: lessonFileId, title: "济南的冬天", pages: 1, lessonPlan: lesson }],
  }]);
  const created = await repository.createThread(ownerId, {
    notebookId: "notebook-a",
    lessonFileId,
    title: "演示文稿",
  }, "pi-coordinator-thread");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: string[] = [];
  const fakeDashi = {
    queryLayouts: async () => { calls.push("query"); return { layouts: [] }; },
    inspectLayouts: async ({ layouts }: { layouts: string[] }) => {
      calls.push("inspect");
      return { layouts: layouts.map((layout) => {
        const page = layout.split("_page")[1];
        const source = goal.slides.find((slide) => slide.layout.endsWith(`_page${page}`));
        return {
          layout,
          copyKeys: Object.keys(source?.props ?? {}),
          fillPlan: { text: [], arrays: [] },
          mediaSlots: [],
        };
      }) };
    },
    prepareGoal: async (value: DashiGoal) => {
      if (value.title === "INVALID") {
        const error = new Error("dashi_props_safe_failed") as Error & { detail?: string };
        error.detail = JSON.stringify({
          goalSpecErrors: [],
          propErrors: ["slides[0].props.companyCount: Number must be greater than or equal to 1"],
        });
        throw error;
      }
      return value;
    },
    renderGoal: async ({ presentationId }: { presentationId: string }) => {
      calls.push("render");
      return {
        deckKey: presentationId,
        previewUrl: "http://127.0.0.1:5200/",
        checksum: "checksum",
        pageCount: 3,
      };
    },
    hasDeck: async () => true,
    exportBundle: async () => ({
      files: [{ path: "index.html", body: new TextEncoder().encode("<html></html>") }],
      byteSize: 13,
    }),
    importBundle: async () => {},
    open: async () => "http://127.0.0.1:5200/",
    remove: async () => {},
  };
  const presentations = new PresentationService(repository, fakeDashi as never);
  const coordinator = new PiLessonAgentCoordinator(repository, {
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    sessionSecret: "test-only-pi-session-secret-32-characters",
    presentations,
    dashi: fakeDashi as never,
    registry: createNodeSkillRegistry(),
  });
  return { repository, created, faux, coordinator, presentations, calls };
}

const COMPACT_HISTORY_TURNS = 25;

function bulkyHistory(assistantTurns: number) {
  const chunk = "x".repeat(10_000);
  return Array.from({ length: assistantTurns * 2 }, (_, index) => (
    index % 2 === 0
      ? { role: "user" as const, content: [{ type: "text" as const, text: `第${index}轮` }], timestamp: 1 }
      : fauxAssistantMessage(`${chunk}${index}`)
  ));
}

function memorySummaryResponse() {
  return (context: { systemPrompt?: string; messages?: Array<{ content?: unknown }> }) => {
    const userText = JSON.stringify(context.messages ?? []);
    expect(userText).toContain("[User]:");
    expect(userText).not.toMatch(/"role":"toolResult"/);
    return fauxAssistantMessage(JSON.stringify({
      schemaVersion: 1,
      runtime: "pi",
      summarizedThrough: Number(context.systemPrompt?.match(/严格等于 (\d+)/)?.[1]),
      goals: ["判断教学过程是否需要重写"],
      durableFacts: [],
      decisions: [],
      resourceReferences: [],
      evidence: [],
      unresolved: [],
      rejectedOrSuperseded: [],
    }));
  };
}

describe("Pi production coordinator", () => {
  it("replays one durable command without duplicating its run, messages, or provider call", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    let providerCalls = 0;
    faux.setResponses([() => {
      providerCalls += 1;
      return fauxAssistantMessage("目标与评价一致。");
    }]);
    const input = {
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "检查目标与评价",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
      clientCommandId: "11111111-1111-4111-8111-111111111199",
    };
    const firstEvents: Array<{ type: string; runId: string }> = [];
    await coordinator.start(input, async (event, delivery) => {
      firstEvents.push(event);
      if (delivery?.persist !== false && event.runId !== "unknown") {
        await repository.appendRunEvent(ownerId, event.runId, event.type, event);
      }
    });
    const replayed: Array<{ type: string; runId: string }> = [];
    await coordinator.start(input, (event) => { replayed.push(event); });

    expect(providerCalls).toBe(1);
    expect(replayed).toEqual(firstEvents);
    expect(new Set(replayed.map((event) => event.runId)).size).toBe(1);
    expect(await repository.listMessages(ownerId, created.thread.id, created.branch.id)).toHaveLength(2);
    expect(await repository.getRunByClientCommand(
      ownerId,
      created.thread.id,
      input.clientCommandId,
    )).toMatchObject({ status: "completed" });

    await expect(coordinator.start({ ...input, message: "换一个请求" }, () => undefined))
      .rejects.toThrow("idempotency_conflict");
  });

  it("returns an active command replay immediately instead of waiting for the model run", async () => {
    const { created, faux, coordinator } = await fixture();
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    let acknowledgeStart!: () => void;
    const started = new Promise<void>((resolve) => { acknowledgeStart = resolve; });
    faux.setResponses([async () => {
      await modelGate;
      return fauxAssistantMessage("完成。");
    }]);
    const input = {
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "检查目标与评价",
      activeSectionId: "objectives",
      documentVersion: 0,
      attachmentIds: [],
      clientCommandId: "11111111-1111-4111-8111-111111111198",
    };
    const first = coordinator.start(input, (event) => {
      if (event.type === "run.started") acknowledgeStart();
    });
    await started;
    const replayed: Array<{ type: string }> = [];
    try {
      await coordinator.start(input, (event) => { replayed.push(event); });
      expect(replayed[0]?.type).toBe("run.started");
    } finally {
      releaseModel();
      await first;
    }
  });

  it("keeps the accepted turn visible when server context validation fails before Pi starts", async () => {
    const { repository, created, coordinator } = await fixture();
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请根据本课时框架生成教案。",
      activeSectionId: "process",
      documentVersion: 1,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    const messages = await repository.listMessages(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({ status: "failed", error: "document_context_stale" });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "请根据本课时框架生成教案。" }),
      expect.objectContaining({ role: "assistant", status: "failed" }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.started" }),
      expect.objectContaining({ type: "run.failed", error: "document_context_stale" }),
    ]));
  });

  it("answers a rewrite deliberation on a read-only analysis surface", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    faux.setResponses([
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toContain("propose_document_patch");
        expect(turnContextOf(context)).toContain('"completion":"analysis_only"');
        return fauxAssistantMessage("暂时不必整份重写：目标与评价已经互相支撑，只有教学准备偏薄。");
      },
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "先判断这份教案是否需要重新编写",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({ status: "completed" });
    expect(run?.capabilityPlan).toMatchObject({
      writeMode: "consultative",
      fullRewriteRequested: true,
      skillIds: [],
      evidenceRequired: false,
    });
    expect(events.map((event) => event.type)).not.toContain("run.failed");
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .toHaveLength(0);
  });

  it("sends only an address for a large selected excerpt", async () => {
    const { created, faux, coordinator } = await fixture();
    const largeSelection = "不要注入到 provider context 的选区正文。".repeat(180);
    faux.setResponses([(context) => {
      const turnContext = turnContextOf(context);
      expect(turnContext).toContain('"preloaded":false');
      expect(turnContext).toContain(`"originalLength":${largeSelection.length}`);
      expect(turnContext).not.toContain(largeSelection);
      return fauxAssistantMessage("我会先读取该字段的规范内容，再判断这一段。");
    }]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "分析我选中的教学过程。",
      activeSectionId: "process",
      documentVersion: 0,
      selection: { field: "process", start: 0, end: largeSelection.length, text: largeSelection },
      attachmentIds: [],
    }, () => undefined);
  });

  it("claims a durable lesson-generation intent only after its run and transcript exist", async () => {
    const { repository, created, coordinator } = await fixture();
    const intent = await repository.enqueueLessonGenerationIntent({
      ownerId,
      lessonFileId,
      prompt: "请依据本课时蓝图生成完整教案。",
      idempotencyKey: "generation-intent-run-binding",
    });

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: intent.prompt,
      activeSectionId: "process",
      // Force context validation to fail after the durable protocol boundary.
      documentVersion: 1,
      attachmentIds: [],
      generationIntentId: intent.id,
    }, () => {});

    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    const messages = await repository.listMessages(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({
      status: "failed",
      generationIntentId: intent.id,
      userMessageId: expect.any(String),
    });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(await repository.getPendingLessonGenerationIntent(ownerId, lessonFileId)).toBeNull();
  });

  it("routes a running-turn instruction through Pi's native steering queue", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let agentStarted!: () => void;
    const started = new Promise<void>((resolve) => { agentStarted = resolve; });
    faux.setResponses([
      async () => {
        await firstReady;
        return fauxAssistantMessage("我先给出初步判断。");
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("请改为只说明课堂活动");
        return fauxAssistantMessage("课堂活动是圈画、比较并用证据表达。");
      },
    ]);
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const runPromise = coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "简要分析这节课。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => {
      events.push(event);
      if (event.type === "agent.started") agentStarted();
    });
    await started;
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    const queued = await coordinator.queueInput({
      userId: ownerId,
      runId: run!.id,
      content: "请改为只说明课堂活动",
      delivery: "steer",
    });
    releaseFirst();
    await runPromise;

    expect(queued.delivery).toBe("steer");
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.input.queued",
      queueId: queued.queueId,
    }));
    const session = await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    );
    expect(JSON.stringify(session?.messages)).toContain("请改为只说明课堂活动");
  });

  it("persists complete tool protocol before the next model turn so a failed run can continue", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const threadId = created.thread.id;
    const branchId = created.branch.id;
    let persistedBeforeSecondTurn = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["process"] }), { stopReason: "toolUse" }),
      async (context) => {
        expect((context.messages ?? []).some((message) => message.role === "toolResult"
          || (message as { role?: string }).role === "tool")).toBe(true);
        const session = await repository.getAgentRuntimeSession(ownerId, threadId, branchId, "pi");
        const roles = (session?.messages as Array<{ role?: string }>).map((message) => message.role);
        expect(roles).toEqual(["user", "assistant", "toolResult"]);
        expect(JSON.stringify(session?.messages)).toContain("先判断这份教案的教学过程是否合理");
        expect(session?.revision).toBeGreaterThanOrEqual(2);
        persistedBeforeSecondTurn = true;
        throw new Error("simulated_provider_crash");
      },
      (context) => {
        const encoded = JSON.stringify(context.messages ?? []);
        expect(encoded).toContain("先判断这份教案的教学过程是否合理");
        expect(encoded).toMatch(/toolResult|"role":"tool"/);
        return fauxAssistantMessage("教学过程已经能支撑中心问题，不必整份重写。");
      },
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId,
      branchId,
      message: "先判断这份教案的教学过程是否合理",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    expect(persistedBeforeSecondTurn).toBe(true);
    expect(await repository.getLatestRun(ownerId, threadId, branchId)).toMatchObject({ status: "failed" });
    const failedSession = await repository.getAgentRuntimeSession(ownerId, threadId, branchId, "pi");
    expect((failedSession?.messages as Array<{ role?: string }>).map((message) => message.role))
      .toEqual(["user", "assistant", "toolResult"]);

    await coordinator.start({
      userId: ownerId,
      threadId,
      branchId,
      message: "先判断这份教案的教学过程是否合理",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
      continuation: true,
    }, () => undefined);
    expect(await repository.getLatestRun(ownerId, threadId, branchId)).toMatchObject({ status: "completed" });
    const continued = await repository.getAgentRuntimeSession(ownerId, threadId, branchId, "pi");
    expect((continued?.messages as Array<{ role?: string }>).map((message) => message.role))
      .toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(continued?.revision).toBeGreaterThan((failedSession?.revision ?? 0));
  });

  it("persists a repaired prefix before the run so later appends do not keep an unsettled tail", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const settled = [
      { role: "user" as const, content: [{ type: "text" as const, text: "第一轮" }], timestamp: 1 },
      fauxAssistantMessage("已完成第一轮"),
    ];
    await repository.saveAgentRuntimeSession({
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      runtime: "pi",
      expectedRevision: 0,
      messages: encodePiAgentMessages([
        ...settled,
        { role: "user", content: [{ type: "text", text: "未完成的一轮" }], timestamp: 2 },
        { ...fauxAssistantMessage("半成品"), stopReason: "pending" },
      ]),
    });
    faux.setResponses([fauxAssistantMessage("可以继续。")]);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请继续看教学过程",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    const session = await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    );
    expect(JSON.stringify(session?.messages)).toContain("第一轮");
    expect(JSON.stringify(session?.messages)).toContain("请继续看教学过程");
    expect(JSON.stringify(session?.messages)).not.toContain("未完成的一轮");
    expect(JSON.stringify(session?.messages)).not.toContain("半成品");
  });

  it("rewrites a ghost approval_required result and lets the next turn submit a real card", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const assistant = fauxAssistantMessage(fauxToolCall("propose_document_patch", {
      summary: "让评价练习直接检验文本证据",
      operations: [{
        field: "assessment",
        replacement: "学生提交两处景物描写证据，并用一句话说明这些证据怎样表现济南冬天的温晴。",
      }],
    }), { stopReason: "toolUse" });
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    const toolCallId = toolCall && "id" in toolCall ? String(toolCall.id) : "ghost-call";
    await repository.saveAgentRuntimeSession({
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      runtime: "pi",
      expectedRevision: 0,
      messages: encodePiAgentMessages([
        { role: "user", content: [{ type: "text", text: "请修改评价练习" }], timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId,
          toolName: "propose_document_patch",
          isError: false,
          content: [{
            type: "text",
            text: JSON.stringify({ status: "approval_required", summary: "让评价练习直接检验文本证据" }),
          }],
          timestamp: 2,
        },
      ]),
    });
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .toHaveLength(0);

    let firstTurnContext = "";
    faux.setResponses([
      (context) => {
        firstTurnContext = JSON.stringify(context.messages ?? []);
        return fauxAssistantMessage(fauxToolCall("propose_document_patch", {
          summary: "让评价练习直接检验文本证据",
          operations: [{
            field: "assessment",
            replacement: "学生提交两处景物描写证据，并用一句话说明这些证据怎样表现济南冬天的温晴。",
          }],
        }), { stopReason: "toolUse" });
      },
    ]);
    const events: Array<{ type: string }> = [];
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请再次修改评价练习，并提交确认提案。",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });

    expect(firstTurnContext).toContain("approval_not_persisted");
    expect(firstTurnContext).not.toContain('"status":"approval_required"');
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.required" }));
    const session = await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    );
    expect(JSON.stringify(session?.messages)).toContain("approval_not_persisted");
    expect(JSON.stringify(session?.messages)).toContain('\\"status\\":\\"approval_required\\"');
  });

  it("allows a new turn while a leftover document draft is still pending", async () => {
    const { repository, created, coordinator } = await fixture();
    const assistant = await repository.appendMessage({
      id: "assistant-leftover-approval",
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      role: "assistant",
      content: "",
      status: "failed",
    });
    await repository.createRun({
      id: "failed-with-pending-card",
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      model: "test",
      status: "failed",
      assistantMessageId: assistant.id,
      error: "run_interrupted",
    });
    await repository.saveApproval({
      id: "leftover-approval",
      ownerId,
      runId: "failed-with-pending-card",
      threadId: created.thread.id,
      branchId: created.branch.id,
      assistantMessageId: assistant.id,
      toolCallId: "tool-leftover",
      state: "pending",
      encryptedRunState: "encrypted",
      agentDefinitionVersion: "1",
      documentVersion: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      patch: {
        fileId: lessonFileId,
        baseDocumentVersion: 0,
        summary: "改评价",
        operations: [{
          op: "replace_text",
          field: "assessment",
          start: 0,
          end: 0,
          expectedText: "",
          replacement: "用两处证据回答",
        }],
      },
    });

    await expect(coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "重新尝试",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined)).resolves.toBeUndefined();
  });

  it("nudges an explicit write to propose inside the same Agent run", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let llmCalls = 0;
    faux.setResponses([
      () => {
        llmCalls += 1;
        return fauxAssistantMessage("评价栏目已经能对应中心问题，我先不改。");
      },
      (context) => {
        llmCalls += 1;
        expect(JSON.stringify(context.messages ?? [])).toContain("教师要求修改当前 A4 教案");
        return fauxAssistantMessage(fauxToolCall("propose_document_patch", {
          summary: "让评价练习直接检验文本证据",
          operations: [{
            field: "assessment",
            replacement: "学生提交两处景物描写证据，并用一句话说明这些证据怎样表现济南冬天的温晴。",
          }],
        }), { stopReason: "toolUse" });
      },
    ]);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请修改评价练习，让它直接检验学生能否使用文本证据。",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { events.push(event); });
    expect(llmCalls).toBe(2);
    expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.ended")).toHaveLength(1);
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .toHaveLength(1);
    expect(JSON.stringify((await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    ))?.messages)).toContain("教师要求修改当前 A4 教案");
  });

  it("applies an ordinary lesson patch only after approval and continues the same Pi branch", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const proposalEvents: Array<{ type: string; [key: string]: any }> = [];
    faux.setResponses([
      (context) => {
        const proposalSchema = JSON.stringify(
          context.tools?.find((tool) => tool.name === "propose_document_patch")?.parameters,
        );
        expect(proposalSchema).toContain('"replacement"');
        expect(proposalSchema).not.toContain('"expectedText"');
        return fauxAssistantMessage(fauxToolCall("read_document", { fields: ["objectives", "assessment"] }), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "让评价练习直接检验文本证据",
        operations: [{
          field: "assessment",
          replacement: "学生提交两处景物描写证据，并用一句话说明这些证据怎样表现济南冬天的温晴。",
        }],
      }), { stopReason: "toolUse" }),
    ]);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请修改评价练习，让它直接检验学生能否使用文本证据。",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { proposalEvents.push(event); });
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    // The card must stay attributable to the call that produced it, so the
    // browser never has to infer success from the tool name alone.
    const proposalCall = proposalEvents.find((event) => (
      event.type === "tool.completed" && event.name === "propose_document_patch"
    ));
    expect(approval?.toolCallId).toBe(proposalCall?.toolCallId);
    expect(approval?.toolCallId).toBeTruthy();
    expect(proposalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval.required", toolCallId: approval?.toolCallId }),
    ]));
    const eventTypes = proposalEvents.map((event) => event.type);
    const approvalAt = eventTypes.indexOf("approval.required");
    expect(approvalAt).toBeGreaterThanOrEqual(0);
    expect(approvalAt).toBeLessThan(eventTypes.indexOf("agent.ended"));
    expect(eventTypes.indexOf("message.completed")).toBeGreaterThan(approvalAt);
    expect(approval?.patch).toMatchObject({ summary: "让评价练习直接检验文本证据" });
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);

    faux.setResponses([fauxAssistantMessage("修改已按你的确认写入教案。")]);
    await coordinator.resumeApproval({
      userId: ownerId,
      runId: approval!.runId,
      approvalId: approval!.id,
      approved: true,
      idempotencyKey: "approve-document",
      emit: () => undefined,
    });
    const file = await repository.getLessonFile(ownerId, lessonFileId);
    expect(file).toMatchObject({
      documentVersion: 1,
      document: {
        assessment: "学生提交两处景物描写证据，并用一句话说明这些证据怎样表现济南冬天的温晴。",
      },
    });
    expect((await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    ))?.revision).toBeGreaterThanOrEqual(2);
  });

  it("continues the same Pi transcript after an approved Dashi goal", async () => {
    const { repository, created, faux, coordinator, presentations, calls } = await fixture();
    faux.setResponses([
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toEqual(expect.arrayContaining([
          "inspect_dashi_layouts",
          "propose_classroom_presentation",
          "propose_document_patch",
          "query_dashi_layouts",
          "read_document",
          "read_skill",
        ]));
        expect(context.systemPrompt).toContain("<available_skills>");
        expect(context.systemPrompt).toContain("dashi-ppt");
        expect(context.systemPrompt).not.toContain("one content artifact only");
        const querySchema = JSON.stringify(context.tools?.find((tool) => tool.name === "query_dashi_layouts")?.parameters);
        const proposalSchema = JSON.stringify(context.tools?.find((tool) => tool.name === "propose_classroom_presentation")?.parameters);
        expect(querySchema).not.toContain('"theme"');
        expect(querySchema).not.toContain('"role"');
        expect(querySchema).toContain('"intent"');
        expect(proposalSchema).not.toContain('"goalJson"');
        expect(proposalSchema).not.toContain('"documentVersion"');
        expect(proposalSchema).not.toContain('"themePack"');
        expect(proposalSchema).not.toContain('"language"');
        expect(proposalSchema).toContain('"slides"');
        expect(JSON.stringify(context.messages)).toContain("请基于当前教案生成课堂 PPT");
        expect(JSON.stringify(context.messages)).not.toContain("工作范围：当前整份教案");
        return fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("query_dashi_layouts", {
        queries: [{ intent: "济南冬景中心问题导入", limit: 3 }],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: goal.slides.map((slide) => slide.layout),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
        ...presentationProposal(goal, "围绕中心问题组织三页课堂演示"),
      }), { stopReason: "toolUse" }),
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toEqual(expect.arrayContaining([
          "propose_classroom_presentation",
          "propose_document_patch",
          "read_document",
        ]));
        expect(turnContextOf(context)).not.toContain('"businessOutcome":"succeeded"');
        expect(JSON.stringify(context.messages)).toContain("[Server-authoritative approval outcome]");
        expect(JSON.stringify(context.messages)).toContain("Decision: approved and applied");
        expect(JSON.stringify(context.messages)).toContain('\\"status\\":\\"approval_required\\"');
        return fauxAssistantMessage("课堂演示已确认并生成。");
      },
    ]);
    const initialEvents: unknown[] = [];
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请基于当前教案生成课堂 PPT，使用 theme01，脚本确认后再交给 Dashi 渲染。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { initialEvents.push(event); });

    const approvals = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({ kind: "presentation_storyboard", goal });
    expect(initialEvents.map((event) => (event as { type: string }).type)).toEqual(expect.arrayContaining([
      "agent.started",
      "turn.started",
      "assistant.message.started",
      "assistant.message.ended",
      "tool.started",
      "tool.completed",
      "turn.ended",
      "agent.ended",
    ]));
    expect(initialEvents).toContainEqual(expect.objectContaining({ type: "approval.required" }));
    await expect(presentations.list(ownerId, lessonFileId)).resolves.toEqual([]);

    const continuationEvents: unknown[] = [];
    await coordinator.resumeApproval({
      userId: ownerId,
      runId: approvals[0]!.runId,
      approvalId: approvals[0]!.id,
      approved: true,
      idempotencyKey: "approve-once",
      emit: (event) => { continuationEvents.push(event); },
    });

    expect(calls).toEqual(["query", "query", "inspect", "render"]);
    await expect(presentations.list(ownerId, lessonFileId)).resolves.toHaveLength(1);
    const session = await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    );
    expect(session?.revision).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(session?.messages)).toContain('\\"status\\":\\"approval_required\\"');
    expect(JSON.stringify(session?.messages)).toContain('"role":"approval_outcome"');
    expect(JSON.stringify(session?.messages)).toContain("课堂演示已确认并生成。");
    expect(continuationEvents).toContainEqual(expect.objectContaining({ type: "run.completed" }));
    const deliveryIndex = continuationEvents.findIndex((event: any) => event.type === "approval.delivered");
    expect(deliveryIndex).toBeGreaterThanOrEqual(0);
    expect(deliveryIndex).toBeLessThan(continuationEvents.findIndex((event: any) => event.type === "message.delta"));
    const savedApproval = await repository.getApproval(ownerId, approvals[0]!.id);
    expect(await publicApproval(repository, savedApproval!)).toMatchObject({
      state: "approved", continuationStatus: "completed", delivery: { status: "ready" },
    });
    await coordinator.resumeApproval({
      userId: ownerId, runId: approvals[0]!.runId, approvalId: approvals[0]!.id,
      approved: true, idempotencyKey: "already-complete", emit: () => undefined,
    });
    expect(calls.filter((call) => call === "render")).toHaveLength(1);
  });

  it("streams A4 before tool completion and adopts a draft without taking over a later native turn", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const replacement = "提交两处文本证据，并解释它们如何支持判断。";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["assessment"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "修改评价", operations: [{ field: "assessment", replacement }],
      }), { stopReason: "toolUse" }),
    ]);
    const events: any[] = [];
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请修改评价练习，让它检验文本证据。", activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, event => { events.push(event); });
    const drafts = events.filter(event => event.type === "document.draft");
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.some(event => event.fields.assessment.length > 0 && event.fields.assessment.length < replacement.length)).toBe(true);
    expect(events.indexOf(drafts[0])).toBeLessThan(events.findIndex(event => event.type === "tool.started" && event.name === "propose_document_patch"));
    expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 0, document: lesson });
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(await repository.getRun(ownerId, approval!.runId)).toMatchObject({ status: "completed" });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    faux.setResponses([async () => { entered(); await finish; return fauxAssistantMessage("可以继续讨论。"); }]);
    const next = coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "你好", activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, () => {});
    await started;
    try {
      const decisionEvents: any[] = [];
      const args = { userId: ownerId, runId: approval!.runId, approvalId: approval!.id,
        approved: true, idempotencyKey: "adopt", emit: (event: any) => { decisionEvents.push(event); } };
      await coordinator.resumeApproval(args);
      await coordinator.resumeApproval(args);
      expect(decisionEvents.map(event => event.type)).toEqual(["document.updated", "approval.settled", "document.updated", "approval.settled"]);
      expect(await repository.getThread(ownerId, created.thread.id)).toMatchObject({ status: "running" });
      expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 1, document: { assessment: replacement } });
      expect(await repository.getApproval(ownerId, approval!.id)).toMatchObject({ state: "approved", continuationStatus: "completed" });
    } finally { release(); await next; }
  });

  it("cancels a partially streamed native document without persisting its text or an adoptable proposal", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["assessment"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "修改评价", operations: [{ field: "assessment", replacement: "用文本证据解释判断。".repeat(100) }],
      }), { stopReason: "toolUse" }),
    ]);
    let cancellation: Promise<boolean> | undefined;
    const events: any[] = [];
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请修改评价练习，让它检验文本证据。", activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, event => {
      events.push(event);
      if (event.type === "document.draft" && !cancellation) cancellation = coordinator.cancel(ownerId, event.runId);
    });
    expect(await cancellation).toBe(true);
    expect(events.some(event => event.type === "run.cancelled")).toBe(true);
    expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 0, document: lesson });
    expect((await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).filter(item => item.state === "pending")).toEqual([]);
  });

  it.each(["getMessage", "appendMessage"] as const)("releases a legacy continuation after %s initialization fails and safely retries", async (method) => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["assessment"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "修改评价", operations: [{ field: "assessment", replacement: "提交两处文本证据。" }],
      }), { stopReason: "toolUse" }),
    ]);
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请修改评价练习，让它检验文本证据。", activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, () => undefined);
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approval).toBeTruthy();
    await repository.updateRun(ownerId, approval!.runId, { status: "awaiting_approval" });
    const spy = vi.spyOn(repository, method).mockRejectedValueOnce(new Error("injected_initialization_failure"));
    const args = { userId: ownerId, runId: approval!.runId, approvalId: approval!.id,
      approved: true, idempotencyKey: "same-http-command", emit: () => undefined };
    await expect(coordinator.resumeApproval(args)).rejects.toThrow();
    spy.mockRestore();
    expect(await repository.getRun(ownerId, approval!.runId)).toMatchObject({ status: "failed" });
    expect(await repository.getThread(ownerId, created.thread.id)).toMatchObject({ status: "idle" });
    expect(await repository.getApproval(ownerId, approval!.id)).toMatchObject({ continuationStatus: "ready" });
    // A leaked active registration would leave cancel waiting forever.
    await expect(coordinator.cancel(ownerId, approval!.runId)).resolves.toBe(false);
    faux.setResponses([fauxAssistantMessage("修改已保存。")]);
    await coordinator.resumeApproval(args);
    expect(await repository.getRun(ownerId, approval!.runId)).toMatchObject({ status: "completed" });
    expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 1 });
  });

  it("recovers only the Pi reply after presentation delivery has committed", async () => {
    const { repository, created, faux, coordinator, calls } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", { layouts: goal.slides.map((slide) => slide.layout) }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", presentationProposal(goal, "确认三页演示")), { stopReason: "toolUse" }),
    ]);
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请基于当前教案生成课堂 PPT，使用 theme01。", activeSectionId: "process", documentVersion: 0, attachmentIds: [],
    }, () => undefined);
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approval).toBeTruthy();
    faux.setResponses([() => { throw new Error("reply_provider_disconnected"); }]);
    const args = { userId: ownerId, runId: approval!.runId, approvalId: approval!.id,
      approved: true, idempotencyKey: "first-delivery", emit: () => undefined };
    await expect(coordinator.resumeApproval(args)).rejects.toThrow();
    const failedReply = await repository.getApproval(ownerId, approval!.id);
    expect(await publicApproval(repository, failedReply!)).toMatchObject({
      state: "approved", continuationStatus: "ready", delivery: { status: "ready" },
    });
    expect((await repository.getLatestClassroomPresentationGeneration(ownerId, lessonFileId))?.status).toBe("ready");
    faux.setResponses([fauxAssistantMessage("演示已保存。")]);
    await coordinator.resumeApproval({ ...args, idempotencyKey: "reply-recovery" });
    expect(calls.filter((call) => call === "render")).toHaveLength(1);
    expect((await repository.getApproval(ownerId, approval!.id))?.continuationStatus).toBe("completed");
  });

  it("cancels a legacy continuation without undoing delivery or replaying a completed event", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["assessment"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", { summary: "修改评价",
        operations: [{ field: "assessment", replacement: "提交两处文本证据。" }] }), { stopReason: "toolUse" }),
    ]);
    const input = { userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请修改评价练习，让它检验文本证据。", activeSectionId: "assessment", documentVersion: 0, attachmentIds: [] };
    await coordinator.start(input, () => undefined);
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    let entered!: () => void;
    await repository.updateRun(ownerId, approval!.runId, { status: "awaiting_approval" });
    const started = new Promise<void>(resolve => { entered = resolve; });
    faux.setResponses([async (_context, options) => {
      entered();
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const events: string[] = [];
    const args = { userId: ownerId, runId: approval!.runId, approvalId: approval!.id,
      approved: true, idempotencyKey: "cancel-continuation", emit: (event: { type: string }) => { events.push(event.type); } };
    const resume = coordinator.resumeApproval(args);
    await started;
    await expect(coordinator.start(input, () => undefined)).rejects.toThrow("active_run_exists");
    await expect(coordinator.cancel(ownerId, approval!.runId)).resolves.toBe(true);
    await resume;
    await coordinator.resumeApproval(args);
    expect(events).toContain("run.cancelled");
    expect(events).not.toContain("run.completed");
    expect(await repository.getRun(ownerId, approval!.runId)).toMatchObject({ status: "cancelled" });
    expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 1 });
  });

  it("persists theme confirmation per branch and does not treat an acknowledgement as generation consent", async () => {
    const { repository, created, faux, coordinator, calls } = await fixture();
    faux.setResponses([
      (context) => {
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).toContain("快速对话");
        expect(turnContextOf(context)).toContain('"completion":"ask_presentation_theme"');
        return fauxAssistantMessage("请选择一个主题编号或名称，也可以说“你来选择”。");
      },
      (context) => {
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).toContain("快速对话");
        expect(turnContextOf(context)).toContain('"completion":"dismiss_presentation_theme"');
        return fauxAssistantMessage("好的，本次没有开始生成演示。");
      },
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请基于当前教案生成课堂 PPT。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction)
      .toMatchObject({ kind: "presentation_theme", originalRequest: "请基于当前教案生成课堂 PPT。" });

    await new Promise((resolve) => setTimeout(resolve, 2));
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "好的",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction).toBeNull();
    expect(calls).toEqual([]);
    expect(await repository.getLatestRun(ownerId, created.thread.id, created.branch.id))
      .toMatchObject({ status: "completed" });
  });

  it("continues the same branch immediately after a numeric theme choice", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const theme09Goal: DashiGoal = {
      ...goal,
      themePack: "theme09",
      slides: goal.slides.map((slide) => ({
        ...slide,
        layout: slide.layout.replace("theme01_", "theme09_"),
      })),
    };
    faux.setResponses([
      fauxAssistantMessage("请选择主题编号或名称，也可以说“你来选择”。"),
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: theme09Goal.slides.map((slide) => slide.layout),
      }), { stopReason: "toolUse" }),
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toContain("propose_classroom_presentation");
        expect(turnContextOf(context)).toContain('"confirmedTheme":"theme09"');
        expect(JSON.stringify(context.tools?.find((tool) => tool.name === "query_dashi_layouts")?.parameters))
          .not.toContain('"theme"');
        return fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
          ...presentationProposal(theme09Goal, "使用深蓝杂志风组织文本细读"),
        }), { stopReason: "toolUse" });
      },
    ]);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请基于当前教案生成课堂 PPT。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "09",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const approvals = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({ kind: "presentation_storyboard", goal: theme09Goal });
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction).toBeNull();
  });

  it("keeps the confirmed presentation capability across a failed run and a continue retry", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage("请选择主题编号或名称。"),
      () => { throw new Error("simulated_presentation_provider_crash"); },
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: goal.slides.map((slide) => slide.layout.replace("theme01_", "theme09_")),
      }), { stopReason: "toolUse" }),
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toContain("propose_classroom_presentation");
        expect(turnContextOf(context)).toContain('"confirmedTheme":"theme09"');
        return fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
          ...presentationProposal({
            ...goal,
            themePack: "theme09",
            slides: goal.slides.map((slide) => ({
              ...slide,
              layout: slide.layout.replace("theme01_", "theme09_"),
            })),
          }, "重试后完成演示"),
        }), { stopReason: "toolUse" });
      },
    ]);
    const input = {
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    };
    await coordinator.start({ ...input, message: "请生成课堂 PPT。" }, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await coordinator.start({ ...input, message: "theme09" }, () => undefined);
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction)
      .toMatchObject({ kind: "presentation_generation", confirmedTheme: "theme09" });
    expect(await repository.getLatestRun(ownerId, created.thread.id, created.branch.id))
      .toMatchObject({ status: "failed" });

    await coordinator.start({ ...input, message: "theme09", continuation: true }, () => undefined);
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .toHaveLength(1);
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction).toBeNull();
  });

  it("forces a prose-only response to finish the native Dashi goal before completing", async () => {
    const { repository, created, faux, coordinator, presentations } = await fixture();
    const publicEvents: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("## 第 1 页：济南的冬天\n\n中心问题：济南的冬天为什么温晴？"),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: goal.slides.map((slide) => slide.layout),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
        ...presentationProposal(goal, "围绕中心问题组织三页课堂演示"),
      }), { stopReason: "toolUse" }),
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请用 theme01 生成课堂演示，确认后再交给 Dashi 渲染。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, (event) => { publicEvents.push(event); });

    const approvals = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({ kind: "presentation_storyboard", goal });
    const run = await repository.getRun(ownerId, approvals[0]!.runId);
    expect(run).toMatchObject({ status: "awaiting_approval" });
    const assistant = await repository.getMessage(ownerId, run!.assistantMessageId!);
    expect(assistant?.content).toBe("");
    expect(publicEvents).not.toContainEqual(expect.objectContaining({ type: "message.delta" }));
    expect(publicEvents.filter((event) => (event as { type: string }).type === "agent.started")).toHaveLength(1);
    expect(publicEvents.filter((event) => (event as { type: string }).type === "agent.ended")).toHaveLength(1);
    expect((await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    ))?.revision).toBeGreaterThanOrEqual(1);
    await expect(presentations.list(ownerId, lessonFileId)).resolves.toEqual([]);
  });

  it("keeps a native Dashi validation failure inside the same run so Pi can correct it before approval", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const invalidGoal = { ...goal, title: "INVALID" };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: goal.slides.map((slide) => slide.layout),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
        ...presentationProposal(invalidGoal, "第一次提交"),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_classroom_presentation", {
        ...presentationProposal(goal, "修正 Dashi 属性后提交"),
      }), { stopReason: "toolUse" }),
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请用 theme01 生成课堂 PPT。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const approvals = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({
      kind: "presentation_storyboard",
      summary: "修正 Dashi 属性后提交",
      goal,
    });
  });

  it("treats an acknowledgement after a completed presentation as a new lightweight turn", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    await repository.createRun({
      id: "previous-presentation-run",
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      model: "test-model",
      status: "completed",
      capabilityPlan: deterministicCapabilityPlan("生成课堂演示，确认后交给 Dashi"),
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    faux.setResponses([(context) => fauxAssistantMessage(
      turnContextOf(context).includes('"completion":"brief_reply_only"')
        ? "好的，需要时再告诉我。"
        : "错误地延续了上一轮任务。",
    )]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "好的",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const latest = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(latest?.capabilityPlan).toMatchObject({
      presentationRequested: false,
      lightweightConversation: true,
      executionLane: "fast",
      skillIds: [],
      toolGroups: [],
    });
    await expect(repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .resolves.toHaveLength(0);
    const assistant = await repository.getMessage(ownerId, latest!.assistantMessageId!);
    expect(assistant?.content).toBe("好的，需要时再告诉我。");
  });

  it("answers a thank-you with the same model on a Fast chat view, not canned text", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    await repository.createRun({
      id: "previous-write-run",
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      model: "test-model",
      status: "completed",
      capabilityPlan: deterministicCapabilityPlan("请修改评价练习，并提交确认提案。"),
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    let toolNames: string[] = [];
    let systemPrompt = "";
    faux.setResponses([(context) => {
      toolNames = (context.tools ?? []).map((tool) => tool.name);
      systemPrompt = context.systemPrompt ?? "";
      expect(turnContextOf(context)).toContain('"completion":"brief_reply_only"');
      return fauxAssistantMessage("这次改完了，后面要调整再说一声就好。");
    }]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "好的 谢谢",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
      thinkingLevel: "max",
    }, () => undefined);

    expect(toolNames).toEqual([]);
    expect(systemPrompt).toContain("快速对话");
    expect(systemPrompt).not.toContain("dashi-ppt");
    const latest = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(latest).toMatchObject({ capabilityPlan: { lightweightConversation: true, executionLane: "fast" } });
    expect(latest?.tokenUsage).toMatchObject({
      requests: 1,
      inputTokens: expect.any(Number),
      cachedInputTokens: expect.any(Number),
    });
    const assistant = await repository.getMessage(ownerId, latest!.assistantMessageId!);
    expect(assistant?.content).toBe("这次改完了，后面要调整再说一声就好。");
  });

  it("does not make Fast chat wait for or depend on the Skill catalog", async () => {
    const { repository, created, faux } = await fixture();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([() => fauxAssistantMessage("不客气。")]);
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: {
        load: async () => { throw new Error("skill_catalog_unavailable"); },
      } as never,
    });

    await expect(coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "谢谢",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined)).resolves.toBeUndefined();

    const latest = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(latest?.status).toBe("completed");
  });

  it("does not forward PromptBar depth onto a thank-you Fast turn", async () => {
    const { repository, created, faux } = await fixture();
    const models = createModels();
    models.setProvider(faux.provider);
    const efforts: unknown[] = [];
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        efforts.push(options?.reasoning);
        return models.streamSimple(model, context, options);
      },
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: createNodeSkillRegistry(),
    });
    faux.setResponses([() => fauxAssistantMessage("不客气，这次先这样。")]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "好的 谢谢",
      activeSectionId: "assessment",
      documentVersion: 0,
      attachmentIds: [],
      thinkingLevel: "max",
    }, () => undefined);

    expect(efforts).toContain("low");
    expect(efforts).not.toContain("max");
  });

  it("forwards the PromptBar thinking level on Agent teaching work", async () => {
    const { repository, created, faux } = await fixture();
    const models = createModels();
    models.setProvider(faux.provider);
    const efforts: unknown[] = [];
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        efforts.push(options?.reasoning);
        return models.streamSimple(model, context, options);
      },
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: createNodeSkillRegistry(),
    });
    faux.setResponses([() => fauxAssistantMessage("过程已经完整。")]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "这份教案的教学过程写得怎么样？",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
      thinkingLevel: "max",
    }, () => undefined);

    expect(efforts).toContain("max");
  });

  it("applies a semester-framework proposal only after approval in the same Pi branch", async () => {
    const repository = new MemoryLessonRepository();
    const semesterOwner = "pi-semester-owner";
    await repository.importNotebookGraph(semesterOwner, [{
      id: "semester-notebook",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const framework = await repository.createSemesterFramework(
      semesterOwner,
      "semester-notebook",
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
      "pi-semester-framework",
    );
    const created = await repository.createThread(semesterOwner, {
      notebookId: "semester-notebook",
      resourceType: "semester_framework",
      semesterFrameworkId: framework.framework.id,
      title: "学期规划",
    }, "pi-semester-thread");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: createNodeSkillRegistry(),
    });
    const unit = framework.units[0]!;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_semester_framework", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_semester_framework_patch", {
        summary: "补充第一单元实施提示",
        operations: [{
          op: "replace_unit_field",
          unitId: unit.id,
          field: "teacherNotes",
          expectedValue: "",
          replacement: "每周根据出口条结果调整下一课时的基础练习比例。",
        }],
      }), { stopReason: "toolUse" }),
    ]);

    await coordinator.start({
      userId: semesterOwner,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请修改第一单元教师备注，补充基于出口条动态调整练习的实施提示。",
      documentVersion: 0,
      activeSectionId: "",
      activeUnitId: unit.id,
      attachmentIds: [],
    }, () => undefined);
    const [approval] = await repository.listPendingApprovals(
      semesterOwner,
      created.thread.id,
      created.branch.id,
    );
    expect(approval?.patch).toMatchObject({
      frameworkId: framework.framework.id,
      baseFrameworkVersion: 0,
    });
    expect((await repository.getSemesterFramework(
      semesterOwner,
      framework.framework.id,
    ))?.units[0]?.teacherNotes).toBe("");

    faux.setResponses([fauxAssistantMessage("学期框架已按确认更新。")]);
    await coordinator.resumeApproval({
      userId: semesterOwner,
      runId: approval!.runId,
      approvalId: approval!.id,
      approved: true,
      idempotencyKey: "approve-semester-framework",
      emit: () => undefined,
    });
    const updated = await repository.getSemesterFramework(semesterOwner, framework.framework.id);
    expect(updated?.framework.version).toBe(1);
    expect(updated?.units[0]?.teacherNotes).toContain("出口条");
    expect((await repository.getAgentRuntimeSession(
      semesterOwner,
      created.thread.id,
      created.branch.id,
      "pi",
    ))?.revision).toBeGreaterThanOrEqual(2);
  });

  it("settles a turn while context compaction is still summarizing in the background", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-a",
      title: "语文备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{ id: lessonFileId, title: "济南的冬天", pages: 1, lessonPlan: lesson }],
    }]);
    const created = await repository.createThread(ownerId, {
      notebookId: "notebook-a",
      lessonFileId,
      title: "上下文压缩",
    }, "pi-compaction-thread");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    let summarizerCalls = 0;
    let releaseSummarizer = () => {};
    const summarizerBlocked = new Promise<void>((resolve) => { releaseSummarizer = resolve; });
    const summarizerOptions: Array<{ cacheRetention?: string; sessionId?: string }> = [];
    const streamFn: StreamFn = async (model, context, options) => {
      if (context.systemPrompt?.includes("会话记忆压缩器")) {
        summarizerCalls += 1;
        summarizerOptions.push({
          cacheRetention: options?.cacheRetention,
          sessionId: options?.sessionId,
        });
        await summarizerBlocked;
      }
      return models.streamSimple(model, context, options);
    };
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn,
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: createNodeSkillRegistry(),
    });

    await repository.saveAgentRuntimeSession({
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      runtime: "pi",
      expectedRevision: 0,
      messages: encodePiAgentMessages(bulkyHistory(COMPACT_HISTORY_TURNS)),
    });

    faux.setResponses([
      fauxAssistantMessage("这份教案的教学过程已经完整。"),
      memorySummaryResponse(),
    ]);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "先判断这份教案是否需要重新编写",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    expect(await repository.getLatestRun(ownerId, created.thread.id, created.branch.id))
      .toMatchObject({ status: "completed" });
    expect(summarizerCalls).toBe(1);
    expect(summarizerOptions[0]).toMatchObject({ cacheRetention: "none" });
    expect(summarizerOptions[0]?.sessionId).toMatch(/^lessonup-memory:/);
    expect(await repository.getThreadMemory(ownerId, created.thread.id, created.branch.id))
      .toBeFalsy();

    releaseSummarizer();
    await vi.waitFor(async () => {
      expect(await repository.getThreadMemory(ownerId, created.thread.id, created.branch.id))
        .toBeTruthy();
    });
  });

  it("compacts mid-run before the next model turn and keeps memory aligned with the session", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph(ownerId, [{
      id: "notebook-a",
      title: "语文备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{ id: lessonFileId, title: "济南的冬天", pages: 1, lessonPlan: lesson }],
    }]);
    const created = await repository.createThread(ownerId, {
      notebookId: "notebook-a",
      lessonFileId,
      title: "轮间压缩",
    }, "pi-mid-run-compaction");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const summarizerSessionIds: string[] = [];
    const teacherSessionIds: string[] = [];
    const streamFn: StreamFn = async (model, context, options) => {
      if (context.systemPrompt?.includes("会话记忆压缩器")) {
        expect(options?.cacheRetention).toBe("none");
        expect(options?.sessionId).toMatch(/^lessonup-memory:/);
        summarizerSessionIds.push(options?.sessionId ?? "");
      } else if (options?.sessionId) {
        teacherSessionIds.push(options.sessionId);
      }
      return models.streamSimple(model, context, options);
    };
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn,
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: createNodeSkillRegistry(),
    });

    await repository.saveAgentRuntimeSession({
      ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      runtime: "pi",
      expectedRevision: 0,
      messages: encodePiAgentMessages(bulkyHistory(COMPACT_HISTORY_TURNS)),
    });

    let sawMemoryOnSecondTurn = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", { fields: ["process"] }), { stopReason: "toolUse" }),
      memorySummaryResponse(),
      (context) => {
        expect(JSON.stringify(context.messages ?? [])).toContain("untrusted-summary");
        sawMemoryOnSecondTurn = true;
        return fauxAssistantMessage("教学过程已经能支撑中心问题。");
      },
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "先判断这份教案的教学过程是否合理",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    expect(sawMemoryOnSecondTurn).toBe(true);
    expect(await repository.getLatestRun(ownerId, created.thread.id, created.branch.id))
      .toMatchObject({ status: "completed" });
    const session = await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    );
    const storedMemory = await repository.getThreadMemory(
      ownerId,
      created.thread.id,
      created.branch.id,
    );
    expect(storedMemory?.cursor).toBeGreaterThan(0);
    expect(storedMemory?.cursor).toBeLessThan(session?.messages.length ?? 0);
    expect(summarizerSessionIds).toHaveLength(1);
    expect(teacherSessionIds.length).toBeGreaterThan(0);
    expect(summarizerSessionIds[0]).not.toBe(teacherSessionIds[0]);
  });

  it("keeps the request prefix byte-identical across turns so the provider can cache it", async () => {
    const { created, faux, coordinator } = await fixture();
    const systemPrompts: Array<string | undefined> = [];
    const toolPrefixes: string[] = [];
    const turnContexts: string[] = [];
    const capture = (context: { systemPrompt?: string; messages?: unknown; tools?: Array<{ name?: string; description?: string; parameters?: unknown }> }) => {
      systemPrompts.push(context.systemPrompt);
      toolPrefixes.push(JSON.stringify((context.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))));
      turnContexts.push(turnContextOf(context));
      return fauxAssistantMessage("好的。");
    };
    faux.setResponses([capture, capture]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "这份教案的教学过程写得怎么样？",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "教学准备写得怎么样？",
      activeSectionId: "preparation",
      documentVersion: 0,
      attachmentIds: [],
      thinkingLevel: "max",
    }, () => undefined);

    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[0]).toBe(systemPrompts[1]);
    expect(systemPrompts[0]).not.toContain("dashi-ppt");
    expect(systemPrompts[0]).not.toContain('trust="server-policy"');
    expect(systemPrompts[0]).not.toContain('"sectionId"');
    expect(toolPrefixes[0]).toBe(toolPrefixes[1]);
    expect(toolPrefixes[0]).toContain("propose_document_patch");
    expect(toolPrefixes[0]).not.toContain("theme0");
    expect(turnContexts[0]).toContain('"sectionId":"process"');
    expect(turnContexts[1]).toContain('"sectionId":"preparation"');
    expect(turnContexts[1]).toContain('"completion":"analysis_only"');
  });
});
