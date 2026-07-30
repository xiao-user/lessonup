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

  it("does not accept knowledge uploads without server-side storage configuration", async () => {
    const app = createApp(new MemoryLessonRepository());
    const response = await app.request("/api/knowledge/uploads", {
      method: "POST",
      headers: { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" },
      body: new FormData(),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_storage_not_configured" });
  });
});
