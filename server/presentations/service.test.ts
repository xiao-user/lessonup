import { describe, expect, it } from "vitest";
import type { DashiGoal } from "./dashi-goal.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { PresentationService } from "./service.js";

const ownerId = "presentation-owner";
const lessonFileId = "11111111-1111-4111-8111-111111111111";
const document = {
  unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标",
  knowledgePoints: "知识点", continuity: "", focus: "重点", preparation: "准备",
  process: "过程", assessment: "评价", homework: "作业", board: "板书", reflection: "反思",
};
const goal: DashiGoal = {
  title: "课题 · 课堂演示",
  goal: "问题是什么？",
  themePack: "theme07",
  slides: [
    { layout: "theme07_page001", props: { title: "课题", content: "问题是什么？" } },
    { layout: "theme07_page021", props: { title: "展开探究", content: "完成学习任务" } },
    { layout: "theme07_page051", props: { title: "回答问题", content: "提交学习结果" } },
  ],
};

async function fixture() {
  const repository = new MemoryLessonRepository();
  await repository.importNotebookGraph(ownerId, [{
    id: "presentation-notebook",
    title: "课堂演示备课本",
    className: "一班",
    year: "2026",
    subject: "数学",
    files: [{ id: lessonFileId, title: "课题", pages: 1, lessonPlan: document }],
  }]);
  const removed: string[] = [];
  const service = new PresentationService(repository, {
    open: async () => "http://127.0.0.1:5200/",
    remove: async (id: string) => { removed.push(id); },
    hasDeck: async () => true,
    exportBundle: async () => ({
      files: [{ path: "index.html", body: new TextEncoder().encode("<html></html>") }],
      byteSize: 13,
    }),
    importBundle: async () => {},
  });
  return { service, removed };
}

async function render(service: PresentationService, idempotencyKey: string, checksum = "checksum") {
  const started = await service.beginApprovedGoalGeneration(
    ownerId,
    lessonFileId,
    { expectedDocumentVersion: 0, goal },
    idempotencyKey,
  );
  if ("presentation" in started) return started.presentation;
  return service.completeApprovedGoalGeneration({
    generation: started.generation,
    presentationId: started.presentationId,
    idempotencyKey,
    goal,
    deck: {
        deckKey: started.presentationId,
        previewUrl: "http://127.0.0.1:5200/",
        checksum,
        pageCount: goal.slides.length,
    },
  });
}

describe("PresentationService", () => {
  it("persists only the previously approved immutable Dashi goal", async () => {
    const { service } = await fixture();
    const created = await render(service, "approved-request");
    expect(created.delivery).toBe("native-dashi");
    expect(created.dashiGoal?.slides).toHaveLength(3);
    await expect(service.list(ownerId, lessonFileId)).resolves.toEqual([created]);
  });

  it("rejects stale source documents before generation starts", async () => {
    const { service } = await fixture();
    await expect(service.beginApprovedGoalGeneration(
      ownerId,
      lessonFileId,
      { expectedDocumentVersion: 1, goal },
      "stale",
    )).rejects.toThrow("stale_document");
  });

  it("is idempotent and replaces an older deck only after the new deck is saved", async () => {
    const { service, removed } = await fixture();
    const first = await render(service, "first");
    const repeated = await service.beginApprovedGoalGeneration(
      ownerId,
      lessonFileId,
      { expectedDocumentVersion: 0, goal },
      "first",
    );
    expect(repeated).toEqual({ presentation: first });
    const second = await render(service, "second", "checksum-2");
    await expect(service.list(ownerId, lessonFileId)).resolves.toEqual([second]);
    expect(removed).toContain(first.id);
  });

  it("records a retryable generation failure", async () => {
    const { service } = await fixture();
    const started = await service.beginApprovedGoalGeneration(
      ownerId,
      lessonFileId,
      { expectedDocumentVersion: 0, goal },
      "failure",
    );
    if ("presentation" in started) throw new Error("unexpected_existing_presentation");
    await service.failApprovedGoalGeneration(started.generation, new Error("presentation_render_not_completed"));
    await expect(service.getGeneration(ownerId, lessonFileId)).resolves.toMatchObject({
      status: "failed",
      errorCode: "presentation_generation_failed",
    });
  });
});
