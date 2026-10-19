import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { lessonPlanSchema, type AgentPendingInteraction } from "../domain.js";
import type { BindPresentationThemeInput, LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { createD1LessonCoreRepository } from "./d1-lesson-core-repository.js";
import { MemoryLessonRepository } from "./memory-repository.js";

const ownerId = "theme-owner";
const document = lessonPlanSchema.parse({ ...Object.fromEntries([
  "unit", "period", "totalPeriods", "objectives", "focus", "preparation", "assessment", "homework", "board", "reflection",
].map(field => [field, "教案内容"])), topic: "春", process: "比较两份回答并解释表达效果" });

async function fixture(kind: "memory" | "sqlite", missingExpiry = false) {
  let db: DatabaseSync | undefined;
  let repository: LessonRepository;
  let beforeBind: (() => Promise<void>) | undefined;
  const bindingStatements: SqlStatement[] = [];
  if (kind === "sqlite") {
    db = new DatabaseSync(":memory:");
    const migrations = new URL("../../d1/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run(ownerId, "theme-teacher");
    const execute = (statement: SqlStatement) => {
      const prepared = db!.prepare(statement.sql);
      return prepared.columns().length
        ? { rows: prepared.all(...statement.params ?? []), rowsAffected: 0 }
        : { rows: [], rowsAffected: Number(prepared.run(...statement.params ?? []).changes) };
    };
    const port = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("UPDATE agent_branches") && statement.sql.includes("JOIN agent_threads")) {
          bindingStatements.push(statement);
          const hook = beforeBind;
          beforeBind = undefined;
          await hook?.();
        }
        return execute(statement);
      },
      batch: async (statements: SqlStatement[]) => {
        db!.exec("BEGIN");
        try { const results = statements.map(execute); db!.exec("COMMIT"); return results; }
        catch (error) { db!.exec("ROLLBACK"); throw error; }
      },
    } as SqlDatabase;
    repository = createD1LessonCoreRepository(port);
  } else repository = new MemoryLessonRepository();
  const notebook = await repository.createNotebook(ownerId, { title: "语文", className: "一班", year: "2026", subject: "语文", tone: "teal" });
  const file = await repository.createLessonFile(ownerId, { notebookId: notebook.id, title: "春", type: "教案", document, pageCount: 1 });
  const { thread, branch } = await repository.createThread(ownerId, { notebookId: notebook.id, lessonFileId: file.id });
  const run = await repository.createRun({ id: crypto.randomUUID(), ownerId, threadId: thread.id, branchId: branch.id,
    model: "configured-model", status: "running", leaseToken: "theme-lease",
    ...(!missingExpiry ? { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } : {}) });
  const expectedPending: AgentPendingInteraction = {
    kind: "presentation_generation", originalRequest: "为这节课准备课堂演示", documentVersion: 0,
    resourceId: file.id, requestedAt: "2026-10-19T04:00:00.000Z", resumeReferenceRequired: false,
  };
  await repository.updateBranch(ownerId, thread.id, branch.id, { pendingInteraction: expectedPending });
  const input: BindPresentationThemeInput = { ownerId, threadId: thread.id, branchId: branch.id, runId: run.id,
    leaseToken: "theme-lease", fileId: file.id, documentVersion: 0, expectedPending, theme: "theme09" };
  const pending = async () => (await repository.getBranch(ownerId, thread.id, branch.id))!.pendingInteraction;
  return { repository, input, pending, file, thread, branch, run, db, bindingStatements,
    beforeBind: (hook: () => Promise<void>) => { beforeBind = hook; } };
}

