import { describe, expect, it } from "vitest";
import { D1SemesterFrameworkReadRepository } from "./d1-semester-framework-read-repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1SemesterFrameworkReadRepository", () => {
  it("builds an owner-scoped aggregate from separate portable queries", async () => {
    const queries: SqlStatement[] = []; let call = 0;
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); call += 1; return { rows: call === 1 ? [root] : [], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const repository = new D1SemesterFrameworkReadRepository(database);
    await expect(repository.getSemesterFramework("owner-1", "framework-1")).resolves.toMatchObject({ framework: { id: "framework-1", ownerId: "owner-1" }, units: [] });
    expect(queries).toHaveLength(4);
    expect(queries[0]?.params).toEqual(["owner-1", "framework-1"]);
    expect(queries[1]?.sql).toContain("owner_id = ? AND framework_id = ?");
  });
});
const root = { id: "framework-1", owner_id: "owner-1", notebook_id: "notebook-1", textbook_id: "book-1", catalog_release_id: "catalog-1", semantic_release_id: null, title: "上学期", term: "2026秋", start_date: null, total_weeks: 18, weekly_periods: 5, lesson_duration_minutes: 40, capacity_ratio: 0.9, planning_horizon_weeks: 2, context_profile_json: "{}", version: 0, status: "draft", created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z" };
