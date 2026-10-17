import { describe, expect, it } from "vitest";
import { D1KnowledgeReadRepository } from "./d1-knowledge-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

type ScanRow = typeof chunk;

/** Answers the text scan and the follow-up vector fetch the way D1 would. */
function database(rows: ScanRow[], vectors: Record<string, string | null> = {}) {
  const queries: SqlStatement[] = [];
  const port = {
    query: async (statement: SqlStatement) => {
      queries.push(statement);
      if (statement.sql.includes("SELECT k.id, k.embedding_json")) {
        const ids = (statement.params ?? []).filter((value): value is string => typeof value === "string" && value in vectors);
        return { rows: ids.map((id) => ({ id, embedding_json: vectors[id] })), rowsAffected: 0 };
      }
      return { rows, rowsAffected: rows.length };
    },
    batch: async () => [],
  } as unknown as SqlDatabase;
  return { port, queries };
}

describe("D1KnowledgeReadRepository", () => {
  it("limits read candidates by the server-issued knowledge scope and ranks vectors in application code", async () => {
    const { port, queries } = database([chunk], { "row-1": "[1,0]" });
    const repository = new D1KnowledgeReadRepository(port);
    await expect(repository.searchKnowledge("owner-1", ["public", "notebook:notebook-1"], "目标", 6, [1, 0])).resolves.toMatchObject([{ id: "source-1", chunkId: "chunk-1", score: expect.any(Number) }]);
    expect(queries[0]?.sql).toContain("k.scope = 'public'");
    expect(queries[0]?.sql).toContain("k.notebook_id = ?");
    expect(queries[0]?.sql).toContain("s.attached_message_id IS NOT NULL");
    expect(queries[0]?.params).toContain("notebook-1");
    // The vector fetch is re-scoped to the same owner and notebook.
    expect(queries[1]?.sql).toContain("k.notebook_id = ?");
    expect(queries[1]?.params).toEqual(expect.arrayContaining(["row-1", "owner-1", "notebook-1"]));
  });

  it("keeps indexed private drafts outside every provider-visible read path until sent", async () => {
    const queries: SqlStatement[] = [];
    const port = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        return { rows: [], rowsAffected: 0 };
      },
      batch: async () => [],
    } as unknown as SqlDatabase;
    const repository = new D1KnowledgeReadRepository(port);

    await repository.getKnowledgePassage("owner-1", ["file:file-1"], "chunk-1");
    await repository.getKnowledgeSourcePassages("owner-1", ["file:file-1"], "source-1", 6);
    await repository.listProjectSources("owner-1", ["file:file-1"]);

    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.sql).toContain("s.scope = 'public' OR s.attached_message_id IS NOT NULL");
    }
  });

  it("finds a passage from an unspaced Chinese question without any query vector", async () => {
    const { port, queries } = database([
      { ...chunk, id: "row-a", stable_chunk_id: "a", passage: "光合作用是绿色植物制造有机物的过程" },
      { ...chunk, id: "row-b", stable_chunk_id: "b", passage: "用数轴比较有理数的大小，先画数轴再标点" },
    ]);
    const results = await new D1KnowledgeReadRepository(port).searchKnowledge("owner-1", ["notebook:notebook-1"], "怎样用数轴比较有理数的大小", 6);
    expect(results.map((result) => result.chunkId)).toEqual(["b"]);
    // Without a query vector nothing needs a stored vector: one text scan, no vector column.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("NULL AS embedding_json");
    expect(queries[0]?.sql).not.toContain("k.embedding_json");
  });

  it("ranks the whole scanned window rather than only the newest few hundred chunks", async () => {
    const rows = Array.from({ length: 900 }, (_, index) => ({
      ...chunk, id: `row-${index}`, stable_chunk_id: `c${index}`, passage: index === 850 ? "板书设计应突出温晴与景物证据" : `无关内容${index}`,
    }));
    const { port } = database(rows);
    const results = await new D1KnowledgeReadRepository(port).searchKnowledge("owner-1", ["notebook:notebook-1"], "板书设计 温晴", 3);
    expect(results.map((result) => result.chunkId)).toEqual(["c850"]);
  });

  it("fetches vectors for text leaders and the recent semantic window, in bounded batches", async () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      ...chunk, id: `row-${index}`, stable_chunk_id: `c${index}`, passage: `资料${index}`,
    }));
    const { port, queries } = database(rows, Object.fromEntries(rows.map((row) => [row.id, "[0,1]"])));
    await new D1KnowledgeReadRepository(port).searchKnowledge("owner-1", ["notebook:notebook-1"], "资料", 6, [0, 1]);
    const vectorQueries = queries.filter((query) => query.sql.includes("SELECT k.id, k.embedding_json"));
    expect(vectorQueries).toHaveLength(4);
    expect(vectorQueries.reduce((total, query) => total + (query.params ?? []).filter((value) => String(value).startsWith("row-")).length, 0)).toBe(300);
    for (const query of vectorQueries) expect(query.params?.length ?? 0).toBeLessThanOrEqual(100);
  });

  it("keeps a semantic-only match beyond the text candidate cutoff", async () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      ...chunk, id: `row-${index}`, stable_chunk_id: `c${index}`,
      passage: index === 200 ? "小组合作探究" : "板书设计应突出核心概念",
    }));
    const vectors = Object.fromEntries(rows.map((row, index) => [row.id, index === 200 ? "[1,0]" : "[0,1]"]));
    const { port } = database(rows, vectors);
    const results = await new D1KnowledgeReadRepository(port).searchKnowledge("owner-1", ["notebook:notebook-1"], "板书设计", 3, [1, 0]);
    expect(results[0]?.chunkId).toBe("c200");
  });

  it("lets a stored vector lift a chunk that shares no words with the query", async () => {
    const { port } = database([
      { ...chunk, id: "row-a", stable_chunk_id: "a", passage: "评价任务要能证明目标达成" },
      { ...chunk, id: "row-b", stable_chunk_id: "b", passage: "小组合作探究" },
    ], { "row-a": "[0,1]", "row-b": "[1,0]" });
    const results = await new D1KnowledgeReadRepository(port).searchKnowledge("owner-1", ["notebook:notebook-1"], "怎样检验学习效果", 2, [1, 0]);
    expect(results[0]?.chunkId).toBe("b");
  });
});
const chunk = { id: "row-1", source_id: "source-1", title: "资料", scope: "notebook", page: 1, stable_chunk_id: "chunk-1", passage: "教学目标和评价", section: "第一节", embedding_json: null as string | null };
