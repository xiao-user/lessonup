import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";

describe("presentation goal approval", () => {
  it("confirms the version-bound native Dashi goal without mutating the A4 document", async () => {
    const repository = new MemoryLessonRepository();
    await repository.importNotebookGraph("owner", [{
      id: "notebook", title: "语文", className: "七年级", year: "2026", subject: "语文",
      files: [{ id: "11111111-1111-4111-8111-111111111111", title: "春", pages: 1, lessonPlan: {
        unit: "第一单元", period: "1", totalPeriods: "2", topic: "春", objectives: "概括画面",
        knowledgePoints: "对象与特点", continuity: "", focus: "概括", preparation: "", process: "圈画并比较",
        assessment: "用证据回答", homework: "", board: "", reflection: "",
      } }],
    }]);
    const fileBefore = await repository.getLessonFile("owner", "11111111-1111-4111-8111-111111111111");
    await repository.saveApproval({
      id: "approval", ownerId: "owner", runId: "run", threadId: "thread", branchId: "branch",
      state: "pending", encryptedRunState: "before", agentDefinitionVersion: "test",
      resourceType: "lesson_file", patchKind: "presentation_storyboard",
      lessonFileId: fileBefore!.id, baseResourceVersion: 0, documentVersion: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
      patch: {
        kind: "presentation_storyboard", fileId: fileBefore!.id, documentVersion: 0,
        summary: "确认 Dashi 课堂演示",
        goal: {
          title: "春", goal: "作者怎样写出春的特点？", themePack: "theme01",
          slides: [
            { layout: "theme01_page001", props: { title: "春", question: "作者怎样写出春的特点？" } },
            { layout: "theme01_page021", props: { title: "找出特点", task: "圈画对象与特点" } },
            { layout: "theme01_page051", props: { title: "回答问题", prompt: "用证据回答" } },
          ],
        },
      },
    });

    const decision = await repository.decideApproval({
      ownerId: "owner", approvalId: "approval", approved: true, encryptedRunState: "after",
    });
    const fileAfter = await repository.getLessonFile("owner", fileBefore!.id);

    expect(decision.approval).toMatchObject({ state: "approved", continuationStatus: "ready" });
    expect(decision.file).toBeNull();
    expect(fileAfter).toEqual(fileBefore);
  });
});
