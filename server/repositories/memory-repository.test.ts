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
      role: "user", content: "原问题", status: "completed",
    });
    const fork = await repository.createBranch("user-a", thread.id, branch.id, message.id);
    await repository.appendMessage({
      ownerId: "user-a", threadId: thread.id, branchId: fork.id,
      role: "user", content: "分支问题", status: "completed",
    });
    expect((await repository.listMessages("user-a", thread.id, branch.id)).map((item) => item.content)).toEqual(["原问题"]);
    expect((await repository.listMessages("user-a", thread.id, fork.id)).map((item) => item.content)).toEqual(["原问题", "分支问题"]);
  });

  it("makes document writes idempotent and rejects a stale base version", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const first = await repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document: { ...document, topic: "新课题" }, pageCount: 1,
      source: "manual", idempotencyKey: "write-1",
    });
    const replay = await repository.saveLessonDocument({
      ownerId: "user-a", fileId: "f1", baseVersion: 0,
      document: { ...document, topic: "被忽略" }, pageCount: 1,
      source: "manual", idempotencyKey: "write-1",
    });
    expect(replay.document.topic).toBe("新课题");
    expect(replay.documentVersion).toBe(first.documentVersion);
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

  it("restores pending approvals and applies an approved patch only once", async () => {
    const repository = new MemoryLessonRepository();
    await importFor(repository, "user-a");
    const { thread, branch } = await repository.createThread("user-a", { notebookId: "n1", lessonFileId: "f1" });
    await repository.saveApproval({
      id: "approval-1", ownerId: "user-a", runId: "run-1", threadId: thread.id, branchId: branch.id,
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
  });
});
