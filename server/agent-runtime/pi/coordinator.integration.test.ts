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
import type { QueryEmbedder } from "../../providers/query-embedding.js";

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

async function fixture(options: { embedQuery?: QueryEmbedder | null } = {}) {
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
    embedQuery: options.embedQuery,
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

  it("lets native Pi propose A4 content without decorative subheadings", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    repository.searchCurriculumStandards = async () => [{
      id: "standard-1",
      title: "义务教育语文课程标准",
      kind: "public",
      passage: "结合具体语言材料形成理解。",
      score: 1,
    }];
    faux.setResponses([
      (context) => {
        expect(context.systemPrompt).toContain("重要性是突出显示的首要依据");
        expect(context.systemPrompt).toContain("段落或清单已能表达清楚时不加小标题");
        expect(context.systemPrompt).not.toContain("<available_skills>");
        expect((context.tools ?? []).map((tool) => tool.name)).not.toContain("read_skill");
        return fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("search_curriculum_standards", {
        query: "语文阅读 理解语言材料",
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "完善教学过程",
        operations: [{
          field: "process",
          replacement: "学生圈画==关键证据==，再解释它如何支持判断。",
        }],
      }), { stopReason: "toolUse" }),
    ]);

    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "请依据当前信息完整编写教案并提交确认。",
      activeSectionId: "process",
      documentVersion: 0,
      attachmentIds: [],
    }, () => undefined);

    const approvals = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.patch).toMatchObject({
      operations: [{ field: "process", replacement: "学生圈画==关键证据==，再解释它如何支持判断。" }],
    });
    expect(await repository.getLessonFile(ownerId, lessonFileId)).toMatchObject({ documentVersion: 0 });
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run?.tokenUsage?.requests).toBe(3); // Read, evidence, proposal; no Skill-read request.
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

  it("cancels a native provider stalled before its first token and replays cancellation without resending", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    faux.setResponses([async (_context, options) => {
      calls += 1; started();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const input = { userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "检查现有教学过程", activeSectionId: "process", documentVersion: 0, attachmentIds: [], clientCommandId: crypto.randomUUID() };
    const events: any[] = [];
    const runTask = coordinator.start(input, async (event, delivery) => {
      events.push(event);
      if (delivery?.persist !== false) await repository.appendRunEvent(ownerId, event.runId, event.type, event);
    });
    await providerStarted;
    const run = (await repository.getLatestRun(ownerId, created.thread.id, created.branch.id))!;
    await expect(coordinator.cancel("another-owner", run.id)).resolves.toBe(false);
    await expect(coordinator.cancel(ownerId, run.id)).resolves.toBe(true);
    await runTask;
    expect(await repository.getRun(ownerId, run.id)).toMatchObject({ status: "cancelled" });
    expect(events.some((event) => event.type === "run.completed" || event.type === "message.delta")).toBe(false);
    const replay: any[] = [];
    await coordinator.start(input, (event) => { replay.push(event); });
    expect(replay.at(-1)).toMatchObject({ type: "run.cancelled", runId: run.id });
    expect(calls).toBe(1);
    expect(await repository.getThread(ownerId, created.thread.id)).toMatchObject({ status: "idle" });
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

  it("continues with Dashi after a theme choice even when the editor saved a newer version", async () => {
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
    await repository.saveLessonDocument({
      ownerId,
      fileId: lessonFileId,
      baseVersion: 0,
      document: { ...lesson, process: `${lesson.process}；课堂补充活动` },
      pageCount: 1,
      source: "manual",
      idempotencyKey: "theme-choice-autosave",
    });
    await coordinator.start({
      userId: ownerId,
      threadId: created.thread.id,
      branchId: created.branch.id,
      message: "09",
      activeSectionId: "process",
      documentVersion: 1,
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

  it("keeps ordinary teaching and Fast chat independent of a failed Dashi catalog", async () => {
    const { repository, created, faux } = await fixture();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("不客气。"), fauxAssistantMessage("先验证学生能否独立解释证据。")]);
    const coordinator = new PiLessonAgentCoordinator(repository, {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      sessionSecret: "test-only-pi-session-secret-32-characters",
      registry: {
        load: async () => { throw new Error("skill_catalog_unavailable"); },
      } as never,
    });

    for (const message of ["谢谢", "先分析当前课堂最应该验证的问题，不修改教案。"]) {
      await expect(coordinator.start({
        userId: ownerId,
        threadId: created.thread.id,
        branchId: created.branch.id,
        message,
        activeSectionId: "assessment",
        documentVersion: 0,
        attachmentIds: [],
      }, () => undefined)).resolves.toBeUndefined();
    }

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
    expect(systemPrompts[0]).toContain("=={pink}文字==");
    expect(systemPrompts[0]).toContain("可编辑的 Markdown 原文");
    expect(systemPrompts[0]).toContain("依据本课内容的重要性");
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

describe("Pi coordinator lesson questions, retrieval and diagnostics", () => {
  const start = (
    fixtureValue: Awaited<ReturnType<typeof fixture>>,
    message: string,
    extra: Partial<Parameters<PiLessonAgentCoordinator["start"]>[0]> = {},
  ) => fixtureValue.coordinator.start({
    userId: ownerId,
    threadId: fixtureValue.created.thread.id,
    branchId: fixtureValue.created.branch.id,
    message,
    activeSectionId: "process",
    documentVersion: 0,
    attachmentIds: [],
    ...extra,
  }, () => undefined);

  it("gives a question about the lesson the Agent lane, where the document can be read", async () => {
    const value = await fixture();
    let toolNames: string[] = [];
    let systemPrompt = "";
    value.faux.setResponses([(context) => {
      toolNames = (context.tools ?? []).map((tool) => tool.name);
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("导入约占五分钟，偏长，可以压缩到三分钟。");
    }]);
    await start(value, "这节课的导入是不是太长了？");
    // Before, any short question without an exact field name took the tool-free
    // Fast lane, whose prompt says it cannot read the lesson at all.
    expect(toolNames).toContain("read_document");
    expect(systemPrompt).not.toContain("快速对话");
    const latest = await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id);
    expect(latest?.capabilityPlan).toMatchObject({ executionLane: "agent" });
  });

  it("embeds a retrieval query with the injected service and ranks with that vector", async () => {
    const embedded: string[] = [];
    const value = await fixture({ embedQuery: async (query) => { embedded.push(query); return [0.25, 0.75]; } });
    const searches: unknown[][] = [];
    value.repository.searchKnowledge = async (...args) => {
      searches.push(args);
      return [{ id: "source-1", title: "我上传的资料", kind: "private", chunkId: "chunk-1", passage: "济南的冬天写于1931年。", score: 1 }];
    };
    value.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_knowledge", { query: "济南的冬天 写作背景" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("资料显示这篇文章写于1931年。"),
    ]);
    await start(value, "请根据我上传的文件说明济南的冬天的写作背景");
    expect(embedded).toEqual(["济南的冬天 写作背景"]);
    expect(searches[0]?.slice(2)).toEqual(["济南的冬天 写作背景", 6, [0.25, 0.75]]);
    expect(await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id))
      .toMatchObject({ status: "completed" });
  });

  it("lets a consultation say honestly that the standards search found nothing", async () => {
    const value = await fixture();
    value.repository.searchCurriculumStandards = async () => [];
    value.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_curriculum_standards", { query: "写作 学段要求" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("我检索了课标，没有找到与这个问题直接对应的条款，所以不能引用课标原文回答。"),
    ]);
    await start(value, "课标对这个学段的写作要求是什么？");
    const run = await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id);
    // The search ran and came back empty. That used to end the run as
    // evidence_required, punishing the answer that admits nothing was found.
    expect(run).toMatchObject({ status: "completed", capabilityPlan: { evidenceRequired: true } });
    expect(run?.error ?? null).toBeNull();
    expect(await value.repository.listRunEvidence(ownerId, run!.id)).toEqual([]);
  });

  it("still fails a consultation that answered a required-evidence question without searching", async () => {
    const value = await fixture();
    value.faux.setResponses([fauxAssistantMessage("课标要求学生能写出条理清楚的记叙文。")]);
    await start(value, "课标对这个学段的写作要求是什么？");
    expect(await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id))
      .toMatchObject({ status: "failed", error: "evidence_required" });
  });

  it("exposes required sources before authoring and completes honestly when the search is empty", async () => {
    const value = await fixture();
    value.repository.searchCurriculumStandards = async () => [];
    let turnContext = "";
    value.faux.setResponses([
      (context) => {
        turnContext = turnContextOf(context);
        return fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("search_curriculum_standards", { query: "语文 学段要求" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("complete_without_change", {
        kind: "insufficient_evidence",
        reason: "当前没有检索到本课必需的课标依据，请先补充可核验的课标来源，再编写完整教案。",
      }), { stopReason: "toolUse" }),
    ]);
    await start(value, "请完整编写这节课的教案并提交确认");
    expect(turnContext).toContain('"required":true');
    expect(turnContext).toContain("curriculum_standard_search");
    expect(turnContext).toContain("do not repeat the same empty searches");
    expect(await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id))
      .toMatchObject({ status: "completed" });
    expect(await value.repository.listPendingApprovals(ownerId, value.created.thread.id, value.created.branch.id)).toHaveLength(0);
    expect((await value.repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);
  });

  it("does not let a search that found nothing back a lesson change", async () => {
    const value = await fixture();
    value.repository.searchCurriculumStandards = async () => [];
    let afterProposal = "";
    value.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_curriculum_standards", { query: "评价 课标" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", {
        summary: "让评价练习对照课标",
        operations: [{ field: "assessment", replacement: "学生提交两处景物描写证据，并说明它们如何表现温晴。" }],
      }), { stopReason: "toolUse" }),
      (context) => {
        afterProposal = JSON.stringify(context.messages ?? []);
        return fauxAssistantMessage("没有检索到对应的课标条款，我先不改。");
      },
      fauxAssistantMessage("没有检索到对应的课标条款，我先不改。"),
      fauxAssistantMessage("没有检索到对应的课标条款，我先不改。"),
    ]);
    await start(value, "请修改评价练习，并对照课标");
    // A write is only as good as the source behind it: the proposal was
    // refused with the reads still missing, and no card reached the teacher.
    expect(afterProposal).toContain("evidence_required");
    expect(afterProposal).toContain("curriculum_standard_search");
    expect(await value.repository.listPendingApprovals(ownerId, value.created.thread.id, value.created.branch.id))
      .toHaveLength(0);
    expect(await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id))
      .toMatchObject({ status: "failed" });
  });

  it("logs why a run failed, with ids and the error but never what the teacher wrote", async () => {
    const value = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      value.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read_document", { fields: ["process"] }), { stopReason: "toolUse" }),
        () => { throw new Error("simulated_provider_crash"); },
      ]);
      await start(value, "先判断这份教案的教学过程是否合理");
      const run = await value.repository.getLatestRun(ownerId, value.created.thread.id, value.created.branch.id);
      expect(run).toMatchObject({ status: "failed" });
      const entry = log.mock.calls.find((call) => call[0] === "Agent failure");
      expect(entry).toBeDefined();
      const detail = JSON.parse(String(entry![1])) as { source: string; runId: string; threadId: string; code: string; error: { message: string } };
      expect(detail).toMatchObject({ source: "run", runId: run!.id, threadId: value.created.thread.id, code: run!.error });
      expect(detail.error.message).toContain("simulated_provider_crash");
      expect(String(entry![1])).not.toContain("先判断这份教案的教学过程是否合理");
    } finally {
      log.mockRestore();
    }
  });
});

