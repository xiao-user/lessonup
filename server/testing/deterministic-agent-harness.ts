import type {
  AgentApprovalRecord,
  DocumentPatch,
  NormalizedAgentEvent,
  SourceRef,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";

type Emit = (event: NormalizedAgentEvent) => void | Promise<void>;
type StartInput = {
  userId: string;
  threadId: string;
  branchId: string;
  message: string;
  activeSectionId: string;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DeterministicAgentHarness {
  private activeRuns = new Map<string, {
    cancelled: boolean;
    settled: Promise<void>;
    settle: () => void;
  }>();
  private failedMessages = new Set<string>();

  constructor(private readonly repository: LessonRepository) {}

  async cancel(userId: string, runId: string) {
    const run = this.activeRuns.get(`${userId}:${runId}`);
    if (!run) return false;
    run.cancelled = true;
    await run.settled;
    return true;
  }

  async start(input: StartInput, emit: Emit) {
    const thread = await this.repository.getThread(input.userId, input.threadId);
    const branch = await this.repository.getBranch(input.userId, input.threadId, input.branchId);
    if (!thread || !branch) throw new Error("thread_scope_invalid");
    if (thread.status === "running" || thread.status === "awaiting_approval") {
      throw new Error("active_run_exists");
    }
    const file = await this.repository.getLessonFile(input.userId, thread.lessonFileId);
    if (!file || file.notebookId !== thread.notebookId) throw new Error("lesson_scope_invalid");

    const runId = crypto.randomUUID();
    let settle = () => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const control = { cancelled: false, settled, settle };
    this.activeRuns.set(`${input.userId}:${runId}`, control);
    await this.repository.createRun({
      id: runId,
      ownerId: input.userId,
      threadId: thread.id,
      branchId: branch.id,
      model: "deterministic-agent-e2e",
      status: "running",
      capabilityPlan: { skillIds: [], toolGroups: ["document-read"], mcpServers: [], specialistAgents: [] },
      agentDefinitionVersion: "deterministic-agent-e2e@1",
      skillVersions: {},
    });
    await this.repository.updateThread(input.userId, thread.id, {
      status: "running",
      title: thread.title === "新会话" ? input.message.slice(0, 14) : undefined,
    });
    await this.repository.appendMessage({
      ownerId: input.userId, threadId: thread.id, branchId: branch.id,
      role: "user", content: input.message, status: "completed",
    });
    const assistant = await this.repository.appendMessage({
      ownerId: input.userId, threadId: thread.id, branchId: branch.id,
      role: "assistant", content: "", status: "streaming",
    });
    await emit({ type: "run.started", runId, threadId: thread.id, branchId: branch.id });

    try {
      if (input.message.includes("制造失败") && !this.failedMessages.has(`${thread.id}:${input.message}`)) {
        this.failedMessages.add(`${thread.id}:${input.message}`);
        await this.fail(input.userId, runId, thread.id, assistant.id, emit, "deterministic_agent_failure");
        return;
      }

      if (input.message.includes("提交修改")) {
        await this.createApproval({ input, runId, assistantId: assistant.id, file, emit });
        return;
      }

      await wait(600);
      if (control.cancelled) {
        await this.cancelled(input.userId, runId, thread.id, assistant.id, "", emit);
        return;
      }
      const toolCallId = crypto.randomUUID();
      await emit({
        type: "tool.started", runId, toolCallId,
        name: "read_section", label: "读取教学目标", groupKey: "document-read",
      });
      await wait(80);
      await emit({
        type: "tool.completed", runId, toolCallId,
        name: "read_section", ok: true, label: "读取教学目标", groupKey: "document-read",
      });
      const source: SourceRef = {
        id: `e2e-source-${runId}`,
        title: "LessonUp 确定性测试资料",
        url: "https://example.com/lessonup-e2e",
        kind: "public",
      };
      await emit({ type: "source.added", runId, source });

      const cancelling = input.message.includes("等待取消");
      const chunks = cancelling
        ? ["正在生成可取消的内容。", "这段内容不应在取消后继续。"]
        : ["### 确定性回复\n\n", "- 已读取当前教案栏目。\n- 已生成结构化建议。"];
      let content = "";
      for (const chunk of chunks) {
        for (let elapsed = 0; elapsed < (cancelling ? 1_200 : 360); elapsed += 40) {
          if (control.cancelled) {
            await this.cancelled(input.userId, runId, thread.id, assistant.id, content, emit);
            return;
          }
          await wait(40);
        }
        content += chunk;
        await emit({ type: "message.delta", runId, delta: chunk });
      }
      const message = await this.repository.updateMessage(input.userId, assistant.id, {
        content, status: "completed", sources: [source],
      });
      await this.repository.updateRun(input.userId, runId, {
        status: "completed", completedAt: new Date().toISOString(),
      });
      await this.repository.updateThread(input.userId, thread.id, { status: "idle" });
      await emit({ type: "message.completed", runId, message });
      await emit({ type: "run.completed", runId });
    } finally {
      control.settle();
      this.activeRuns.delete(`${input.userId}:${runId}`);
    }
  }

  async resumeApproval(args: {
    userId: string;
    approvalId: string;
    approved: boolean;
    idempotencyKey: string;
    emit: Emit;
  }) {
    const approval = await this.repository.getApproval(args.userId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (args.approved) {
      await this.repository.applyApprovedPatch({
        ownerId: args.userId,
        approvalId: approval.id,
        idempotencyKey: `approval:${approval.id}`,
      });
    } else {
      await this.repository.resolveApproval(args.userId, approval.id, "rejected");
    }
    await this.repository.updateRun(args.userId, approval.runId, { status: "running" });
    await this.repository.updateThread(args.userId, approval.threadId, { status: "running" });
    const assistant = await this.repository.appendMessage({
      ownerId: args.userId, threadId: approval.threadId, branchId: approval.branchId,
      role: "assistant", content: "", status: "streaming",
    });
    await args.emit({
      type: "run.started", runId: approval.runId,
      threadId: approval.threadId, branchId: approval.branchId,
    });
    const content = args.approved ? "修改已按确认写入教案。" : "已保留教案原文。";
    const message = await this.repository.updateMessage(args.userId, assistant.id, {
      content, status: "completed",
    });
    await this.repository.updateRun(args.userId, approval.runId, {
      status: "completed", completedAt: new Date().toISOString(),
    });
    await this.repository.updateThread(args.userId, approval.threadId, { status: "idle" });
    await args.emit({ type: "message.completed", runId: approval.runId, message });
    await args.emit({ type: "run.completed", runId: approval.runId });
    return args.approved
      ? this.repository.getLessonFile(args.userId, approval.patch.fileId)
      : null;
  }

  private async createApproval(args: {
    input: StartInput;
    runId: string;
    assistantId: string;
    file: NonNullable<Awaited<ReturnType<LessonRepository["getLessonFile"]>>>;
    emit: Emit;
  }) {
    const expectedText = args.file.document.objectives.split("\n")[0];
    const replacement = "1. 能从文本证据中解释春日意象的形成。";
    const patch: DocumentPatch = {
      fileId: args.file.id,
      baseDocumentVersion: args.file.documentVersion,
      summary: "替换教学目标第一条",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: expectedText.length,
        expectedText,
        replacement,
      }],
    };
    const approval: AgentApprovalRecord = {
      id: crypto.randomUUID(),
      ownerId: args.input.userId,
      runId: args.runId,
      threadId: args.input.threadId,
      branchId: args.input.branchId,
      state: "pending",
      patch,
      encryptedRunState: "deterministic-e2e-state",
      agentDefinitionVersion: "deterministic-agent-e2e@1",
      documentVersion: args.file.documentVersion,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await this.repository.saveApproval(approval);
    const message = await this.repository.updateMessage(args.input.userId, args.assistantId, {
      content: "已准备一项教案修改，请确认。", status: "completed",
    });
    await this.repository.updateRun(args.input.userId, args.runId, { status: "awaiting_approval" });
    await this.repository.updateThread(args.input.userId, args.input.threadId, { status: "awaiting_approval" });
    await args.emit({ type: "message.completed", runId: args.runId, message });
    await args.emit({ type: "approval.required", runId: args.runId, approvalId: approval.id, patch });
  }

  private async fail(
    userId: string,
    runId: string,
    threadId: string,
    assistantId: string,
    emit: Emit,
    error: string,
  ) {
    await this.repository.updateRun(userId, runId, {
      status: "failed", error, completedAt: new Date().toISOString(),
    });
    await this.repository.updateThread(userId, threadId, { status: "failed" });
    await this.repository.updateMessage(userId, assistantId, { content: "", status: "failed" });
    await emit({ type: "run.failed", runId, error });
  }

  private async cancelled(
    userId: string,
    runId: string,
    threadId: string,
    assistantId: string,
    content: string,
    emit: Emit,
  ) {
    await this.repository.updateRun(userId, runId, {
      status: "cancelled", completedAt: new Date().toISOString(),
    });
    await this.repository.updateThread(userId, threadId, { status: "idle" });
    await this.repository.updateMessage(userId, assistantId, { content, status: "completed" });
    await emit({ type: "run.cancelled", runId });
  }
}
