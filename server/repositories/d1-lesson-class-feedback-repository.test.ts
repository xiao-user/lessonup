import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { D1LessonClassFeedbackRepository } from "./d1-lesson-class-feedback-repository.js";

describe("bounded D1 classroom feedback reads", () => {
  it("seeks the owner/blueprint index and returns only the latest scoped records", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      // The feedback table migration can run independently with FK checks off.
      db.exec(readFileSync(new URL("../../d1/migrations/0013_continuity_decisions_and_feedback.sql", import.meta.url), "utf8"));
      db.exec(readFileSync(new URL("../../d1/migrations/0022_class_feedback_blueprint_reads.sql", import.meta.url), "utf8"));
      const insert = db.prepare(`INSERT INTO lesson_class_feedback
        (id, owner_id, notebook_id, lesson_file_id, lesson_blueprint_id, kind, statement, created_at, updated_at)
        VALUES (?, ?, 'notebook', 'file', ?, 'observation', ?, ?, 'now')`);
      for (let index = 0; index < 12; index += 1) {
        insert.run(`feedback-${index}`, "owner", "blueprint", `观察${index}`, `2026-10-17T00:${String(index).padStart(2, "0")}:00Z`);
      }
      insert.run("private-feedback", "other", "blueprint", "其他教师的记录", "2026-10-17T01:00:00Z");
      insert.run("unrelated-feedback", "owner", "unrelated", "其他课时的记录", "2026-10-17T01:00:00Z");
      const queries: SqlStatement[] = [];
      const port = { query: async (statement: SqlStatement) => {
        queries.push(statement);
        return { rows: db.prepare(statement.sql).all(...statement.params ?? []), rowsAffected: 0 };
      } } as unknown as SqlDatabase;
      const repository = new D1LessonClassFeedbackRepository(port);
      const result = await repository.listLessonClassFeedback("owner", { lessonBlueprintId: "blueprint", limit: 3 });
      expect(result.map((item) => item.statement)).toEqual(["观察11", "观察10", "观察9"]);
      const query = queries[0]!;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params ?? []);
      expect(JSON.stringify(plan)).toContain("lesson_class_feedback_blueprint_idx");
      expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
      for (const limit of [0, -1, 101, 1.5]) {
        await expect(repository.listLessonClassFeedback("owner", { limit })).rejects.toThrow("class_feedback_limit_invalid");
      }
      expect(queries).toHaveLength(1);
    } finally { db.close(); }
  });
});
