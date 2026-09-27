import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D1LessonWorkspaceStore } from "./d1-workspace-store.js";
import { D1AgentRuntimeStore } from "./d1-agent-runtime-store.js";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

const plan = { unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标", knowledgePoints: "", continuity: "", focus: "重点", preparation: "准备", process: "过程", assessment: "评价", homework: "作业", board: "板书", reflection: "反思" };

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../../d1/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const id of ["owner", "other"]) db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run(id, id);
  let failAt = -1;
  const execute = (s: SqlStatement) => {
    const prepared = db.prepare(s.sql);
    const rows = prepared.columns().length ? prepared.all(...s.params ?? []) : [];
    const rowsAffected = prepared.columns().length
      ? Number((db.prepare("SELECT changes() AS n").get()!).n)
      : Number(prepared.run(...s.params ?? []).changes);
    return { rows, rowsAffected };
  };
  const port = {
    query: async (s: SqlStatement) => execute(s),
    batch: async (ss: SqlStatement[]) => {
      db.exec("BEGIN");
      try {
        const result = ss.map((s, i) => { if (i === failAt) throw new Error("injected_failure"); return execute(s); });
        db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as SqlDatabase;
  return { db, port, fail: (index: number) => { failAt = index; } };
}

describe("D1 transaction integrity with actual SQLite migrations", () => {
  it("fences continuation attempts with the run lease and preserves cancellation across replay", async () => {
    const { db, port, fail } = database();
    let now = "2026-09-27T00:00:00.000Z";
    const clock = () => now;
    try {
      const workspace = new D1LessonWorkspaceStore(port, clock);
      const runtime = new D1AgentRuntimeStore(port, clock);
      const approvals = new D1AgentApprovalStore(port, clock);
      const book = await workspace.createNotebook("owner", { title: "book", className: "A", year: "2026", subject: "math", tone: "teal" });
      const file = await workspace.createLessonFile("owner", { notebookId: book.id, title: "lesson", type: "教案", document: plan, pageCount: 1 });
      const { thread, branch } = await runtime.createThread("owner", { notebookId: book.id, lessonFileId: file.id });
      const run = { id: "resume", ownerId: "owner", threadId: thread.id, branchId: branch.id, model: "test", status: "failed" as const, startedAt: now };
      await runtime.createRun(run);
      await approvals.saveApproval({ id: "approval", ownerId: "owner", runId: run.id, threadId: thread.id, branchId: branch.id,
        state: "approved", continuationStatus: "ready", encryptedRunState: "test", agentDefinitionVersion: "pi",
        patch: { fileId: file.id, baseDocumentVersion: 0, summary: "test", operations: [] }, createdAt: now, expiresAt: "2026-09-28T00:00:00.000Z" });
      const claim = { ownerId: "owner", approvalId: "approval", leaseToken: "first", leaseExpiresAt: "2026-09-27T00:00:30.000Z" };
      fail(1);
      await expect(approvals.claimApprovalContinuation(claim)).rejects.toThrow("injected_failure");
      expect(await approvals.getApproval("owner", "approval")).toMatchObject({ continuationStatus: "ready" });
      expect(await runtime.getRun("owner", run.id)).toMatchObject({ status: "failed" });
      fail(-1);
      await runtime.createRun({ ...run, id: "other", status: "running" });
      await expect(approvals.claimApprovalContinuation(claim)).rejects.toThrow("active_run_exists");
      expect(await approvals.getApproval("owner", "approval")).toMatchObject({ continuationStatus: "ready" });
      await runtime.updateRun("owner", "other", { status: "completed" });
      await approvals.claimApprovalContinuation(claim);
      expect(await runtime.getThread("owner", thread.id)).toMatchObject({ status: "running" });
      await expect(runtime.createRun({ ...run, id: "new", status: "queued" })).rejects.toThrow("active_run_exists");
      await runtime.heartbeatRun({ ownerId: "owner", runId: run.id, leaseToken: "first", leaseExpiresAt: "2026-09-27T00:01:00.000Z" });
      expect(await approvals.getApproval("owner", "approval")).toMatchObject({ continuationLeaseExpiresAt: "2026-09-27T00:01:00.000Z" });
      now = "2026-09-27T00:01:01.000Z";
      await runtime.recoverExpiredRuns("owner", thread.id);
      expect(await approvals.getApproval("owner", "approval")).toMatchObject({ continuationStatus: "ready" });
      await approvals.claimApprovalContinuation({ ...claim, leaseToken: "second", leaseExpiresAt: "2026-09-27T00:02:00.000Z" });
      await expect(approvals.settleApprovalContinuation({ ownerId: "owner", approvalId: "approval", leaseToken: "first", outcome: "completed" })).rejects.toThrow("approval_lease_lost");
      expect(await runtime.requestRunCancellation("owner", run.id)).toBe(true);
      await expect(approvals.settleApprovalContinuation({ ownerId: "owner", approvalId: "approval", leaseToken: "second", outcome: "completed" })).rejects.toThrow("approval_lease_lost");
      fail(1);
      await expect(approvals.settleApprovalContinuation({ ownerId: "owner", approvalId: "approval", leaseToken: "second", outcome: "cancelled" })).rejects.toThrow("injected_failure");
      expect(await approvals.getApproval("owner", "approval")).toMatchObject({ continuationStatus: "running", continuationLeaseToken: "second" });
      expect(await runtime.getRun("owner", run.id)).toMatchObject({ status: "running" });
      fail(-1);
      await approvals.settleApprovalContinuation({ ownerId: "owner", approvalId: "approval", leaseToken: "second", outcome: "cancelled", assistantMessageId: "not-created" });
      expect(await runtime.getThread("owner", thread.id)).toMatchObject({ status: "idle" });
      await approvals.settleApprovalContinuation({ ownerId: "owner", approvalId: "approval", leaseToken: "first", outcome: "completed" });
      expect(await runtime.getRun("owner", run.id)).toMatchObject({ status: "cancelled" });
    } finally { db.close(); }
  });
  it("rejects cross-owner import atomically, including earlier items in the batch", async () => {
    const { db, port } = database();
    try {
      const store = new D1LessonWorkspaceStore(port);
      const book = await store.createNotebook("owner", { title: "original", className: "A", year: "2026", subject: "math", tone: "teal" });
      const imported = { title: "changed", className: "B", year: "2026", subject: "math", files: [] };
      await expect(store.importNotebookGraph("other", [{ ...imported, id: "new" }, { ...imported, id: book.id }])).rejects.toThrow();
      expect(await store.getNotebook("owner", book.id)).toMatchObject({ title: "original" });
      expect(await store.getNotebook("other", "new")).toBeNull();
      await store.importNotebookGraph("owner", [{ ...imported, id: book.id }]);
      expect(await store.getNotebook("owner", book.id)).toMatchObject({ title: "changed" });
    } finally { db.close(); }
  });

  it("rolls back failed saves and replays concurrent identical saves without duplicating history", async () => {
    const { db, port, fail } = database();
    try {
      const store = new D1LessonWorkspaceStore(port);
      const book = await store.createNotebook("owner", { title: "book", className: "A", year: "2026", subject: "math", tone: "teal" });
      const file = await store.createLessonFile("owner", { notebookId: book.id, title: "lesson", type: "教案", document: plan, pageCount: 1 });
      const args = { ownerId: "owner", fileId: file.id, baseVersion: 0, document: { ...plan, topic: "changed" }, pageCount: 1, source: "manual" as const, idempotencyKey: "save" };
      fail(2);
      await expect(store.saveLessonDocument(args)).rejects.toThrow("injected_failure");
      expect(await store.getLessonFile("owner", file.id)).toMatchObject({ documentVersion: 0, document: plan });
      fail(-1);
      const saved = await Promise.all([store.saveLessonDocument(args), store.saveLessonDocument(args)]);
      expect(saved.map(s => s.documentVersion)).toEqual([1, 1]);
      expect(saved[1]).toEqual(saved[0]);
      expect(db.prepare("SELECT count(*) AS n FROM lesson_file_versions WHERE lesson_file_id = ?").get(file.id)?.n).toBe(2);
      await expect(store.saveLessonDocument({ ...args, idempotencyKey: "stale" })).rejects.toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM operation_idempotency WHERE operation = 'save_lesson_document'").get()?.n).toBe(1);
    } finally { db.close(); }
  });

  it("validates framework ownership and notebook before writing framework threads", async () => {
    const queries: SqlStatement[] = [];
    const batches: SqlStatement[][] = [];
    const port = { query: async (s: SqlStatement) => { queries.push(s); return { rows: s.sql.includes("FROM semester_frameworks") && s.params?.[0] === "owner" && s.params?.[1] === "book" ? [{ id: "framework" }] : [], rowsAffected: 0 }; }, batch: async (ss: SqlStatement[]) => { batches.push(ss); return []; } } as SqlDatabase;
    const runtime = new D1AgentRuntimeStore(port);
    const input = { notebookId: "book", resourceType: "semester_framework" as const, semesterFrameworkId: "framework" };
    const result = await runtime.createThread("owner", input, "11111111-1111-4111-8111-111111111111");
    expect(result.thread).toMatchObject(input);
    expect(batches[0]?.[0]?.params?.slice(3, 6)).toEqual(["semester_framework", null, "framework"]);
    await expect(runtime.createThread("other", input)).rejects.toThrow("semester_framework_not_found");
    await expect(runtime.createThread("owner", { ...input, notebookId: "wrong" })).rejects.toThrow("semester_framework_not_found");
    expect(batches).toHaveLength(1);
  });
});
