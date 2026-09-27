import { describe, expect, it } from "vitest";
import { D1KnowledgeReadRepository } from "./d1-knowledge-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1KnowledgeReadRepository", () => {
  it("limits read candidates by the server-issued knowledge scope and ranks vectors in application code", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [chunk], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1KnowledgeReadRepository(database);
    await expect(repository.searchKnowledge("owner-1", ["public", "notebook:notebook-1"], "目标", 6, [1, 0])).resolves.toMatchObject([{ id: "source-1", chunkId: "chunk-1", score: expect.any(Number) }]);
    expect(queries[0]?.sql).toContain("k.scope = 'public'");
    expect(queries[0]?.sql).toContain("k.notebook_id = ?");
    expect(queries[0]?.sql).toContain("s.attached_message_id IS NOT NULL");
    expect(queries[0]?.params).toContain("notebook-1");
  });

  it("keeps indexed private drafts outside every provider-visible read path until sent", async () => {
    const queries: SqlStatement[] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        return { rows: [], rowsAffected: 0 };
      },
      batch: async () => [],
    } as unknown as SqlDatabase;
    const repository = new D1KnowledgeReadRepository(database);

    await repository.getKnowledgePassage("owner-1", ["file:file-1"], "chunk-1");
    await repository.getKnowledgeSourcePassages("owner-1", ["file:file-1"], "source-1", 6);
    await repository.listProjectSources("owner-1", ["file:file-1"]);

    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.sql).toContain("s.scope = 'public' OR s.attached_message_id IS NOT NULL");
    }
  });
});
const chunk = { source_id: "source-1", title: "资料", scope: "notebook", page: 1, stable_chunk_id: "chunk-1", passage: "教学目标和评价", section: "第一节", embedding_json: "[1,0]" };
