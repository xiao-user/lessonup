import { describe, expect, it } from "vitest";
import { createD1LessonCoreRepository } from "./d1-lesson-core-repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";

describe("createD1LessonCoreRepository", () => {
  it("exposes one portable core surface while keeping D1 bindings outside services", async () => {
    const database = { query: async () => ({ rows: [], rowsAffected: 0 }), batch: async () => [] } as unknown as SqlDatabase;
    const repository = createD1LessonCoreRepository(database);
    expect(repository.createLessonFile).toBeTypeOf("function");
    expect(repository.createThread).toBeTypeOf("function");
    expect(repository.saveApproval).toBeTypeOf("function");
    expect(repository.searchKnowledge).toBeTypeOf("function");
    expect(repository.decideApproval).toBeTypeOf("function");
    expect(repository.listDecisions).toBeTypeOf("function");
    expect(repository.saveDecision).toBeTypeOf("function");
    expect(repository.listDecisionEvidenceCards).toBeTypeOf("function");
    await expect(repository.getNotebook("owner-1", "notebook-1")).resolves.toBeNull();
  });
});
