import { describe, expect, it } from "vitest";
import { D1CurriculumStandardReadRepository } from "./d1-curriculum-standard-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1CurriculumStandardReadRepository", () => {
  it("only ranks chunks from published releases and applies document and chunk scopes", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [matchingChunk, wrongGrade], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1CurriculumStandardReadRepository(database);
    await expect(repository.searchCurriculumStandards({ query: "修辞 教学", subject: "语文", grade: "三年级", limit: 6, embedding: [1, 0] })).resolves.toMatchObject([{ id: "doc-1", chunkId: "chunk-1" }]);
    expect(queries[0]?.sql).toContain("r.status = 'published'");
    expect(queries[0]?.params).toEqual(["语文"]);
  });
});
const matchingChunk = { document_id: "doc-1", title: "义务教育语文课程标准", source_url: "https://example.com/standard", document_kind: "curriculum_standard", stage_scope_json: "[\"第二学段\"]", grade_scope_json: "[\"三年级\",\"四年级\"]", page: 12, stable_chunk_id: "chunk-1", passage: "修辞教学应联系具体语境。", section: "课程内容【内容要求】", curriculum_stage: "第二学段", grade_start: 3, grade_end: 4, curriculum_domain: "阅读与鉴赏", embedding_json: "[1,0]" };
const wrongGrade = { ...matchingChunk, stable_chunk_id: "chunk-2", grade_start: 7, grade_end: 9 };
