import { describe, expect, it, vi } from "vitest";
import type { LessonRepository } from "../../repository.js";
import { loadPreparationContext } from "./preparation-context.js";

const input = (patch: Record<string, unknown> = {}) => ({
  userId: "user-1",
  threadId: "thread-1",
  branchId: "branch-1",
  runId: "run-1",
  documentVersion: 3,
  activeSectionId: "process",
  signal: new AbortController().signal,
  ...patch,
});

function lessonRepository() {
  return {
    getThread: vi.fn().mockResolvedValue({
      id: "thread-1",
      notebookId: "notebook-1",
      resourceType: "lesson_file",
      lessonFileId: "file-1",
    }),
    getBranch: vi.fn().mockResolvedValue({ id: "branch-1" }),
    getLessonFileContext: vi.fn().mockResolvedValue({
      id: "file-1",
      notebookId: "notebook-1",
      documentVersion: 3,
      contextProfile: { subject: "语文" },
    }),
    getLessonFile: vi.fn().mockResolvedValue({
      id: "file-1",
      notebookId: "notebook-1",
      documentVersion: 3,
      contextProfile: { subject: "语文" },
      document: { topic: "春" },
    }),
    getDecision: vi.fn(),
    getRun: vi.fn(),
    getLessonDesignBasis: vi.fn().mockResolvedValue({
      basis: { version: 2, frameworkId: "framework-1" },
      entries: [],
    }),
  };
}

describe("loadPreparationContext", () => {
  const decision = () => ({ id: "decision-1", ownerId: "user-1", notebookId: "notebook-1", lessonFileId: "file-1",
    version: 2, status: "teacher_confirmed", question: "目标与评价如何对齐？", chosenOptionId: "option-1",
    options: [{ id: "option-1", statement: "增加解释型出口条", tradeoffs: ["增加评分时间"] }], assumptions: ["教师保留解释目标"],
    provenance: { confirmedBy: "user-1", modelRunId: "origin-run" } });
  const handoff = () => input({ taskIntent: { type: "document_write", decisionRef: { id: "decision-1", version: 2, chosenOptionId: "option-1" } } });

  it("prepares only the canonical teacher-confirmed option and assumptions", async () => {
    const repository = lessonRepository();
    repository.getDecision.mockResolvedValue(decision());
    repository.getRun.mockResolvedValue({ id: "origin-run", ownerId: "user-1", threadId: "thread-1", status: "completed" });
    const loaded = await loadPreparationContext(repository as unknown as LessonRepository, handoff());
    expect(loaded.context).toMatchObject({ confirmedDecision: { id: "decision-1", version: 2,
      chosenOption: { id: "option-1", statement: "增加解释型出口条" }, assumptions: ["教师保留解释目标"] } });
    expect(loaded.context).not.toHaveProperty("confirmedDecision.provenance");
  });

  it.each([
    { ownerId: "other" }, { lessonFileId: "other" }, { notebookId: "other" }, { version: 3 },
    { status: "proposed" }, { status: "reviewed" }, { chosenOptionId: "other" }, { options: [] },
    { provenance: { confirmedBy: "other", modelRunId: "origin-run" } },
  ])("rejects stale or unconfirmed handoff %j", async patch => {
    const repository = lessonRepository(); repository.getDecision.mockResolvedValue({ ...decision(), ...patch });
    await expect(loadPreparationContext(repository as unknown as LessonRepository, handoff())).rejects.toThrow("decision_context_stale");
  });

  it.each(["running", "cancelled", "failed"])("rejects a %s model origin", async status => {
    const repository = lessonRepository(); repository.getDecision.mockResolvedValue(decision());
    repository.getRun.mockResolvedValue({ ownerId: "user-1", threadId: "thread-1", status });
    await expect(loadPreparationContext(repository as unknown as LessonRepository, handoff())).rejects.toThrow("decision_context_stale");
  });

  it("allows a teacher-authored implemented decision without a model origin", async () => {
    const repository = lessonRepository(); repository.getDecision.mockResolvedValue({ ...decision(), status: "implemented",
      provenance: { confirmedBy: "user-1", modelRunId: null } });
    expect((await loadPreparationContext(repository as unknown as LessonRepository, handoff())).context).toHaveProperty("confirmedDecision.id", "decision-1");
    expect(repository.getRun).not.toHaveBeenCalled();
  });

  it("rejects handoff on semester resources and absent decisions", async () => {
    const repository = lessonRepository(); repository.getDecision.mockResolvedValue(null);
    await expect(loadPreparationContext(repository as unknown as LessonRepository, handoff())).rejects.toThrow("decision_context_stale");
    repository.getThread.mockResolvedValue({ id: "thread-1", resourceType: "semester_framework", notebookId: "notebook-1", semesterFrameworkId: "framework" });
    await expect(loadPreparationContext(repository as unknown as LessonRepository, handoff())).rejects.toThrow("decision_context_stale");
  });
  it("uses the light lesson projection and skips design-basis I/O for Fast turns", async () => {
    const repository = lessonRepository();
    const loaded = await loadPreparationContext(
      repository as unknown as LessonRepository,
      input({ skipDesignBasis: true }),
    );

    expect(repository.getLessonFileContext).toHaveBeenCalledOnce();
    expect(repository.getLessonFile).not.toHaveBeenCalled();
    expect(repository.getLessonDesignBasis).not.toHaveBeenCalled();
    expect(loaded.document).toBeUndefined();
    expect(loaded.context).toMatchObject({
      resourceType: "lesson_file",
      lessonFileId: "file-1",
      designBasisVersion: 0,
    });
  });

  it("loads the canonical document and design basis for Agent turns", async () => {
    const repository = lessonRepository();
    const loaded = await loadPreparationContext(
      repository as unknown as LessonRepository,
      input(),
    );

    expect(repository.getLessonFile).toHaveBeenCalledOnce();
    expect(repository.getLessonDesignBasis).toHaveBeenCalledOnce();
    expect(loaded.document).toEqual({ topic: "春" });
    expect(loaded.hasUpstreamPlanningContext).toBe(true);
    expect(loaded.context).toMatchObject({ designBasisVersion: 2 });
  });

  it("rejects a resource outside the thread notebook isolation chain", async () => {
    const repository = lessonRepository();
    repository.getLessonFileContext.mockResolvedValue({
      id: "file-1",
      notebookId: "another-notebook",
      documentVersion: 3,
      contextProfile: {},
    });

    await expect(loadPreparationContext(
      repository as unknown as LessonRepository,
      input({ skipDesignBasis: true }),
    )).rejects.toThrow("thread_scope_invalid");
  });
});
