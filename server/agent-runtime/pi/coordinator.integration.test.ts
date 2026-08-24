import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type { LessonPlan } from "../../domain.js";
import type { DashiGoal } from "../../presentations/dashi-goal.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import { PresentationService } from "../../presentations/service.js";
import { deterministicCapabilityPlan } from "../../agent/capability-router.js";
import { PiLessonAgentCoordinator } from "./coordinator.js";

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
  });
  return { repository, created, faux, coordinator, presentations, calls };
}

describe("Pi production coordinator", () => {
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

  it("applies an ordinary lesson patch only after approval and continues the same Pi branch", async () => {
    const { repository, created, faux, coordinator } = await fixture();
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
    }, () => undefined);
    const [approval] = await repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id);
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
    ))?.revision).toBe(2);
  });

  it("continues the same Pi transcript after an approved Dashi goal", async () => {
    const { repository, created, faux, coordinator, presentations, calls } = await fixture();
    faux.setResponses([
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name).sort()).toEqual([
          "inspect_dashi_layouts",
          "propose_classroom_presentation",
          "query_dashi_layouts",
          "read_document",
        ]);
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
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).not.toContain('"businessOutcome":"succeeded"');
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
    expect(session?.revision).toBe(2);
    expect(JSON.stringify(session?.messages)).toContain('\\"status\\":\\"approval_required\\"');
    expect(JSON.stringify(session?.messages)).toContain('"role":"approval_outcome"');
    expect(JSON.stringify(session?.messages)).toContain("课堂演示已确认并生成。");
    expect(continuationEvents).toContainEqual(expect.objectContaining({ type: "run.completed" }));
  });

  it("persists theme confirmation per branch and does not treat an acknowledgement as generation consent", async () => {
    const { repository, created, faux, coordinator, calls } = await fixture();
    faux.setResponses([
      (context) => {
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).toContain('"completion":"ask_presentation_theme"');
        return fauxAssistantMessage("请选择一个主题编号或名称，也可以说“你来选择”。");
      },
      (context) => {
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).toContain('"completion":"dismiss_presentation_theme"');
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
        expect(context.systemPrompt).toContain('"confirmedTheme":"theme09"');
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
      fauxAssistantMessage("我还在规划版式。"),
      fauxAssistantMessage("仍未完成。"),
      fauxAssistantMessage("第二次提醒后仍未完成。"),
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("inspect_dashi_layouts", {
        layouts: goal.slides.map((slide) => slide.layout.replace("theme01_", "theme09_")),
      }), { stopReason: "toolUse" }),
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toContain("propose_classroom_presentation");
        expect(context.systemPrompt).toContain('"confirmedTheme":"theme09"');
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
    await coordinator.start({ ...input, message: "theme09" }, () => undefined);
    expect((await repository.getBranch(ownerId, created.thread.id, created.branch.id))?.pendingInteraction)
      .toMatchObject({ kind: "presentation_generation", confirmedTheme: "theme09" });

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
    expect((await repository.getAgentRuntimeSession(
      ownerId,
      created.thread.id,
      created.branch.id,
      "pi",
    ))?.revision).toBe(1);
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
      context.systemPrompt?.includes('"completion":"brief_reply_only"')
        && (context.tools?.length ?? 0) === 0
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
      skillIds: [],
      toolGroups: [],
    });
    await expect(repository.listPendingApprovals(ownerId, created.thread.id, created.branch.id))
      .resolves.toHaveLength(0);
    const assistant = await repository.getMessage(ownerId, latest!.assistantMessageId!);
    expect(assistant?.content).toBe("好的，需要时再告诉我。");
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
    ))?.revision).toBe(2);
  });
});
