import { describe, expect, it } from "vitest";
import { D1CurriculumSemanticReadRepository } from "./d1-curriculum-semantic-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1CurriculumSemanticReadRepository", () => {
  it("uses only published, approved mappings when reading a textbook node", async () => {
    const queries: SqlStatement[] = [];
    let call = 0;
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); call += 1; return call === 1 ? { rows: [release], rowsAffected: 1 } : call === 2 ? { rows: [mapping], rowsAffected: 1 } : call === 3 ? { rows: [entity], rowsAffected: 1 } : { rows: [], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1CurriculumSemanticReadRepository(database);
    await expect(repository.readCurriculumNodeSemantics({ textbookId: "book-1", nodeId: "node-1" })).resolves.toMatchObject({ release: { id: "release-1" }, mappings: [{ entity: { id: "entity-1" } }] });
    expect(queries[0]?.sql).toContain("r.status = 'published'");
    expect(queries[1]?.sql).toContain("review_state = 'approved'");
  });
});
const release = { id: "release-1", scope_key: "scope", catalog_generation_id: "catalog", subject: "语文", stage: "小学", edition: "统编", grade: "三年级", volume: "上", schema_version: 1, published_at: "2026-08-24T00:00:00.000Z" };
const mapping = { id: "mapping-1", release_id: "release-1", semantic_entity_id: "entity-1", instructional_role: "introduces" as const, expected_depth: 1, priority: 1, confidence: 0.9, rationale: "依据课标" };
const entity = { release_id: "release-1", semantic_entity_id: "entity-1", kind: "knowledge" as const, canonical_name: "修辞", definition: "表达知识", payload_json: "{}", confidence: 0.9 };
