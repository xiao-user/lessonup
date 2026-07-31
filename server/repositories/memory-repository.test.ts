import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "./memory-repository.js";
import type { LessonPlan } from "../domain.js";

const document: LessonPlan = {
  unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标",
  focus: "重点", preparation: "准备", process: "过程", assessment: "评价",
  homework: "作业", board: "板书", reflection: "反思",
};

const importFor = (repository: MemoryLessonRepository, ownerId: string) => repository.importNotebookGraph(ownerId, [{
  id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
  files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
}]);

describe("memory repository isolation", () => {
  it("never returns another owner's file even when client ids collide", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    expect(await repository.getLessonFile("user-b", "f1")).toBeNull();
  });

  it("keeps thread branches independent and preserves the original branch", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", { notebookId: "n1", lessonFileId: "f1" });
    const message = await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: branch.id,
      role: "user", content: "原问题", status: "completed", sessionCursor: 4,
    });
    await repository.addSessionItems("user-a", thread.id, branch.id, [
      { type: "message", role: "user", content: "先前问题" } as any,
      { type: "function_call", callId: "earlier-call", name: "read_section", arguments: "{}" } as any,
      { type: "function_call_result", callId: "earlier-call", output: "earlier" } as any,
      { type: "message", role: "user", content: "原问题" } as any,
      { type: "function_call", callId: "later-call", name: "read_section", arguments: "{}" } as any,
      { type: "function_call_result", callId: "later-call", output: "later" } as any,
    ]);
    await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: branch.id,
      role: "assistant", content: "分叉点后的回复", status: "completed",
    });
    const fork = await repository.createBranch("user-a", thread.id, branch.id, message.id);
    await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: fork.id,
      role: "user", content: "分支问题", status: "completed",
    });
    expect((await repository.listMessages("user-a", thread.id, branch.id)).map((item) => item.content))
      .toEqual(["原问题", "分叉点后的回复"]);
    expect((await repository.listMessages("user-a", thread.id, fork.id)).map((item) => item.content)).toEqual(["原问题", "分支问题"]);
    expect(await repository.getSessionItems("user-a", thread.id, fork.id)).toEqual([
      { type: "message", role: "user", content: "先前问题" },
      { type: "function_call", callId: "earlier-call", name: "read_section", arguments: "{}" },
      { type: "function_call_result", callId: "earlier-call", output: "earlier" },
      { type: "message", role: "user", content: "原问题" },
    ]);
  });

  it("forks a completed assistant response at its protocol-safe session cursor", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1", lessonFileId: "f1",
    });
    await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: branch.id,
      role: "user", content: "检查目标", status: "completed", sessionCursor: 1,
    });
    const assistant = await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: branch.id,
      role: "assistant", content: "建议补充评价判据", status: "completed", sessionCursor: 4,
    });
    const protocolHistory = [
      { type: "message", role: "user", content: "检查目标" },
      { type: "function_call", callId: "read-1", name: "read_document", arguments: "{}" },
      { type: "function_call_result", callId: "read-1", output: "目标" },
      { type: "message", role: "assistant", content: "建议补充评价判据" },
    ] as any[];
    await repository.addSessionItems("user-a", thread.id, branch.id, protocolHistory);

    const fork = await repository.createBranch("user-a", thread.id, branch.id, assistant.id);

    expect(await repository.getSessionItems("user-a", thread.id, fork.id)).toEqual(protocolHistory);
    expect((await repository.listMessages("user-a", thread.id, fork.id)).map((item) => item.content))
      .toEqual(["检查目标", "建议补充评价判据"]);
  });

  it("rejects a branch until the fork message is committed to the SDK session", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    const message = await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: branch.id,
      role: "user", content: "尚未提交", status: "completed", sessionCursor: 1,
    });

    await expect(repository.createBranch(
      "user-a", thread.id, branch.id, message.id,
    )).rejects.toThrow("fork_session_not_committed");
    expect(await repository.listBranches("user-a", thread.id)).toHaveLength(1);
  });

  it("rejects a fork message outside the declared parent branch", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const first = await repository.createThread("user-a", { notebookId: "n1", lessonFileId: "f1" });
    const second = await repository.createThread("user-a", { notebookId: "n1", lessonFileId: "f1" });
    const foreignMessage = await repository.appendMessage({
      ownerId: "user-a", threadId: second.thread.id, branchId: second.branch.id,
      role: "user", content: "其他会话", status: "completed",
    });

    await expect(repository.createBranch(
      "user-a", first.thread.id, first.branch.id, foreignMessage.id,
    )).rejects.toThrow("fork_message_scope_invalid");
  });

  it("makes identical document writes idempotent and rejects key reuse with another payload", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const first = await repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document: { ...document, topic: "新课题" }, pageCount: 1,
      source: "manual", idempotencyKey: "write-1",
    });
    const replay = await repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document: { ...document, topic: "新课题" }, pageCount: 1,
      source: "manual", idempotencyKey: "write-1",
    });
    expect(replay.document.topic).toBe("新课题");
    expect(replay.documentVersion).toBe(first.documentVersion);
    await expect(repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document: { ...document, topic: "冲突内容" }, pageCount: 1,
      source: "manual", idempotencyKey: "write-1",
    })).rejects.toThrow("idempotency_conflict");
    await expect(repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document, pageCount: 1, source: "manual", idempotencyKey: "write-2",
    })).rejects.toThrow(/最新版本/);
  });

  it("rehydrates an ephemeral repository at the browser's confirmed document version", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph("user-a", [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", pages: 2, documentVersion: 7, lessonPlan: document }],
    }]);
    expect((await repository.getLessonFile("user-a", "f1"))?.documentVersion).toBe(7);
  });

  it("updates measured page metadata without creating a new document version", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");

    const updated = await repository.updateLessonPageCount({
      ownerId: "user-a",
      fileId: "f1",
      documentVersion: 0,
      pageCount: 3,
    });

    expect(updated).toMatchObject({ pageCount: 3, documentVersion: 0 });
    await expect(repository.updateLessonPageCount({
      ownerId: "user-a",
      fileId: "f1",
      documentVersion: 1,
      pageCount: 4,
    })).rejects.toThrow(/版本已经变化/);
  });

  it("isolates compressed memory by thread and branch", async () => {
    const repository = new MemoryLessonRepository();
    await repository.saveThreadMemory("user-a", "thread-a", "branch-a", "摘要 A", 24);
    await repository.saveThreadMemory("user-a", "thread-a", "branch-b", "摘要 B", 30);
    expect(await repository.getThreadMemory("user-a", "thread-a", "branch-a"))
      .toEqual({ summary: "摘要 A", cursor: 24 });
    expect(await repository.getThreadMemory("user-a", "thread-a", "branch-b"))
      .toEqual({ summary: "摘要 B", cursor: 30 });
    expect(await repository.getThreadMemory("user-b", "thread-a", "branch-a")).toBeNull();
  });

  it("deduplicates replayed session batches and rejects key reuse with another payload", async () => {
    const repository = new MemoryLessonRepository();
    const first = [{ type: "message", role: "user", content: "一次" }] as any;
    await repository.addSessionItems("user-a", "thread-a", "branch-a", first, "run:one:0");
    await repository.addSessionItems("user-a", "thread-a", "branch-a", first, "run:one:0");

    expect(await repository.getSessionItems("user-a", "thread-a", "branch-a")).toEqual(first);
    await expect(repository.addSessionItems(
      "user-a",
      "thread-a",
      "branch-a",
      [{ type: "message", role: "user", content: "另一次" }] as any,
      "run:one:0",
    )).rejects.toThrow("idempotency_conflict");
  });

  it("atomically replaces a corrupted session and clears stale append state", async () => {
    const repository = new MemoryLessonRepository();
    const unsafe = [
      { type: "message", role: "user", content: "保留" },
      { type: "function_call", callId: "orphan", name: "read_section", arguments: "{}" },
    ] as any;
    const repaired = [{ type: "message", role: "user", content: "保留" }] as any;
    await repository.addSessionItems(
      "user-a", "thread-a", "branch-a", unsafe, "run:cancelled:0",
    );

    await repository.replaceSessionItems("user-a", "thread-a", "branch-a", repaired);
    await repository.addSessionItems(
      "user-a", "thread-a", "branch-a", repaired, "run:cancelled:0",
    );

    expect(await repository.getSessionItems("user-a", "thread-a", "branch-a"))
      .toEqual([...repaired, ...repaired]);
  });

  it("restores pending approvals and applies an approved patch only once", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", { notebookId: "n1", lessonFileId: "f1" });
    await repository.saveApproval({
      id: "approval-1", ownerId: "user-a", runId: "run-1", threadId: thread.id, branchId: branch.id,
      assistantMessageId: "assistant-1",
      state: "pending", encryptedRunState: "encrypted", agentDefinitionVersion: "1", documentVersion: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
      patch: {
        fileId: "f1", baseDocumentVersion: 0, summary: "改写目标",
        operations: [{
          op: "replace_text", field: "objectives", start: 0, end: 2,
          expectedText: "目标", replacement: "可评价目标",
        }],
      },
    });
    expect(await repository.listPendingApprovals("user-a", thread.id, branch.id)).toHaveLength(1);
    expect(await repository.listPendingApprovals("user-b", thread.id, branch.id)).toHaveLength(0);

    const applied = await repository.applyApprovedPatch({
      ownerId: "user-a", approvalId: "approval-1", idempotencyKey: "approval:approval-1",
    });
    const replay = await repository.applyApprovedPatch({
      ownerId: "user-a", approvalId: "approval-1", idempotencyKey: "approval:approval-1",
    });
    expect(applied.document.objectives).toBe("可评价目标");
    expect(replay.documentVersion).toBe(1);
    expect(await repository.listPendingApprovals("user-a", thread.id, branch.id)).toHaveLength(0);
    expect(await repository.listApprovals("user-a", thread.id, branch.id)).toEqual([
      expect.objectContaining({
        id: "approval-1",
        assistantMessageId: "assistant-1",
        state: "approved",
      }),
    ]);
    expect(await repository.listApprovals("user-b", thread.id, branch.id)).toEqual([]);
  });

  it("persists an approval decision separately from its retryable continuation lease", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    await repository.saveApproval({
      id: "approval-recovery",
      ownerId: "user-a",
      runId: "run-recovery",
      threadId: thread.id,
      branchId: branch.id,
      state: "pending",
      encryptedRunState: "before-decision",
      agentDefinitionVersion: "1",
      documentVersion: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      patch: {
        fileId: "f1",
        baseDocumentVersion: 0,
        summary: "改写目标",
        operations: [{
          op: "replace_text",
          field: "objectives",
          start: 0,
          end: 2,
          expectedText: "目标",
          replacement: "可评价目标",
        }],
      },
    });

    const decision = await repository.decideApproval({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      approved: true,
      encryptedRunState: "after-decision",
    });
    expect(decision.file?.documentVersion).toBe(1);
    expect(decision.approval).toMatchObject({
      state: "approved",
      encryptedRunState: "after-decision",
      continuationStatus: "ready",
    });

    const firstLease = await repository.claimApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(firstLease.continuationMessageId).toBeTruthy();
    await expect(repository.claimApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).rejects.toThrow("active_run_exists");

    await repository.finishApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      leaseToken: "lease-1",
      status: "ready",
      error: "provider_unavailable",
    });
    const retryLease = await repository.claimApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      leaseToken: "lease-2",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(retryLease.continuationMessageId).toBe(firstLease.continuationMessageId);
    await repository.finishApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      leaseToken: "lease-2",
      status: "completed",
    });

    const replay = await repository.decideApproval({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      approved: true,
      encryptedRunState: "after-decision",
    });
    expect(replay.file?.documentVersion).toBe(1);
    expect(replay.approval.continuationStatus).toBe("completed");
    await expect(repository.decideApproval({
      ownerId: "user-a",
      approvalId: "approval-recovery",
      approved: false,
      encryptedRunState: "opposite-decision",
    })).rejects.toThrow("approval_already_resolved");
  });

  it("atomically settles approval continuation and never downgrades a completed replay", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    const assistant = await repository.appendMessage({
      id: "continuation-message",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      role: "assistant",
      content: "",
      status: "streaming",
    });
    await repository.createRun({
      id: "run-settle",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "running",
    });
    await repository.updateThread("user-a", thread.id, { status: "running" });
    await repository.saveApproval({
      id: "approval-settle",
      ownerId: "user-a",
      runId: "run-settle",
      threadId: thread.id,
      branchId: branch.id,
      assistantMessageId: "proposal-message",
      continuationMessageId: assistant.id,
      state: "approved",
      encryptedRunState: "approved-state",
      agentDefinitionVersion: "1",
      documentVersion: 0,
      continuationStatus: "ready",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      patch: {
        fileId: "f1",
        baseDocumentVersion: 0,
        summary: "已审批修改",
        operations: [{
          op: "replace_text",
          field: "objectives",
          start: 0,
          end: 2,
          expectedText: "目标",
          replacement: "可评价目标",
        }],
      },
    });
    await repository.claimApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-settle",
      leaseToken: "lease-settle",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await repository.settleApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-settle",
      leaseToken: "lease-settle",
      outcome: "completed",
      assistantMessageId: assistant.id,
      content: "后续回复完成",
      sessionCursor: 4,
      tokenUsage: { totalTokens: 12 },
      encryptedRunState: "completed-state",
    });
    await repository.settleApprovalContinuation({
      ownerId: "user-a",
      approvalId: "approval-settle",
      leaseToken: "lease-settle",
      outcome: "ready",
      assistantMessageId: assistant.id,
      error: "late_failure",
    });

    expect(await repository.getApproval("user-a", "approval-settle"))
      .toMatchObject({ continuationStatus: "completed", encryptedRunState: "completed-state" });
    expect(await repository.getRun("user-a", "run-settle"))
      .toMatchObject({ status: "completed", tokenUsage: { totalTokens: 12 } });
    expect(await repository.getThread("user-a", thread.id))
      .toMatchObject({ status: "idle" });
    expect(await repository.getMessage("user-a", assistant.id))
      .toMatchObject({ status: "completed", content: "后续回复完成", sessionCursor: 4 });
  });

  it("expires the approval, run and thread as one recoverable lifecycle", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    await repository.createRun({
      id: "run-expired",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "awaiting_approval",
    });
    await repository.updateThread("user-a", thread.id, { status: "awaiting_approval" });
    await repository.saveApproval({
      id: "approval-expired",
      ownerId: "user-a",
      runId: "run-expired",
      threadId: thread.id,
      branchId: branch.id,
      state: "pending",
      encryptedRunState: "encrypted",
      agentDefinitionVersion: "1",
      documentVersion: 0,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date().toISOString(),
      patch: {
        fileId: "f1",
        baseDocumentVersion: 0,
        summary: "过期修改",
        operations: [{
          op: "replace_text",
          field: "objectives",
          start: 0,
          end: 2,
          expectedText: "目标",
          replacement: "新目标",
        }],
      },
    });

    await repository.expireApprovalLifecycle("user-a", "approval-expired");

    expect(await repository.getApproval("user-a", "approval-expired"))
      .toMatchObject({ state: "expired", continuationError: "approval_expired" });
    expect(await repository.getRun("user-a", "run-expired"))
      .toMatchObject({ status: "failed", error: "approval_expired" });
    expect(await repository.getThread("user-a", thread.id))
      .toMatchObject({ status: "failed" });
  });

  it("recovers an expired ordinary run and explains the failed assistant turn", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    const assistant = await repository.appendMessage({
      id: "assistant-expired-run",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      role: "assistant",
      content: "",
      status: "streaming",
    });
    await repository.createRun({
      id: "ordinary-expired-run",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "running",
      assistantMessageId: assistant.id,
      leaseToken: "expired-lease",
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await repository.updateThread("user-a", thread.id, { status: "running" });

    await expect(repository.recoverExpiredRuns("user-a", thread.id)).resolves.toBe(1);
    expect(await repository.getRun("user-a", "ordinary-expired-run")).toMatchObject({
      status: "failed",
      error: "run_interrupted",
    });
    expect(await repository.getMessage("user-a", assistant.id)).toMatchObject({
      status: "failed",
      error: "run_interrupted",
    });
    expect(await repository.getThread("user-a", thread.id)).toMatchObject({
      status: "failed",
    });
  });

  it("fences stale workers after a persisted cancellation request", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    await repository.createRun({
      id: "ordinary-cancel-run",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "running",
      leaseToken: "live-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await repository.requestRunCancellation("user-a", "ordinary-cancel-run");
    await expect(repository.settleRun({
      ownerId: "user-a",
      runId: "ordinary-cancel-run",
      leaseToken: "live-lease",
      status: "completed",
    })).rejects.toThrow("run_cancel_requested");
    await expect(repository.settleRun({
      ownerId: "user-a",
      runId: "ordinary-cancel-run",
      leaseToken: "live-lease",
      status: "cancelled",
    })).resolves.toMatchObject({ status: "cancelled" });
  });
});
