import { describe, expect, it, vi } from "vitest";
import type { DashiGoal } from "./dashi-goal.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { PresentationService } from "./service.js";
import { MemoryObjectStorage, type ObjectStorage } from "../platform/object-storage.js";
import { goalToBrowserDeck } from "../../src/lib/dashi-browser/goal-to-deck.js";

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

async function fixture(storage: ObjectStorage | null = null) {
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
  }, storage);
  return { service, repository, removed };
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
  it("publishes one concurrent edit atomically without overwriting the winning artifact", async () => {
    const storage = new MemoryObjectStorage();
    const { service: initial, repository } = await fixture(storage);
    const created = await render(initial, "concurrent-edits");
    const editService = () => new PresentationService(repository, {
      hasDeck: async () => true,
      exportBundle: async (_id, revision) => {
        const body = new TextEncoder().encode(JSON.stringify(revision));
        return { files: [{ path: "index.html", body }], byteSize: body.byteLength };
      },
      open: async () => "", remove: async () => {}, importBundle: async () => {},
    }, storage);
    const a = goalToBrowserDeck(goal, { id: created.id });
    const b = structuredClone(a);
    a.slides[0]!.content.title = "edit A";
    b.slides[0]!.content.title = "edit B";
    const results = await Promise.allSettled([a, b].map(deck => editService().saveBrowserDeck(ownerId, created.id, { expectedChecksum: created.checksum, deck })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const current = (await repository.getClassroomPresentation(ownerId, created.id))!;
    expect(current.storageKey).toContain("/revisions/");
    const persisted = JSON.parse(new TextDecoder().decode((await storage.get(current.storageKey))!.body));
    expect(persisted.goal).toEqual(current.dashiGoal);
    expect(persisted.deck.slides[0].content.title).toBe(current.dashiGoal!.slides[0]!.props.title);
    expect(await storage.get(created.storageKey)).not.toBeNull();
  });

  it("keeps the published object when the metadata CAS fails", async () => {
    const storage = new MemoryObjectStorage();
    const { service, repository } = await fixture(storage);
    const created = await render(service, "cas-failure");
    const original = await storage.get(created.storageKey);
    vi.spyOn(repository, "updateClassroomPresentationGoal").mockRejectedValueOnce(new Error("presentation_edit_conflict"));
    await expect(service.saveBrowserDeck(ownerId, created.id, { expectedChecksum: created.checksum, deck: goalToBrowserDeck(goal, { id: created.id }) })).rejects.toThrow("presentation_edit_conflict");
    expect(await storage.get(created.storageKey)).toEqual(original);
    expect(await repository.getClassroomPresentation(ownerId, created.id)).toEqual(created);
  });
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
    const { service, repository, removed } = await fixture();
    const first = await render(service, "first");
    const sourceRead = vi.spyOn(repository, "getLessonFile")
      .mockRejectedValueOnce(new Error("should_not_reload_source"));
    const repeated = await service.beginApprovedGoalGeneration(
      ownerId,
      lessonFileId,
      { expectedDocumentVersion: 0, goal },
      "first",
    );
    expect(repeated).toEqual({ presentation: first });
    expect(sourceRead).not.toHaveBeenCalled();
    sourceRead.mockRestore();
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

  it("persists editable browser content and rejects a stale editor checksum", async () => {
    const { service } = await fixture();
    const created = await render(service, "editable-presentation");
    const deck: any = goalToBrowserDeck(goal, { id: created.id });
    const firstSlide = deck.slides[0]!;
    const firstVariant = firstSlide.variants[0]!;
    const stateId = `${firstSlide.id}::${firstVariant.id}`;
    firstVariant.stateId = stateId;
    firstSlide.selectedVariant = firstVariant.id;
    firstSlide.content.title = "《秋天的怀念》· 课堂导入";
    Object.assign(deck, {
      state: {
        slideOrder: deck.slides.map((slide: { id: string }) => slide.id),
        props: { [stateId]: { accentColor: "#ef4444" } },
        text: {}, media: {},
        variantSelection: { [firstSlide.id]: stateId },
      },
    });

    const saved = await service.saveBrowserDeck(ownerId, created.id, {
      expectedChecksum: created.checksum,
      deck,
    });

    expect(saved.dashiGoal?.slides[0]?.props).toMatchObject({
      title: "《秋天的怀念》· 课堂导入",
      accentColor: "#ef4444",
    });
    await expect(service.saveBrowserDeck(ownerId, created.id, {
      expectedChecksum: created.checksum,
      deck,
    })).rejects.toThrow("presentation_edit_conflict");
  });

  it("rolls back saved artifacts and the rendered workspace when metadata persistence fails", async () => {
    const storage = new MemoryObjectStorage();
    const { service, repository, removed } = await fixture(storage);
    const started = await service.beginApprovedGoalGeneration(
      ownerId,
      lessonFileId,
      { expectedDocumentVersion: 0, goal },
      "metadata-failure",
    );
    if ("presentation" in started) throw new Error("unexpected_existing_presentation");
    vi.spyOn(repository, "saveClassroomPresentation").mockRejectedValueOnce(new Error("d1_unavailable"));

    await expect(service.completeApprovedGoalGeneration({
      generation: started.generation,
      presentationId: started.presentationId,
      idempotencyKey: "metadata-failure",
      goal,
      deck: {
        deckKey: started.presentationId,
        previewUrl: "http://127.0.0.1:5200/",
        checksum: "checksum",
        pageCount: goal.slides.length,
      },
    })).rejects.toThrow("presentation_metadata_save_failed");

    await expect(storage.list(`${ownerId}/presentations/${started.presentationId}`)).resolves.toEqual([]);
    expect(removed).toContain(started.presentationId);
  });
});