for (const kind of ["memory", "sqlite"] as const) describe(`${kind} atomic presentation theme binding`, () => {
  it("binds only the exact pending generation and preserves the rest of its task", async () => {
    const f = await fixture(kind);
    try {
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(true);
      expect(await f.pending()).toEqual({ ...f.input.expectedPending, confirmedTheme: "theme09" });
      expect((await f.repository.getRun(ownerId, f.run.id))!.status).toBe("running");
      expect((await f.repository.getLessonFile(ownerId, f.file.id))!.document).toEqual(document);
      if (kind === "sqlite") expect(f.bindingStatements).toHaveLength(1);
    } finally { f.db?.close(); }
  });

  it("allows only one competing initial theme and never overwrites the winner", async () => {
    const f = await fixture(kind);
    try {
      const outcomes = await Promise.all([
        f.repository.bindPresentationTheme(f.input),
        f.repository.bindPresentationTheme({ ...f.input, theme: "theme03" }),
      ]);
      expect(outcomes).toEqual([true, false]);
      expect((await f.pending())!.confirmedTheme).toBe("theme09");
    } finally { f.db?.close(); }
  });

  it("rejects a stale pending snapshot without replacing a newly requested task", async () => {
    const f = await fixture(kind);
    try {
      const replacement = { ...f.input.expectedPending, originalRequest: "改为复习课演示", requestedAt: "2026-10-19T04:01:00.000Z" };
      await f.repository.updateBranch(ownerId, f.thread.id, f.branch.id, { pendingInteraction: replacement });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(replacement);
    } finally { f.db?.close(); }
  });

  it("rejects cancelled work even while the run is still running", async () => {
    const f = await fixture(kind);
    try {
      expect(await f.repository.requestRunCancellation(ownerId, f.run.id)).toBe(true);
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it.each(["queued", "completed", "cancelled", "failed", "awaiting_approval"] as const)("rejects a %s run", async status => {
    const f = await fixture(kind);
    try {
      await f.repository.updateRun(ownerId, f.run.id, { status });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it.each(["changed-token", "expired", "missing-expiry"] as const)("rejects %s leases", async change => {
    const f = await fixture(kind, change === "missing-expiry");
    try {
      if (change !== "missing-expiry") await f.repository.updateRun(ownerId, f.run.id, change === "changed-token" ? { leaseToken: "new-lease" }
        : { leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it("rejects a changed canonical document version", async () => {
    const f = await fixture(kind);
    try {
      await f.repository.saveLessonDocument({ ownerId, fileId: f.file.id, baseVersion: 0,
        document: { ...document, process: "教师已修改课堂流程" }, pageCount: 1, source: "manual", idempotencyKey: "theme-document-change" });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it.each(["ownerId", "threadId", "branchId", "runId", "fileId", "leaseToken"] as const)("rejects the wrong %s scope", async field => {
    const f = await fixture(kind);
    try {
      expect(await f.repository.bindPresentationTheme({ ...f.input, [field]: "other" })).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it("rejects a live run from a different branch", async () => {
    const f = await fixture(kind);
    try {
      await f.repository.updateRun(ownerId, f.run.id, { status: "completed" });
      const other = await f.repository.createBranch(ownerId, f.thread.id);
      const run = await f.repository.createRun({ ...f.run, id: crypto.randomUUID(), branchId: other.id });
      expect(await f.repository.bindPresentationTheme({ ...f.input, runId: run.id })).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it("rejects a real active run owned by a different thread", async () => {
    const f = await fixture(kind);
    try {
      const other = await f.repository.createThread(ownerId, { notebookId: f.file.notebookId, lessonFileId: f.file.id });
      const run = await f.repository.createRun({ ...f.run, id: crypto.randomUUID(), threadId: other.thread.id, branchId: other.branch.id });
      expect(await f.repository.bindPresentationTheme({ ...f.input, runId: run.id })).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it("rejects an existing file that is not the thread's canonical lesson", async () => {
    const f = await fixture(kind);
    try {
      const other = await f.repository.createLessonFile(ownerId, { notebookId: f.file.notebookId, title: "另一课", type: "教案", document, pageCount: 1 });
      const pending = { ...f.input.expectedPending, resourceId: other.id };
      await f.repository.updateBranch(ownerId, f.thread.id, f.branch.id, { pendingInteraction: pending });
      expect(await f.repository.bindPresentationTheme({ ...f.input, fileId: other.id, expectedPending: pending })).toBe(false);
      expect(await f.pending()).toEqual(pending);
    } finally { f.db?.close(); }
  });

  it("rejects a deleted thread even while its run lease is active", async () => {
    const f = await fixture(kind);
    try {
      await f.repository.updateThread(ownerId, f.thread.id, { deletedAt: new Date().toISOString() });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(await f.pending()).toEqual(f.input.expectedPending);
    } finally { f.db?.close(); }
  });

  it("cannot change an already confirmed theme, but accepts its matching snapshot idempotently", async () => {
    const f = await fixture(kind);
    try {
      const bound = { ...f.input.expectedPending, confirmedTheme: "theme03" };
      await f.repository.updateBranch(ownerId, f.thread.id, f.branch.id, { pendingInteraction: bound });
      expect(await f.repository.bindPresentationTheme({ ...f.input, expectedPending: bound })).toBe(false);
      expect(await f.pending()).toEqual(bound);
      expect(await f.repository.bindPresentationTheme({ ...f.input, expectedPending: bound, theme: "theme03" })).toBe(true);
      expect(await f.pending()).toEqual(bound);
    } finally { f.db?.close(); }
  });

  it.each([
    { kind: "presentation_theme" }, { resourceId: undefined }, { resourceId: "other-file" }, { documentVersion: 1 },
  ])("rejects an incorrectly scoped task %j", async patch => {
    const f = await fixture(kind);
    try {
      const expected = { ...f.input.expectedPending, ...patch } as AgentPendingInteraction;
      await f.repository.updateBranch(ownerId, f.thread.id, f.branch.id, { pendingInteraction: expected });
      expect(await f.repository.bindPresentationTheme({ ...f.input, expectedPending: expected })).toBe(false);
      expect(await f.pending()).toEqual(expected);
    } finally { f.db?.close(); }
  });
});

describe("SQLite theme binding submission races", () => {
  it.each(["cancellation", "document-version", "task-replacement", "lease-replacement"] as const)("rechecks %s inside the UPDATE, after the caller prepared its request", async mutation => {
    const f = await fixture("sqlite");
    try {
      let replacement: AgentPendingInteraction | undefined;
      f.beforeBind(async () => {
        if (mutation === "cancellation") await f.repository.requestRunCancellation(ownerId, f.run.id);
        if (mutation === "document-version") await f.repository.saveLessonDocument({ ownerId, fileId: f.file.id, baseVersion: 0,
          document: { ...document, process: "new" }, pageCount: 1, source: "manual", idempotencyKey: "theme-race-save" });
        if (mutation === "task-replacement") {
          replacement = { ...f.input.expectedPending, requestedAt: "2026-10-19T04:02:00.000Z" };
          await f.repository.updateBranch(ownerId, f.thread.id, f.branch.id, { pendingInteraction: replacement });
        }
        if (mutation === "lease-replacement") await f.repository.updateRun(ownerId, f.run.id, { leaseToken: "new-lease" });
      });
      expect(await f.repository.bindPresentationTheme(f.input)).toBe(false);
      expect(f.bindingStatements).toHaveLength(1);
      expect(await f.pending()).toEqual(replacement ?? f.input.expectedPending);
    } finally { f.db?.close(); }
  });
});

it("Memory theme binding does not yield to asynchronous readers before replacing the Map value", async () => {
  const f = await fixture("memory");
  const read = vi.spyOn(f.repository, "getRun").mockRejectedValue(new Error("must_not_read_async"));
  const binding = f.repository.bindPresentationTheme(f.input);
  const cancelling = f.repository.requestRunCancellation(ownerId, f.run.id);
  expect(await binding).toBe(true);
  expect(await cancelling).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect((await f.pending())!.confirmedTheme).toBe("theme09");
});
