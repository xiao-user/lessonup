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
    expect(queries[0]?.sql).toContain("c.embedding_json");
  });

  it("does not transfer stored vectors when the query has none to compare against", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [matchingChunk], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    await new D1CurriculumStandardReadRepository(database).searchCurriculumStandards({ query: "修辞 教学", subject: "语文", grade: "三年级", limit: 6 });
    expect(queries[0]?.sql).toContain("NULL AS embedding_json");
    expect(queries[0]?.sql).not.toContain("c.embedding_json");
  });

  it("matches an elementary/middle-school notebook against the grade span in a curriculum-stage heading", async () => {
    const fourthStage = {
      ...matchingChunk,
      stage_scope_json: '["小学","初中"]', grade_scope_json: "[]",
      curriculum_stage: "第四学段", grade_start: null, grade_end: null,
      section: "第四学段（7～9年级） > 【阅读与鉴赏】",
    };
    const secondStage = { ...fourthStage, stable_chunk_id: "primary", curriculum_stage: "第二学段", section: "第二学段（3～4年级） > 【阅读与鉴赏】" };
    const database = { query: async () => ({ rows: [fourthStage, secondStage], rowsAffected: 2 }), batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1CurriculumStandardReadRepository(database);
    const results = await repository.searchCurriculumStandards({ query: "修辞 教学", subject: "语文", stage: "初中", grade: "七年级", limit: 6 });
    expect(results.map((result) => result.chunkId)).toEqual(["chunk-1"]);
  });

  it("uses one lexical scale for a partly embedded scoped release", async () => {
    const exact = { ...matchingChunk, stable_chunk_id: "exact", passage: "理解负数的意义，并能用数轴表示有理数。", embedding_json: null, section: "第四学段（7～9年级） > 内容要求", grade_start: null, grade_end: null, curriculum_stage: "第四学段", stage_scope_json: '["初中"]', grade_scope_json: "[]" };
    const unrelated = { ...exact, stable_chunk_id: "unrelated", passage: "其他课程内容。", embedding_json: "[1,0]", section: "课程目标" };
    const database = { query: async () => ({ rows: [unrelated, exact], rowsAffected: 2 }), batch: async () => [] } as unknown as SqlDatabase;
    const results = await new D1CurriculumStandardReadRepository(database).searchCurriculumStandards({ query: "负数 数轴 有理数", subject: "数学", stage: "初中", grade: "七年级", limit: 6, embedding: [1, 0] });
    expect(results[0]?.chunkId).toBe("exact");
  });
});
const matchingChunk = { document_id: "doc-1", title: "义务教育语文课程标准", source_url: "https://example.com/standard", document_kind: "curriculum_standard", stage_scope_json: "[\"第二学段\"]", grade_scope_json: "[\"三年级\",\"四年级\"]", page: 12, stable_chunk_id: "chunk-1", passage: "修辞教学应联系具体语境。", section: "课程内容【内容要求】", curriculum_stage: "第二学段", grade_start: 3, grade_end: 4, curriculum_domain: "阅读与鉴赏", embedding_json: "[1,0]" };
const wrongGrade = { ...matchingChunk, stable_chunk_id: "chunk-2", grade_start: 7, grade_end: 9 };
