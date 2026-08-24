import { describe, expect, it } from "vitest";

import { MemoryLessonRepository } from "./repositories/memory-repository.js";

describe("agent message Turn presentation", () => {
  it("hydrates assistant messages with their durable run timing", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph("owner-1", [{
      id: "notebook-1",
      title: "备课本",
      className: "一班",
      year: "2026",
      subject: "语文",
      files: [{
        id: "lesson-1",
        title: "课题",
        type: "教案",
        pages: 1,
        lessonPlan: {
          unit: "单元", period: "1", totalPeriods: "1", topic: "课题",
          objectives: "目标", knowledgePoints: "知识点", continuity: "",
          focus: "重点", preparation: "准备", process: "过程",
          assessment: "评价", homework: "作业", board: "板书", reflection: "反思",
        },
      }],
    }]);
    const { thread, branch } = await repository.createThread("owner-1", {
      notebookId: "notebook-1",
      lessonFileId: "lesson-1",
    });
    const message = await repository.appendMessage({
      ownerId: "owner-1",
      threadId: thread.id,
      branchId: branch.id,
      role: "assistant",
      content: "已完成",
      status: "completed",
    });
    await repository.createRun({
      id: "run-1",
      ownerId: "owner-1",
      threadId: thread.id,
      branchId: branch.id,
      assistantMessageId: message.id,
      model: "model-a",
      status: "completed",
      startedAt: "2026-08-21T08:00:00.000Z",
      completedAt: "2026-08-21T08:01:13.000Z",
    });

    const [hydrated] = await repository.listMessages("owner-1", thread.id, branch.id);
    expect(hydrated?.turn).toEqual({
      runId: "run-1",
      status: "completed",
      startedAt: "2026-08-21T08:00:00.000Z",
      completedAt: "2026-08-21T08:01:13.000Z",
    });
  });
});
