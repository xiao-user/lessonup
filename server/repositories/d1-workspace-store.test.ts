import { describe, expect, it } from "vitest";
import { D1LessonWorkspaceStore } from "./d1-workspace-store.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

const plan = { unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标", knowledgePoints: "", continuity: "", focus: "重点", preparation: "准备", process: "过程", assessment: "评价", homework: "作业", board: "板书", reflection: "反思" };
const row = { id: "file-1", owner_id: "user-1", notebook_id: "notebook-1", lesson_blueprint_id: null, title: "课题", type: "教案", image: null, document_json: JSON.stringify(plan), context_profile_json: "{}", document_version: 1, page_count: 1, updated_at: "2026-08-24T00:00:00.000Z" };

describe("D1LessonWorkspaceStore", () => {
  it("loads Fast chat context without reading the lesson document body", async () => {
    const queries: SqlStatement[] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        return {
          rows: [{
            id: "file-1",
            owner_id: "user-1",
            notebook_id: "notebook-1",
            document_version: 7,
            context_profile_json: JSON.stringify({ subject: "语文" }),
          }],
          rowsAffected: 1,
        };
      },
      batch: async () => [],
    } as unknown as SqlDatabase;
    const store = new D1LessonWorkspaceStore(database);

    await expect(store.getLessonFileContext("user-1", "file-1")).resolves.toMatchObject({
      id: "file-1",
      documentVersion: 7,
      contextProfile: { subject: "语文" },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).not.toContain("document_json");
  });

  it("creates the file, invariants, and initial generation intent in one batch", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT request_fingerprint")) return { rows: [], rowsAffected: 0 };
        if (statement.sql.startsWith("SELECT id, owner_id, title")) return { rows: [notebookRow], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1LessonWorkspaceStore(database, () => "2026-08-24T00:00:00.000Z");

    await expect(store.createLessonFile("user-1", {
      notebookId: "notebook-1",
      title: "新课",
      type: "教案",
      document: plan,
      pageCount: 1,
      initialAgentPrompt: "请依据当前信息生成完整教案。",
    }, "11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ documentVersion: 0, title: "新课" });

    const statements = batches[0] ?? [];
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO lesson_files"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO lesson_file_versions"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO lesson_design_bases"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO lesson_generation_intents"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("operation_idempotency"))).toBe(true);
  });

  it("uses a version predicate and writes immutable history after a successful document save", async () => {
    const batches: SqlStatement[][] = [];
    const queries: SqlStatement[] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        if (statement.sql.startsWith("SELECT request_fingerprint")) return { rows: [], rowsAffected: 0 };
        if (statement.sql.startsWith("UPDATE lesson_files SET document_json")) return { rows: [], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [row], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => { batches.push(statements); return statements.map(() => ({ rows: [row], rowsAffected: 1 })); },
    } as unknown as SqlDatabase;
    const store = new D1LessonWorkspaceStore(database, () => "2026-08-24T00:00:00.000Z");
    await expect(store.saveLessonDocument({ ownerId: "user-1", fileId: "file-1", baseVersion: 0, document: plan, pageCount: 1, source: "manual", idempotencyKey: "save-1" }))
      .resolves.toMatchObject({ id: "file-1", documentVersion: 1 });
    expect(batches[0]?.[0]?.sql)
      .toContain("document_version = ?");
    expect(batches[0]?.[1]?.sql).toContain("lesson_file_versions");
    expect(batches[0]?.[2]?.sql).toContain("operation_idempotency");
  });
});

const notebookRow = {
  id: "notebook-1",
  owner_id: "user-1",
  title: "备课本",
  class_name: "一班",
  year: "2026",
  subject: "语文",
  stage: "初中",
  grade: "七年级",
  edition: "人教版",
  tone: "teal",
  updated_at: "2026-08-24T00:00:00.000Z",
};
