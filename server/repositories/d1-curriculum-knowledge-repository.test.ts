import { describe, expect, it } from "vitest";
import { D1CurriculumKnowledgeReadRepository } from "./d1-curriculum-knowledge-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1CurriculumKnowledgeReadRepository", () => {
  it("reads only an approved published occurrence release for a node", async () => {
    const queries: SqlStatement[] = []; let call = 0;
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); call += 1; if (call === 1) return { rows: [release], rowsAffected: 1 }; if (call === 2) return { rows: [point], rowsAffected: 1 }; return { rows: [], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1CurriculumKnowledgeReadRepository(database);
    await expect(repository.readCurriculumNodeKnowledgePoints({ textbookId: "book-1", nodeId: "node-1" })).resolves.toMatchObject({ release: { id: "release-1" }, points: [] });
    expect(queries[0]?.sql).toContain("r.status = 'published'");
    expect(queries[0]?.sql).toContain("m.instructional_role = 'occurs_in'");
    expect(queries[1]?.sql).toContain("m.review_state = 'approved'");
  });
});
const release = { id: "release-1", scope_key: "scope", catalog_generation_id: "catalog", subject: "语文", stage: "小学", edition: "统编", grade: "三年级", volume: "上", schema_version: 1, published_at: "2026-08-24T00:00:00.000Z" };
const point = { id: "mapping-1", semantic_entity_id: "point-1", sequence_no: 1, printed_pages: null, recommended_period: 1, payload_json: "{}", priority: 1, external_id: "kp-1", canonical_name: "修辞", definition: "表达知识", entity_payload_json: "{}", confidence: 0.9, kind: "knowledge_point" as const, embedding_json: "[1,0]", search_text: "修辞" };