describe("Pi teaching investigation", () => {
  it("can investigate real feedback and retrieve evidence without routing keywords or specialist calls", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    await repository.createLessonClassFeedback(ownerId, {
      lessonFileId, kind: "practice_gap", statement: "学生能圈画句子，但不能解释它怎样支持温晴的判断。",
    });
    repository.searchKnowledge = async () => [{
      id: "teaching-evidence", title: "已上传的课堂观察记录", kind: "private", score: 1,
      passage: "让学生在引用句子后补充景物特征与判断之间的解释。",
    }];
    faux.setResponses([
      (context) => {
        const names = (context.tools ?? []).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining([
          "read_lesson_class_feedback", "read_lesson_design_basis", "search_knowledge", "search_curriculum_standards",
        ]));
        expect(names).not.toContain("read_skill");
        expect(names).not.toContain("critic");
        expect(names).not.toContain("assessment");
        expect(context.systemPrompt).toContain("支持及反例");
        return fauxAssistantMessage(fauxToolCall("read_lesson_class_feedback", {}), { stopReason: "toolUse" });
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("不能解释它怎样支持温晴的判断");
        return fauxAssistantMessage(fauxToolCall("search_knowledge", { query: "文本证据与判断之间的解释支架" }), { stopReason: "toolUse" });
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("补充景物特征与判断之间的解释");
        return fauxAssistantMessage("观察提示断点可能在解释而非找句子。先让学生独立补写一句证据与判断的联系，再比较是否仍需支架；目前不能认定调整已经有效。");
      },
    ]);
    await coordinator.start({
      userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "先看看有什么值得保留的，以及最应该验证的假设。只分析。",
      activeSectionId: "process", documentVersion: 0, attachmentIds: [],
    }, () => undefined);
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({ status: "completed", tokenUsage: { requests: 3 }, capabilityPlan: { mcpServers: [] } });
    expect(await repository.listRunEvidence(ownerId, run!.id)).toMatchObject([{ kind: "knowledge_search" }]);
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).toHaveLength(0);
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);
  });
});

