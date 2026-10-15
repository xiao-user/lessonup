import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../../platform/sql-database.js";
import { createD1LessonCoreRepository } from "../../repositories/d1-lesson-core-repository.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import type { LessonRepository } from "../../repository.js";
import { trackEvidenceAttempts } from "./evidence-attempts.js";

const ownerId = "00000000-0000-4000-8000-00000000000a";
const runId = "00000000-0000-4000-8000-00000000000b";

describe("trackEvidenceAttempts", () => {
  it("remembers the kind of a retrieval that found nothing and still reports it to the repository", async () => {
    const repository = new MemoryLessonRepository();
    const record = vi.spyOn(repository, "recordRunEvidence").mockResolvedValue(undefined);
    const tracked = trackEvidenceAttempts(repository);
    expect([...tracked.attempts]).toEqual([]);
    await tracked.repository.recordRunEvidence(ownerId, runId, "curriculum_standard_search", []);
    await tracked.repository.recordRunEvidence(ownerId, runId, "knowledge_search", [
      { id: "s1", title: "资料", kind: "private" },
    ]);
    expect([...tracked.attempts].sort()).toEqual(["curriculum_standard_search", "knowledge_search"]);
    expect(record).toHaveBeenNthCalledWith(1, ownerId, runId, "curriculum_standard_search", []);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("does not count a retrieval whose evidence recording failed", async () => {
    const repository = new MemoryLessonRepository();
    vi.spyOn(repository, "recordRunEvidence").mockRejectedValue(new Error("database_unavailable"));
    const tracked = trackEvidenceAttempts(repository);
    await expect(tracked.repository.recordRunEvidence(ownerId, runId, "curriculum_standard_search", []))
      .rejects.toThrow("database_unavailable");
    expect([...tracked.attempts]).toEqual([]);
  });

  it("keeps every other repository method bound to the original repository", async () => {
    class Guarded {
      #secret = "kept";
      recordRunEvidence = async () => undefined;
      read() { return this.#secret; }
    }
    const tracked = trackEvidenceAttempts(new Guarded() as unknown as LessonRepository);
    expect((tracked.repository as unknown as Guarded).read()).toBe("kept");
  });

  it("wraps the production repository composition without changing its reads", async () => {
    const database = { query: async () => ({ rows: [], rowsAffected: 0 }), batch: async () => [] } as unknown as SqlDatabase;
    const tracked = trackEvidenceAttempts(createD1LessonCoreRepository(database));
    await expect(tracked.repository.getNotebook(ownerId, "notebook-1")).resolves.toBeNull();
    await tracked.repository.recordRunEvidence(ownerId, runId, "curriculum_standard_search", []);
    expect([...tracked.attempts]).toEqual(["curriculum_standard_search"]);
  });

  it("tracks each surface separately", async () => {
    const repository = new MemoryLessonRepository();
    vi.spyOn(repository, "recordRunEvidence").mockResolvedValue(undefined);
    const first = trackEvidenceAttempts(repository);
    const second = trackEvidenceAttempts(repository);
    await first.repository.recordRunEvidence(ownerId, runId, "web_open", []);
    expect([...first.attempts]).toEqual(["web_open"]);
    expect([...second.attempts]).toEqual([]);
  });
});
