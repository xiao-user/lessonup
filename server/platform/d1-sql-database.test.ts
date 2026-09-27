import { describe, expect, it } from "vitest";
import { D1SqlDatabase } from "./d1-sql-database.js";

describe("D1SqlDatabase", () => {
  it("keeps D1 statements behind the portable SQL port", async () => {
    const prepared: Array<{ sql: string; params: unknown[] }> = [];
    const database = new D1SqlDatabase({
      prepare(sql) {
        const record = { sql, params: [] as unknown[] };
        prepared.push(record);
        return {
          bind(...params) { record.params = params; return this; },
          async all() { return { results: [{ id: "lesson-1" }], meta: { changes: 1 } }; },
        };
      },
      async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
    });

    await expect(database.query({ sql: "SELECT id FROM lessons WHERE id = ?", params: ["lesson-1"] }))
      .resolves.toEqual({ rows: [{ id: "lesson-1" }], rowsAffected: 1 });
    expect(prepared).toEqual([{ sql: "SELECT id FROM lessons WHERE id = ?", params: ["lesson-1"] }]);
  });
});
