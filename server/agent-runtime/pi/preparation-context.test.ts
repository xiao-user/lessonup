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
    getLessonDesignBasis: vi.fn().mockResolvedValue({
      basis: { version: 2, frameworkId: "framework-1" },
      entries: [],
    }),
  };
}

describe("loadPreparationContext", () => {
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
