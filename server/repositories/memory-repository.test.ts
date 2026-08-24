import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "./memory-repository.js";
import type { LessonPlan } from "../domain.js";
import { materializeLessonDesignChange } from "../lesson-design-change.js";

const document: LessonPlan = {
  unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标",
  knowledgePoints: "知识点",
  continuity: "",
  focus: "重点", preparation: "准备", process: "过程", assessment: "评价",
  homework: "作业", board: "板书", reflection: "反思",
};

const importFor = (repository: MemoryLessonRepository, ownerId: string) => repository.importNotebookGraph(ownerId, [{
  id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
  files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
}]);

describe("memory repository isolation", () => {
  it("keeps separate run evidence for distinct chunks from one source", async () => {
    const repository = new MemoryLessonRepository();
    await repository.createRun({
      id: "run-evidence-chunks",
      ownerId: "user-a",
      threadId: "thread-evidence-chunks",
      branchId: "branch-evidence-chunks",
      status: "running",
    } as never);

    await repository.recordRunEvidence("user-a", "run-evidence-chunks", "curriculum_standard_search", [
      {
        id: "standard-source",
        title: "义务教育语文课程标准",
        kind: "public",
        chunkId: "standard:page-21",
        page: 21,
      },
      {
        id: "standard-source",
        title: "义务教育语文课程标准",
        kind: "public",
        chunkId: "standard:page-33",
        page: 33,
      },
    ]);

    const evidence = await repository.listRunEvidence("user-a", "run-evidence-chunks");
    expect(evidence.map((item) => item.source.chunkId)).toEqual([
      "standard:page-21",
      "standard:page-33",
    ]);
  });

  it("returns a bounded preview derived from canonical lesson content", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const [notebook] = await repository.listNotebooks("user-a");
    expect(notebook.files[0]?.preview).toEqual(["目标", "知识点", "重点", "过程"]);
    expect(notebook.files[0]).not.toHaveProperty("document");
    expect(notebook.files[0]).not.toHaveProperty("contextProfile");
  });

  it("preserves lessonBlueprintId on notebook file summaries after create", async () => {
    const repository = new MemoryLessonRepository();
    const notebook = await repository.createNotebook("user-a", {
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      stage: "初中",
      grade: "七年级",
      edition: "统编版",
      tone: "teal",
    });
    const blueprintId = crypto.randomUUID();
    // Seed a minimal framework/blueprint binding through createLessonFile's optional id.
    // Memory repo stores the id on the file even without a live framework aggregate.
    const file = await repository.createLessonFile("user-a", {
      notebookId: notebook.id,
      title: "蓝图教案",
      type: "课时蓝图教案",
      document,
      contextProfile: {},
      lessonBlueprintId: blueprintId,
      pageCount: 1,
    }, "blueprint-link-1");
    expect(file.lessonBlueprintId).toBe(blueprintId);
    const [listed] = await repository.listNotebooks("user-a");
    expect(listed.files[0]?.lessonBlueprintId).toBe(blueprintId);
  });

  it("never returns another owner's file even when client ids collide", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    expect(await repository.getLessonFile("user-b", "f1")).toBeNull();
  });

  it("creates an isolated design-basis aggregate for every lesson file", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const aggregate = await repository.getLessonDesignBasis("user-a", "f1");
    expect(aggregate).toMatchObject({
      basis: {
        ownerId: "user-a",
        notebookId: "n1",
        lessonFileId: "f1",
        version: 0,
      },
      entries: [],
    });
    expect(await repository.getLessonDesignBasis("user-b", "f1")).toBeNull();
  });

  it("applies a complete lesson-design change atomically", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const file = await repository.getLessonFile("user-a", "f1");
    const basis = await repository.getLessonDesignBasis("user-a", "f1");
    if (!file || !basis) throw new Error("fixture_missing");
    const patch = materializeLessonDesignChange({
      file,
      aggregate: basis,
      proposal: {
        summary: "记录困难并完善评价",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "explain-reason",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生可能只写结论。",
          rationale: "需要说明理由。",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "评价：说明判断理由。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["explain-reason"],
          usesLearnerContext: false,
        }],
      },
    });
    await repository.saveApproval({
      id: "approval-change",
      ownerId: "user-a",
      runId: "run-change",
      threadId: "thread-change",
      branchId: "branch-change",
      state: "pending",
      patch,
      encryptedRunState: "state",
      agentDefinitionVersion: "test",
      resourceType: "lesson_file",
      patchKind: "document",
      lessonFileId: "f1",
      baseResourceVersion: 0,
      documentVersion: 0,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    await repository.applyApprovedPatch({
      ownerId: "user-a",
      approvalId: "approval-change",
      idempotencyKey: "approval:change",
    });
    expect((await repository.getLessonFile("user-a", "f1"))?.document.assessment)
      .toBe("评价：说明判断理由。");
    expect(await repository.getLessonDesignBasis("user-a", "f1")).toMatchObject({
      basis: { version: 1 },
      entries: [{ statement: "学生可能只写结论。", teacherConfirmed: true }],
    });
  });

  it("does not save design decisions when the A4 target conflicts", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const file = await repository.getLessonFile("user-a", "f1");
    const basis = await repository.getLessonDesignBasis("user-a", "f1");
    if (!file || !basis) throw new Error("fixture_missing");
    const patch = materializeLessonDesignChange({
      file,
      aggregate: basis,
      proposal: {
        summary: "冲突调整",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "conflict",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生可能只写结论。",
          rationale: "",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "新的评价。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["conflict"],
          usesLearnerContext: false,
        }],
      },
    });
    await repository.saveApproval({
      id: "approval-conflict",
      ownerId: "user-a",
      runId: "run-conflict",
      threadId: "thread-conflict",
      branchId: "branch-conflict",
      state: "pending",
      patch,
      encryptedRunState: "state",
      agentDefinitionVersion: "test",
      resourceType: "lesson_file",
      patchKind: "document",
      lessonFileId: "f1",
      baseResourceVersion: 0,
      documentVersion: 0,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    await repository.saveLessonDocument({
      ownerId: "user-a",
      fileId: "f1",
      baseVersion: 0,
      document: { ...document, assessment: "教师已经调整测评内容。" },
      pageCount: 1,
      source: "manual",
      idempotencyKey: "manual-conflict",
    });
    await expect(repository.applyApprovedPatch({
      ownerId: "user-a",
      approvalId: "approval-conflict",
      idempotencyKey: "approval:conflict",
    })).rejects.toThrow("目标内容已变化");
    expect((await repository.getLessonDesignBasis("user-a", "f1"))?.basis.version).toBe(0);
    expect((await repository.getLessonDesignBasis("user-a", "f1"))?.entries).toEqual([]);
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

  it("replays aggregate creation after a lost response without duplicating records", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const fileInput = {
      notebookId: "n1",
      title: "新增教案",
      type: "新教案",
      document,
      contextProfile: { lessonDurationMinutes: 45 },
      pageCount: 1,
    };
    const firstFile = await repository.createLessonFile("user-a", fileInput, "file-create-1");
    const replayedFile = await repository.createLessonFile("user-a", fileInput, "file-create-1");
    expect(replayedFile.id).toBe(firstFile.id);
    await expect(repository.createLessonFile("user-a", {
      ...fileInput,
      title: "不同教案",
    }, "file-create-1")).rejects.toThrow("idempotency_conflict");

    const threadInput = { notebookId: "n1", lessonFileId: "f1", title: "检查教案" };
    const firstThread = await repository.createThread("user-a", threadInput, "thread-create-1");
    const replayedThread = await repository.createThread("user-a", threadInput, "thread-create-1");
    expect(replayedThread).toEqual(firstThread);
    expect(await repository.listThreads("user-a", "f1")).toHaveLength(1);
    expect(await repository.listBranches("user-a", firstThread.thread.id)).toHaveLength(1);
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

  it("recovers lease-less zombie running runs after a stale heartbeat", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", {
      notebookId: "n1",
      lessonFileId: "f1",
    });
    const assistant = await repository.appendMessage({
      id: "assistant-leaseless-zombie",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      role: "assistant",
      content: "等待下一张确认卡",
      status: "completed",
    });
    await repository.createRun({
      id: "leaseless-zombie-run",
      ownerId: "user-a",
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "running",
      assistantMessageId: assistant.id,
      heartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await repository.updateThread("user-a", thread.id, { status: "running" });

    await expect(repository.recoverExpiredRuns("user-a", thread.id)).resolves.toBe(1);
    expect(await repository.getRun("user-a", "leaseless-zombie-run")).toMatchObject({
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