describe("Pi grounded completion and learning proposals", () => {
  it("keeps a structured analysis action read-only even when its text asks for a write", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_document_patch", { summary: "修改评价", operations: [{ field: "assessment", replacement: "不应写入" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("本轮只作分析：保留现稿，并核对学生能否用文本证据解释判断。"),
    ]);
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请直接修改评价练习。", taskIntent: { type: "analysis" }, activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, () => undefined);
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).toHaveLength(0);
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);
    expect(await repository.getLatestRun(ownerId, created.thread.id, created.branch.id)).toMatchObject({ status: "completed" });
  });
  it("completes an explicit change request without inventing a patch when the current content is sufficient", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("complete_without_change", {
        kind: "no_change_needed", reason: "现稿已要求学生用两处文本证据回答中心问题，活动与评价已对应，没有必要再增加同类任务。",
      }), { stopReason: "toolUse" }),
    ]);
    const events: Array<{ type: string; outcome?: string }> = [];
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请先检查评价是否已经直接检验本课目标。只有确有必要时修改评价栏目；否则保留现稿，通过无修改完成说明具体理由。不要增加重复任务。", taskIntent: { type: "document_write", fields: ["assessment"] }, activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, (event) => { events.push(event); });
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({ status: "completed", tokenUsage: { requests: 2 } });
    expect(events.some((event) => event.type === "tool.completed" && event.outcome === "no_change")).toBe(true);
    expect((await repository.getMessage(ownerId, run!.assistantMessageId!))?.content).toContain("没有必要再增加");
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).toHaveLength(0);
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);
  });

  it("lets a structured learning action produce a scoped proposal, never a document write or teacher decision", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const { LearningService } = await import("../../learning/service.js");
    const service = new LearningService(repository);
    const baseline = await service.recordEvidence({ ownerId, lessonFileId }, {
      documentVersion: 0, objective: "解释文本证据如何支持温晴", task: "独立解释一处景物证据", criterion: "说清证据与判断的联系",
      learnerGroup: "一班", observation: "能够圈画但解释不充分", method: "student_work",
      observedAt: new Date(Date.now() - 60_000).toISOString(), sourceReference: "课堂解释卡",
    }, "pi-learning-baseline");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_learning_progress", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_learning_inquiry", {
        hypothesis: "困难可能在连接证据与结论", alternativeExplanation: "也可能受书面表达负担影响",
        intervention: "先口头解释证据的作用再补写一句联系", expectedSignal: "学生独立解释证据与结论的联系",
        checkPlan: "以同一判据比较下一次独立作答，并保留未达成样本",
      }), { stopReason: "toolUse" }),
    ]);
    const events: string[] = [];
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请准备学习改进方案。", taskIntent: { type: "learning_inquiry", evidenceId: baseline.id },
      activeSectionId: "process", documentVersion: 0, attachmentIds: [],
    }, (event) => { events.push(event.type); });
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run).toMatchObject({ status: "completed", tokenUsage: { requests: 2 } });
    const progress = await service.read({ ownerId, lessonFileId });
    expect(progress.inquiries).toHaveLength(1);
    expect(progress.inquiries[0]).toMatchObject({ state: "proposed", sourceRunId: run!.id, baselineEvidenceId: baseline.id });
    expect(progress.inquiries[0]!.implementedAt).toBeUndefined();
    expect(events).toContain("learning.updated");
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).toHaveLength(0);
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);

    const inquiry = progress.inquiries[0]!;
    await service.act({ ownerId, lessonFileId }, inquiry.id, { action: "adopt", expectedVersion: 0 }, "adopt");
    const implemented = await service.act({ ownerId, lessonFileId }, inquiry.id, { action: "implement", expectedVersion: 1 }, "implement");
    const followup = await service.recordEvidence({ ownerId, lessonFileId }, {
      documentVersion: 0, objective: baseline.objective, task: "独立解释另一处词句", criterion: baseline.criterion,
      learnerGroup: baseline.learnerGroup, observation: "能解释证据与结论的联系", method: "student_work",
      observedAt: new Date().toISOString(), sourceReference: "后续独立解释卡", inquiryId: inquiry.id,
    }, "followup");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_learning_progress", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_learning_review", {
        outcome: "supported", rationale: "独立解释出现，符合预期信号", limitations: "任务熟悉度仍可能影响表现，不能证明因果效果",
      }), { stopReason: "toolUse" }),
    ]);
    await coordinator.start({ userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "请核对复测证据，提出待审议建议。", taskIntent: { type: "learning_review", inquiryId: inquiry.id, evidenceId: followup.id, expectedVersion: implemented.version },
      activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, () => undefined);
    const reviewRun = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(reviewRun).toMatchObject({ status: "completed", tokenUsage: { requests: 2 } });
    const updated = (await service.read({ ownerId, lessonFileId })).inquiries[0]!;
    expect(updated).toMatchObject({ state: "implemented", proposedReview: { outcome: "supported", evidenceId: followup.id, sourceRunId: reviewRun!.id } });
    expect(updated.review).toBeUndefined();
  });

  it("recovers from an attempted no-change completion and persists an evidence-gap decision", async () => {
    const { repository, created, faux, coordinator } = await fixture();
    const file = await repository.getLessonFile(ownerId, lessonFileId);
    const [field, excerpt] = Object.entries(file!.document).find(([, value]) => value.trim().length > 0)!;
    faux.setResponses([
      (context) => {
        expect(turnContextOf(context)).toContain("never complete_without_change");
        return fauxAssistantMessage(fauxToolCall("read_decision_context", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("complete_without_change", {
        kind: "insufficient_evidence", reason: "缺少本班真实观察，不能确定新任务是否适用。",
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_decision", {
        decisionType: "assessment", question: "是否增加无提示迁移任务？",
        options: [
          { id: "keep", statement: "保留当前评价", tradeoffs: ["负担较低，但未检验迁移"] },
          { id: "transfer", statement: "增加迁移评价", tradeoffs: ["可观察迁移，但增加时间与难度"] },
        ],
        rationale: "尚缺实际独立作答证据，记录问题供教师核对。",
        uncertainties: ["缺少本班学生在新任务上的实际表现"],
        evidenceCards: [{
          kind: "assessment_item", level: "primary",
          source: { uri: "lessonup://lesson-files/current", locator: field },
          excerpt, claim: "教案文本只能说明设计，不能证明学生学习效果。", applicability: "本课教案设计",
          limitations: ["尚无学生观察"], confidence: 0.8,
        }],
        status: "insufficient_evidence",
      }), { stopReason: "toolUse" }),
    ]);
    const completions: Array<{ name: string; ok: boolean }> = [];
    await coordinator.start({
      userId: ownerId, threadId: created.thread.id, branchId: created.branch.id,
      message: "准备一个评价决策候选，缺证据时记录证据不足。",
      taskIntent: { type: "decision_proposal" }, activeSectionId: "assessment", documentVersion: 0, attachmentIds: [],
    }, (event) => { if (event.type === "tool.completed") completions.push({ name: event.name, ok: event.ok }); });
    const run = await repository.getLatestRun(ownerId, created.thread.id, created.branch.id);
    expect(run?.status).toBe("completed");
    expect(completions).toContainEqual({ name: "complete_without_change", ok: false });
    expect(completions).toContainEqual({ name: "propose_decision", ok: true });
    const candidates = await repository.listDecisions(ownerId, lessonFileId, 20);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ status: "insufficient_evidence", provenance: { createdBy: "agent", confirmedBy: null } });
    const cards = await repository.listDecisionEvidenceCards(ownerId, lessonFileId, candidates[0].evidenceCardIds);
    expect(cards[0].source).toMatchObject({ system: "lessonup", uri: `lessonup://lesson-files/${lessonFileId}`, version: "0", locator: field });
    expect((await repository.getLessonFile(ownerId, lessonFileId))?.documentVersion).toBe(0);
    expect(await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id)).toHaveLength(0);
  });
});
