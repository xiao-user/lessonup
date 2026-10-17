import type {
  AgentApprovalRecord,
  DocumentPatch,
  NormalizedAgentEvent,
  SourceRef,
} from "../domain.js";
import { isSemesterFrameworkPatch } from "../domain.js";
import { materializeDesignBasisProjection } from "../design-basis-projection.js";
import { materializeLessonDesignChange } from "../lesson-design-change.js";
import type { LessonRepository } from "../repository.js";

type Emit = (event: NormalizedAgentEvent) => void | Promise<void>;
type StartInput = {
  userId: string;
  threadId: string;
  branchId: string;
  message: string;
  activeSectionId: string;
  documentVersion: number;
  attachmentIds: string[];
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
    if (thread.resourceType !== "lesson_file") throw new Error("agent_resource_not_supported");
    if (thread.status === "running" || thread.status === "awaiting_approval") {
      throw new Error("active_run_exists");
    }
    const file = await this.repository.getLessonFile(input.userId, thread.lessonFileId);
    if (!file || file.notebookId !== thread.notebookId) throw new Error("lesson_scope_invalid");
    if (file.documentVersion !== input.documentVersion) throw new Error("document_context_stale");

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
      capabilityPlan: {
        skillIds: [],
        toolGroups: ["document-read"],
        mcpServers: [],
        evidenceRequired: false,
      },
      agentDefinitionVersion: "deterministic-agent-e2e@1",
      skillVersions: {},
    });
    await this.repository.updateThread(input.userId, thread.id, {
      status: "running",
      ...(thread.title === "新会话" ? { title: input.message.slice(0, 14) } : {}),
    });
    const userMessage = await this.repository.appendMessage({
      ownerId: input.userId, threadId: thread.id, branchId: branch.id,
      role: "user", content: input.message, status: "completed",
    });
    const attachments = await this.repository.attachKnowledgeSources(
      input.userId,
      thread.lessonFileId,
      userMessage.id,
      input.attachmentIds,
    );
    if (attachments.length) {
      await this.repository.updateMessage(input.userId, userMessage.id, { sources: attachments });
    }
    const assistant = await this.repository.appendMessage({
      ownerId: input.userId, threadId: thread.id, branchId: branch.id,
      role: "assistant", content: "", status: "streaming",
    });
    await emit({ type: "run.started", runId, threadId: thread.id, branchId: branch.id });

    try {
      if (input.message.includes("制造失败") && !this.failedMessages.has(`${thread.id}:${input.message}`)) {
        this.failedMessages.add(`${thread.id}:${input.message}`);
        const interruptedDraft = "已完成问题定位，但后续校验未通过。";
        await emit({ type: "message.delta", runId, delta: interruptedDraft });
        await this.fail(
          input.userId,
          runId,
          thread.id,
          assistant.id,
          interruptedDraft,
          emit,
          "agent_run_failed",
        );
        return;
      }

      if (input.message.includes("请求主题选择")) {
        await this.repository.updateBranch(input.userId, thread.id, branch.id, {
          pendingInteraction: {
            kind: "presentation_theme",
            originalRequest: "请生成课堂演示",
            documentVersion: file.documentVersion,
            requestedAt: new Date().toISOString(),
          },
        });
        const content = "请选择一个演示主题。";
        const message = await this.repository.updateMessage(input.userId, assistant.id, {
          content,
          status: "completed",
        });
        await this.repository.updateRun(input.userId, runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        await this.repository.updateThread(input.userId, thread.id, { status: "idle" });
        await emit({ type: "message.delta", runId, delta: content });
        await emit({ type: "message.completed", runId, message });
        await emit({ type: "run.completed", runId });
        return;
      }

      if (branch.pendingInteraction?.kind === "presentation_theme") {
        await this.repository.updateBranch(input.userId, thread.id, branch.id, {
          pendingInteraction: null,
        });
        const content = `已接收主题 ${input.message}，并进入下一步。`;
        const message = await this.repository.updateMessage(input.userId, assistant.id, {
          content,
          status: "completed",
        });
        await this.repository.updateRun(input.userId, runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        await this.repository.updateThread(input.userId, thread.id, { status: "idle" });
        await emit({ type: "message.delta", runId, delta: content });
        await emit({ type: "message.completed", runId, message });
        await emit({ type: "run.completed", runId });
        return;
      }

      if (
        input.message.includes("提交修改")
        || input.message.includes("完整备课调整")
        || input.message.includes("设计依据投影")
      ) {
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
    runId: string;
    approvalId: string;
    approved: boolean;
    idempotencyKey: string;
    emit: Emit;
  }) {
    let approval = await this.repository.getApproval(args.userId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.runId !== args.runId) throw new Error("run_scope_invalid");
    if (isSemesterFrameworkPatch(approval.patch)) {
      throw new Error("agent_resource_not_supported");
    }
    const approvalPatch = approval.patch;
    const desiredState = args.approved ? "approved" : "rejected";
    if (approval.state !== "pending" && approval.state !== desiredState) {
      throw new Error("approval_already_resolved");
    }
    if ((await this.repository.getRun(args.userId, approval.runId))?.status === "completed") {
      const decision = await this.repository.decideApproval({ ownerId: args.userId, approvalId: approval.id,
        approved: args.approved, encryptedRunState: "e2e-decision", completeWithoutContinuation: true });
      if (decision.file) await args.emit({ type: "document.updated", runId: approval.runId, file: decision.file });
      await args.emit({ type: "approval.settled", runId: approval.runId, approvalId: approval.id, decision: desiredState });
      return decision.file;
    }
    const wasPending = approval.state === "pending";
    const leaseToken = `e2e:${args.approvalId}:${args.idempotencyKey}`;
    let continuationClaimed = false;
    try {
      if (approval.state === "pending") {
        const decision = await this.repository.decideApproval({
          ownerId: args.userId,
          approvalId: approval.id,
          approved: args.approved,
          encryptedRunState: "deterministic-e2e-after-decision",
        });
        approval = decision.approval;
        await args.emit({
          type: "approval.decided",
          runId: approval.runId,
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
        });
        if (decision.file) {
          await args.emit({
            type: "document.updated",
            runId: approval.runId,
            file: decision.file,
          });
        }
        if (decision.basis) {
          await args.emit({
            type: "design_basis.updated",
            runId: approval.runId,
            basis: decision.basis,
          });
        }
      } else {
        await args.emit({
          type: "approval.decided",
          runId: approval.runId,
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
        });
      }
      approval = await this.repository.claimApprovalContinuation({
        ownerId: args.userId,
        approvalId: approval.id,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (approval.continuationStatus === "completed") {
        const file = args.approved
          ? await this.repository.getLessonFile(args.userId, approvalPatch.fileId)
          : null;
        await args.emit({
          type: "run.started", runId: approval.runId,
          threadId: approval.threadId, branchId: approval.branchId,
        });
        await args.emit({
          type: "approval.decided",
          runId: approval.runId,
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
        });
        if (file) {
          await args.emit({ type: "document.updated", runId: approval.runId, file });
        }
        await args.emit({ type: "run.completed", runId: approval.runId });
        return file;
      }
      continuationClaimed = true;
      await this.repository.updateRun(args.userId, approval.runId, { status: "running" });
      await this.repository.updateThread(args.userId, approval.threadId, { status: "running" });
      const assistant = await this.repository.getMessage(
        args.userId,
        approval.continuationMessageId!,
      ) ?? await this.repository.appendMessage({
        id: approval.continuationMessageId,
        ownerId: args.userId,
        threadId: approval.threadId,
        branchId: approval.branchId,
        role: "assistant",
        content: "",
        status: "streaming",
      });
      await this.repository.updateMessage(args.userId, assistant.id, {
        content: "",
        status: "streaming",
        sources: [],
      });
      await args.emit({
        type: "run.started", runId: approval.runId,
        threadId: approval.threadId, branchId: approval.branchId,
      });
      if (
        approval.patch.summary.includes("续跑恢复")
        && approval.continuationAttemptCount === 1
      ) {
        throw new Error("agent_run_failed");
      }
      const content = args.approved ? "修改已按确认写入教案。" : "已保留教案原文。";
      const message = await this.repository.updateMessage(args.userId, assistant.id, {
        content, status: "completed",
      });
      await this.repository.updateRun(args.userId, approval.runId, {
        status: "completed", completedAt: new Date().toISOString(),
      });
      await this.repository.updateThread(args.userId, approval.threadId, { status: "idle" });
      await this.repository.finishApprovalContinuation({
        ownerId: args.userId,
        approvalId: approval.id,
        leaseToken,
        status: "completed",
      });
      await args.emit({ type: "message.completed", runId: approval.runId, message });
      await args.emit({ type: "run.completed", runId: approval.runId });
      return args.approved
        ? this.repository.getLessonFile(args.userId, approvalPatch.fileId)
        : null;
    } catch (error) {
      const current = await this.repository.getApproval(args.userId, approval.id);
      if (wasPending && current?.state === "pending") {
        await this.repository.resolveApproval(args.userId, approval.id, "expired");
      }
      if (continuationClaimed) {
        await this.repository.finishApprovalContinuation({
          ownerId: args.userId,
          approvalId: approval.id,
          leaseToken,
          status: "ready",
          error: "agent_run_failed",
        }).catch(() => undefined);
        await this.repository.updateRun(args.userId, approval.runId, {
          status: "failed", completedAt: new Date().toISOString(),
        });
        await this.repository.updateThread(args.userId, approval.threadId, { status: "idle" });
      }
      throw error;
    }
  }

  private async createApproval(args: {
    input: StartInput;
    runId: string;
    assistantId: string;
    file: NonNullable<Awaited<ReturnType<LessonRepository["getLessonFile"]>>>;
    emit: Emit;
  }) {
    if (args.input.message.includes("长教案流式提交修改")) {
      const expectedText = args.file.document.process;
      return this.persistApproval({ ...args, patch: {
        fileId: args.file.id, baseDocumentVersion: args.file.documentVersion, summary: "长教案流式性能验收",
        operations: [{ op: "replace_text", field: "process", start: 0, end: expectedText.length, expectedText,
          replacement: `${expectedText}\n\n## 独立迁移检查\n学生用新材料独立解释，教师依据同一判据记录证据与待检查的问题。` }],
      } });
    }
    if (args.input.message.includes("完整备课调整")) {
      const basis = await this.repository.getLessonDesignBasis(
        args.input.userId,
        args.file.id,
      );
      if (!basis) throw new Error("lesson_design_basis_not_found");
      const expectedText = args.file.document.assessment;
      const patch = materializeLessonDesignChange({
        aggregate: basis,
        file: args.file,
        proposal: {
          summary: "补充学生困难并落实到评价练习",
          designBasisOperations: [{
            op: "create_design_basis_entry",
            referenceKey: "student-evidence-gap",
            kind: "student_difficulty",
            semanticEntityId: null,
            relatedSemanticEntityId: null,
            relatedCurriculumNodeId: null,
            statement: "学生可能只给出结论，不能说明判断依据。",
            rationale: "评价任务需要观察学生能否用证据解释。",
            evidenceSourceIds: [],
            decision: "accepted",
          }],
          documentOperations: [{
            field: "assessment",
            replacement: `${expectedText}\n要求学生说明判断所依据的文本证据。`,
            basisEntryIds: [],
            createdBasisEntryRefs: ["student-evidence-gap"],
            usesLearnerContext: false,
          }],
        },
      });
      return this.persistApproval({ ...args, patch });
    }
    if (args.input.message.includes("设计依据投影")) {
      const basis = await this.repository.getLessonDesignBasis(
        args.input.userId,
        args.file.id,
      );
      const entry = basis?.entries.find((candidate) => (
        candidate.decision === "accepted" && candidate.teacherConfirmed
      ));
      if (!basis || !entry) throw new Error("lesson_design_basis_not_found");
      const expectedText = args.file.document.assessment;
      const patch = materializeDesignBasisProjection({
        aggregate: basis,
        file: args.file,
        proposal: {
          summary: "把已确认的学生困难落实到评价练习",
          operations: [{
            field: "assessment",
            replacement: `${expectedText}\n要求学生说明判断所依据的文本证据。`,
            basisEntryIds: [entry.id],
            usesLearnerContext: false,
          }],
        },
      });
      return this.persistApproval({ ...args, patch });
    }
    const expectedText = args.file.document.objectives.split("\n")[0];
    const replacement = "1. 能从文本证据中解释春日意象的形成。";
    const patch: DocumentPatch = {
      fileId: args.file.id,
      baseDocumentVersion: args.file.documentVersion,
      summary: args.input.message.includes("续跑恢复")
        ? "替换教学目标第一条并验证续跑恢复"
        : "替换教学目标第一条",
      operations: [{
        op: "replace_text",
        field: "objectives",
        start: 0,
        end: expectedText.length,
        expectedText,
        replacement,
      }],
    };
    return this.persistApproval({ ...args, patch });
  }

  private async persistApproval(args: {
    input: StartInput;
    runId: string;
    assistantId: string;
    patch: DocumentPatch;
    emit: Emit;
  }) {
    const file = await this.repository.getLessonFile(args.input.userId, args.patch.fileId);
    const fields: Partial<Record<keyof NonNullable<typeof file>["document"], string>> = {};
    // Deterministic transport fixture only; native Pi streaming is covered by
    // coordinator.integration.test.ts, not inferred from these browser events.
    for (const operation of args.patch.operations) {
      const original = file!.document[operation.field];
      const full = original.slice(0, operation.start) + operation.replacement + original.slice(operation.end);
      const step = args.input.message.includes("长教案流式提交修改") ? 240 : 6;
      for (let length = step; length < full.length + step; length += step) {
        if (this.activeRuns.get(`${args.input.userId}:${args.runId}`)?.cancelled) {
          await this.cancelled(args.input.userId, args.runId, args.input.threadId, args.assistantId, "", args.emit);
          return;
        }
        fields[operation.field] = full.slice(0, length);
        await args.emit({ type: "document.draft", runId: args.runId, toolCallId: `draft:${args.runId}`,
          fileId: args.patch.fileId, baseDocumentVersion: args.patch.baseDocumentVersion, fields: { ...fields } });
        await wait(35);
      }
    }
    const approval: AgentApprovalRecord = {
      id: crypto.randomUUID(),
      ownerId: args.input.userId,
      runId: args.runId,
      threadId: args.input.threadId,
      branchId: args.input.branchId,
      assistantMessageId: args.assistantId,
      toolCallId: `draft:${args.runId}`,
      state: "pending",
      patch: args.patch,
      encryptedRunState: "deterministic-e2e-state",
      agentDefinitionVersion: "deterministic-agent-e2e@1",
      resourceType: "lesson_file",
      patchKind: "document",
      lessonFileId: args.patch.fileId,
      baseResourceVersion: args.patch.baseDocumentVersion,
      documentVersion: args.patch.baseDocumentVersion,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await this.repository.saveApproval(approval);
    const message = await this.repository.updateMessage(args.input.userId, args.assistantId, {
      content: "已准备一项教案修改，请确认。", status: "completed",
    });
    await this.repository.updateRun(args.input.userId, args.runId, { status: "completed" });
    await this.repository.updateThread(args.input.userId, args.input.threadId, { status: "idle" });
    await args.emit({ type: "message.completed", runId: args.runId, message });
    await args.emit({
      type: "approval.required",
      runId: args.runId,
      approvalId: approval.id,
      assistantMessageId: args.assistantId,
      toolCallId: approval.toolCallId,
      patch: args.patch,
    });
    await args.emit({ type: "run.completed", runId: args.runId });
  }

  private async fail(
    userId: string,
    runId: string,
    threadId: string,
    assistantId: string,
    content: string,
    emit: Emit,
    error: string,
  ) {
    await this.repository.updateRun(userId, runId, {
      status: "failed", error, completedAt: new Date().toISOString(),
    });
    await this.repository.updateThread(userId, threadId, { status: "idle" });
    const message = await this.repository.updateMessage(userId, assistantId, {
      content,
      status: "failed",
      error,
    });
    await emit({ type: "run.failed", runId, error, message });
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
    await this.repository.updateMessage(userId, assistantId, { content, status: "cancelled" });
    await emit({ type: "run.cancelled", runId });
  }
}
