import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";

const document = {
  unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标",
  focus: "重点", preparation: "准备", process: "过程", assessment: "评价",
  homework: "作业", board: "板书", reflection: "反思",
};

describe("LessonUp API scope", () => {
  it("imports data, creates a thread, and blocks another test user", async () => {
    const app = createApp(new MemoryLessonRepository());
    const userA = "00000000-0000-4000-8000-00000000000a";
    const userB = "00000000-0000-4000-8000-00000000000b";
    const importResponse = await app.request("/api/bootstrap/import", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userA },
      body: JSON.stringify({ notebooks: [{
        id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
        files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
      }] }),
    });
    expect(importResponse.status).toBe(200);

    const threadResponse = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userA },
      body: JSON.stringify({ notebookId: "n1", lessonFileId: "f1" }),
    });
    expect(threadResponse.status).toBe(201);

    const forbiddenRead = await app.request("/api/lesson-files/f1", {
      headers: { "x-lessonup-user": userB },
    });
    expect(forbiddenRead.status).toBe(404);
  });

  it("does not accept knowledge uploads without the complete indexing configuration", async () => {
    const app = createApp(new MemoryLessonRepository());
    const response = await app.request("/api/knowledge/uploads", {
      method: "POST",
      headers: { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" },
      body: new FormData(),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_indexing_not_configured" });
  });

  it("refuses to stack another empty new thread on the current empty branch", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, { harness: null, threadStarterGenerator: null });
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);
    const current = await repository.createThread(userId, {
      notebookId: "n1", lessonFileId: "f1",
    });

    const response = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({
        notebookId: "n1",
        lessonFileId: "f1",
        currentThreadId: current.thread.id,
        currentBranchId: current.branch.id,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "current_thread_empty" });
    await expect(repository.listThreads(userId, "f1")).resolves.toHaveLength(1);
  });

  it("generates starters asynchronously from the canonical document without adding conversation history", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, {
      harness: null,
      threadStarterGenerator: async ({ file }) => [
        `检查${file.document.topic}的目标一致性`,
        "优化课堂问题链",
      ],
    });
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);

    const response = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({ notebookId: "n1", lessonFileId: "f1" }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as {
      thread: { id: string; starterSuggestions: string[]; starterSuggestionsDocumentVersion: number };
      branch: { id: string };
    };
    expect(created.thread.starterSuggestions).toEqual([]);

    const starterResponse = await app.request(`/api/agent/threads/${created.thread.id}/starters`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({}),
    });
    expect(starterResponse.status).toBe(200);
    const thread = await starterResponse.json() as {
      id: string;
      starterSuggestions: string[];
      starterSuggestionsDocumentVersion: number;
    };
    expect(thread.starterSuggestions).toEqual([
      "检查课题的目标一致性",
      "优化课堂问题链",
    ]);
    expect(thread.starterSuggestionsDocumentVersion).toBe(0);
    await expect(repository.listMessages(
      userId,
      thread.id,
      created.branch.id,
    )).resolves.toEqual([]);
  });

  it("restores only normalized activity from the latest run in the selected branch", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "n1", lessonFileId: "f1",
    });
    await repository.createRun({
      id: "00000000-0000-4000-8000-0000000000aa",
      ownerId: userId,
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "completed",
    });
    await repository.appendRunEvent(userId, "00000000-0000-4000-8000-0000000000aa", "tool.started", {
      type: "tool.started",
      runId: "00000000-0000-4000-8000-0000000000aa",
      toolCallId: "call-1",
      name: "read_document",
      label: "读取整份教案",
      groupKey: "document-read",
    });
    const app = createApp(repository, { harness: null });
    const response = await app.request(
      `/api/agent/threads/${thread.id}/activity?branchId=${branch.id}`,
      { headers: { "x-lessonup-user": userId } },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { run: { id: string }; events: Array<{ type: string }> };
    expect(payload.run.id).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(payload.events).toEqual([expect.objectContaining({ type: "tool.started" })]);
  });
});
