import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createD1LessonCoreRepository } from "./d1-lesson-core-repository.js";
import { MemoryLessonRepository } from "./memory-repository.js";
import { lessonPlanSchema } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { D1AgentRuntimeStore } from "./d1-agent-runtime-store.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1AgentRuntimeStore", () => {
  it("scopes a run heartbeat by owner, lease token, active status, and expiry", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [runRow], rowsAffected: 1 }; }, batch: async (statements: SqlStatement[]) => { queries.push(...statements); return statements.map(() => ({ rows: [], rowsAffected: 1 })); } } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.heartbeatRun({ ownerId: "owner-1", runId: "run-1", leaseToken: "lease-1", leaseExpiresAt: "2026-08-24T00:05:00.000Z" });
    const statement = queries[0]!;
    expect(statement.sql).toContain("lease_token = ?");
    expect(statement.sql).toContain("lease_expires_at > ?");
    expect(statement.params).toContain("owner-1");
    expect(statement.params).toContain("lease-1");
  });

  it("inserts the first Pi protocol prefix as sequence rows without storing the blob on the header", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT revision FROM agent_runtime_sessions")) return { rows: [], rowsAffected: 0 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    const saved = await store.saveAgentRuntimeSession({
      ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1", runtime: "pi",
      expectedRevision: 0, messages: [{ role: "user" }, { role: "assistant" }],
    });
    expect(saved).toMatchObject({ revision: 1, messages: [{ role: "user" }, { role: "assistant" }] });
    expect(batches[0]?.[0]?.sql).toContain("INSERT INTO agent_runtime_sessions");
    expect(batches[0]?.[0]?.sql).toContain("'[]'");
    expect(batches[0]?.filter((statement) => statement.sql.includes("agent_runtime_session_messages"))).toHaveLength(2);
    expect(batches[0]?.some((statement) => statement.params?.includes(JSON.stringify([{ role: "user" }, { role: "assistant" }])))).toBe(false);
  });

  it("appends only new Pi protocol rows under the existing revision CAS", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT revision FROM agent_runtime_sessions")) {
          return { rows: [{ revision: 3 }], rowsAffected: 1 };
        }
        if (statement.sql.includes("COUNT(*)")) return { rows: [{ total: 1 }], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await expect(store.saveAgentRuntimeSession({
      ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1", runtime: "pi",
      expectedRevision: 3, messages: [{ role: "user" }, { role: "assistant" }],
    })).resolves.toMatchObject({ revision: 4 });
    const statements = batches[0] ?? [];
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT INTO agent_runtime_session_messages");
    expect(statements[0]?.sql).toContain("FROM agent_runtime_sessions");
    expect(statements[0]?.params).toContain(JSON.stringify({ role: "assistant" }));
    expect(statements[0]?.params).not.toContain(JSON.stringify({ role: "user" }));
    expect(statements[1]?.sql).toContain("UPDATE agent_runtime_sessions");
    expect(statements[1]?.sql).toContain("revision = ?");
    expect(statements[1]?.sql).toContain("messages_json = '[]'");
  });

  it("truncates repaired Pi protocol rows without rewriting the kept prefix", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT revision FROM agent_runtime_sessions")) {
          return { rows: [{ revision: 5 }], rowsAffected: 1 };
        }
        if (statement.sql.includes("COUNT(*)")) return { rows: [{ total: 4 }], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.saveAgentRuntimeSession({
      ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1", runtime: "pi",
      expectedRevision: 5, messages: [{ role: "user" }, { role: "assistant" }],
    });
    const statements = batches[0] ?? [];
    expect(statements[0]?.sql).toContain("DELETE FROM agent_runtime_session_messages");
    expect(statements[0]?.params).toContain(2);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO agent_runtime_session_messages"))).toBe(false);
    expect(statements.at(-1)?.sql).toContain("UPDATE agent_runtime_sessions");
  });

  it("rewrites a same-length Pi protocol suffix from the first changed row", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT revision FROM agent_runtime_sessions")) {
          return { rows: [{ revision: 2 }], rowsAffected: 1 };
        }
        if (statement.sql.includes("COUNT(*)")) return { rows: [{ total: 3 }], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.saveAgentRuntimeSession({
      ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1", runtime: "pi",
      expectedRevision: 2,
      rewriteFrom: 2,
      messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult", error: "approval_not_persisted" }],
    });
    const statements = batches[0] ?? [];
    expect(statements[0]?.sql).toContain("DELETE FROM agent_runtime_session_messages");
    expect(statements[0]?.params).toContain(2);
    expect(statements[1]?.sql).toContain("INSERT INTO agent_runtime_session_messages");
    expect(statements[1]?.params).toContain(JSON.stringify({ role: "toolResult", error: "approval_not_persisted" }));
    expect(statements.some((statement) => statement.params?.includes(JSON.stringify({ role: "user" })))).toBe(false);
  });

  it("reconstructs a Pi session from sequence rows and falls back to the legacy blob", async () => {
    const storeFromRows = new D1AgentRuntimeStore({
      query: async () => ({ rows: [], rowsAffected: 0 }),
      batch: async () => [
        { rows: [runtimeRow], rowsAffected: 1 },
        {
          rows: [{ message_json: JSON.stringify({ role: "user" }) }, { message_json: JSON.stringify({ role: "assistant" }) }],
          rowsAffected: 2,
        },
      ],
    } as unknown as SqlDatabase, () => "2026-08-24T00:00:00.000Z");
    await expect(storeFromRows.getAgentRuntimeSession("owner-1", "thread-1", "branch-1", "pi"))
      .resolves.toMatchObject({ messages: [{ role: "user" }, { role: "assistant" }] });

    const storeFromBlob = new D1AgentRuntimeStore({
      query: async () => ({ rows: [], rowsAffected: 0 }),
      batch: async () => [
        {
          rows: [{ ...runtimeRow, messages_json: JSON.stringify([{ role: "user" }]) }],
          rowsAffected: 1,
        },
        { rows: [], rowsAffected: 0 },
      ],
    } as unknown as SqlDatabase, () => "2026-08-24T00:00:00.000Z");
    await expect(storeFromBlob.getAgentRuntimeSession("owner-1", "thread-1", "branch-1", "pi"))
      .resolves.toMatchObject({ messages: [{ role: "user" }] });
  });

  it("rejects a Pi session write when the CAS revision does not match", async () => {
    const store = new D1AgentRuntimeStore({
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        if (statement.sql.startsWith("SELECT revision FROM agent_runtime_sessions")) {
          return { rows: [{ revision: 4 }], rowsAffected: 1 };
        }
        return { rows: [], rowsAffected: 0 };
      },
      batch: async () => [],
    } as unknown as SqlDatabase, () => "2026-08-24T00:00:00.000Z");
    await expect(store.saveAgentRuntimeSession({
      ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1", runtime: "pi",
      expectedRevision: 3, messages: [{ role: "user" }],
    })).rejects.toThrow("agent_runtime_session_conflict");
  });

  it("records a session append idempotency key in the same batch as its items", async () => {
    const batches: SqlStatement[][] = [];
    const database = { query: async (statement: SqlStatement) => {
      if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
      if (statement.sql.startsWith("SELECT payload_json")) return { rows: [], rowsAffected: 0 };
      if (statement.sql.startsWith("SELECT COUNT")) return { rows: [{ total: 4 }], rowsAffected: 1 };
      return { rows: [], rowsAffected: 0 };
    }, batch: async (statements: SqlStatement[]) => { batches.push(statements); return []; } } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.addSessionItems("owner-1", "thread-1", "branch-1", [{ role: "user" }], "append-1");
    expect(batches[0]?.some((statement) => statement.sql.includes("agent_session_append_batches"))).toBe(true);
  });

  it("commits an accepted run and its visible message pair before runtime startup", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    const createdAt = "2026-08-24T00:00:00.000Z";

    await store.createRunWithInitialMessages({
      run: {
        id: "run-1", ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1",
        generationIntentId: "11111111-1111-4111-8111-111111111111",
        userMessageId: "user-message-1", assistantMessageId: "assistant-message-1",
        model: "test", status: "queued", startedAt: createdAt,
      },
      userMessage: {
        id: "user-message-1", ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1",
        role: "user", content: "生成教案", status: "completed", createdAt,
      },
      assistantMessage: {
        id: "assistant-message-1", ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1",
        role: "assistant", content: "", status: "streaming", createdAt,
      },
    });

    const statements = batches[0] ?? [];
    expect(statements).toHaveLength(4);
    expect(statements[0]?.sql).toContain("user_message_id");
    expect(statements[0]?.sql).toContain("generation_intent_id");
    expect(statements[0]?.params).toContain("11111111-1111-4111-8111-111111111111");
    expect(statements.filter((statement) => statement.sql.includes("INSERT INTO agent_messages"))).toHaveLength(2);
    expect(statements.at(-1)?.sql).toContain("UPDATE agent_threads SET status = 'running'");
  });

  it("settles run, assistant message, and derived thread state in one repairable batch", async () => {
    const batches: SqlStatement[][] = [];
    const terminalRun = {
      ...runRow,
      assistant_message_id: "assistant-message-1",
      status: "completed",
      lease_token: null,
      lease_expires_at: null,
      completed_at: "2026-08-24T00:00:00.000Z",
    };
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.includes("FROM agent_runs")) return { rows: [terminalRun], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:01.000Z");

    await store.settleRun({
      ownerId: "owner-1",
      runId: "run-1",
      leaseToken: "lease-1",
      status: "completed",
      messageStatus: "completed",
      messageContent: "完成",
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]?.[0]?.sql).toContain("OR (status = ? AND lease_token IS NULL)");
    expect(batches[0]?.[1]?.sql).toContain("EXISTS");
    expect(batches[0]?.[2]?.sql).toContain("WHEN EXISTS");
  });

  it("uses a monotonic per-run sequence as the event journal cursor", async () => {
    const queries: SqlStatement[] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        return statement.sql.startsWith("SELECT data_json")
          ? { rows: [{ data_json: JSON.stringify({ type: "run.started", runId: "run-1" }) }], rowsAffected: 1 }
          : { rows: [], rowsAffected: 1 };
      },
      batch: async () => [],
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");

    await store.appendRunEvent("owner-1", "run-1", "run.started", { type: "run.started", runId: "run-1" });
    await store.listRunEvents("owner-1", "run-1");

    expect(queries[0]?.sql).toContain("MAX(sequence_no)");
    expect(queries[0]?.sql).toContain("sequence_no");
    expect(queries[1]?.sql).toContain("ORDER BY sequence_no");
    expect(queries[1]?.sql).not.toContain("ORDER BY created_at, id");
  });

  it("normalizes the database active-run invariant to the public conflict code", async () => {
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT id, owner_id")) return { rows: [branchRow], rowsAffected: 1 };
        throw new Error("UNIQUE constraint failed: agent_runs.owner_id, agent_runs.thread_id");
      },
      batch: async () => [],
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database);
    await expect(store.createRun({
      id: "run-2", ownerId: "owner-1", threadId: "thread-1", branchId: "branch-1",
      model: "test", status: "queued",
    })).rejects.toThrow("active_run_exists");
  });

  it("recovers an expired run with a pending approval as awaiting_approval and clears the lease", async () => {
    const queries: SqlStatement[] = [];
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        queries.push(statement);
        if (statement.sql.startsWith("SELECT") && statement.sql.includes("FROM agent_runs")) {
          return {
            rows: [{ ...runRow, lease_expires_at: "2026-08-23T23:00:00.000Z" }],
            rowsAffected: 1,
          };
        }
        if (statement.sql.includes("FROM agent_approvals")) {
          return { rows: [{ id: "approval-1" }], rowsAffected: 1 };
        }
        if (statement.sql.startsWith("SELECT") && statement.sql.includes("FROM agent_threads")) {
          return { rows: [threadRow], rowsAffected: 1 };
        }
        return { rows: [], rowsAffected: 1 };
      },
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    } as unknown as SqlDatabase;
    const store = new D1AgentRuntimeStore(database, () => "2026-08-24T00:00:00.000Z");
    await expect(store.recoverExpiredRuns("owner-1", "thread-1")).resolves.toBe(1);
    expect(queries.filter((statement) => statement.sql.includes("agent_approvals"))).toHaveLength(0);
    expect(batches).toHaveLength(1);
    const runUpdate = batches[0]?.find((statement) => statement.sql.startsWith("UPDATE agent_runs"));
    expect(runUpdate?.sql).toContain("lease_token = NULL");
    expect(runUpdate?.sql).toContain("state = 'pending'");
    expect(runUpdate?.sql).toContain("THEN 'awaiting_approval'");
    const threadUpdate = batches[0]?.find((statement) => statement.sql.startsWith("UPDATE agent_threads"));
    expect(threadUpdate?.sql).toContain("WHEN EXISTS");
  });
});

const branchRow = { id: "branch-1", owner_id: "owner-1", thread_id: "thread-1", parent_branch_id: null, forked_from_message_id: null, label: "主分支", pending_interaction_json: null, created_at: "2026-08-24T00:00:00.000Z" };
const threadRow = {
  id: "thread-1", owner_id: "owner-1", notebook_id: "nb-1", resource_type: "lesson_file",
  lesson_file_id: "file-1", semester_framework_id: null, title: "会话", status: "running",
  starter_suggestions_json: "[]", starter_suggestions_document_version: null,
  starter_suggestions_resource_version: null, archived_at: null, deleted_at: null,
  created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z",
};
const runtimeRow = { owner_id: "owner-1", thread_id: "thread-1", branch_id: "branch-1", runtime: "pi", revision: 4, messages_json: "[]", updated_at: "2026-08-24T00:00:00.000Z" };
const runRow = { id: "run-1", owner_id: "owner-1", thread_id: "thread-1", branch_id: "branch-1", assistant_message_id: null, model: "test", status: "running", capability_plan_json: null, agent_definition_version: null, skill_versions_json: "{}", attachment_source_ids_json: "[]", token_usage_json: "{}", provider_cost: null, error: null, lease_token: "lease-1", lease_expires_at: "2026-08-24T00:05:00.000Z", heartbeat_at: "2026-08-24T00:00:00.000Z", cancel_requested_at: null, started_at: "2026-08-24T00:00:00.000Z", completed_at: null };


async function settlementFixture(kind: "sqlite" | "memory") {
  let db: DatabaseSync | undefined;
  let repository: LessonRepository;
  let beforeSettlement: (() => Promise<void>) | undefined;
  if (kind === "sqlite") {
    db = new DatabaseSync(":memory:");
    const migrations = new URL("../../d1/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
    db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run("owner-1", "teacher");
    const execute = (statement: SqlStatement) => {
      const prepared = db!.prepare(statement.sql);
      return prepared.columns().length
        ? { rows: prepared.all(...statement.params ?? []), rowsAffected: 0 }
        : { rows: [], rowsAffected: Number(prepared.run(...statement.params ?? []).changes) };
    };
    const sql = {
      query: async (statement: SqlStatement) => execute(statement),
      batch: async (statements: SqlStatement[]) => {
        if (statements.some(statement => statement.sql.includes("SET status = ?, token_usage_json"))) {
          const hook = beforeSettlement; beforeSettlement = undefined; await hook?.();
        }
        db!.exec("BEGIN");
        try { const results = statements.map(execute); db!.exec("COMMIT"); return results; }
        catch (error) { db!.exec("ROLLBACK"); throw error; }
      },
    } as SqlDatabase;
    repository = createD1LessonCoreRepository(sql);
  } else repository = new MemoryLessonRepository();
  const document = lessonPlanSchema.parse(Object.fromEntries(["unit", "period", "totalPeriods", "topic", "objectives", "focus", "preparation", "process", "assessment", "homework", "board", "reflection"].map(field => [field, "lesson text"])));
  const notebook = await repository.createNotebook("owner-1", { title: "语文", className: "一班", year: "2026", subject: "语文", tone: "teal" });
  const file = await repository.createLessonFile("owner-1", { notebookId: notebook.id, title: "课时", type: "教案", document, pageCount: 1 });
  const { thread, branch } = await repository.createThread("owner-1", { notebookId: notebook.id, resourceType: "lesson_file", lessonFileId: file.id });
  const message = await repository.appendMessage({ ownerId: "owner-1", threadId: thread.id, branchId: branch.id, role: "assistant", content: "partial", status: "streaming" });
  const run = await repository.createRun({ id: "race-run", ownerId: "owner-1", threadId: thread.id, branchId: branch.id, assistantMessageId: message.id,
    model: "test", status: "running", leaseToken: "race-lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  await repository.updateThread("owner-1", thread.id, { status: "running" });
  const settle = (status: "completed" | "cancelled" | "awaiting_approval" = "completed") => repository.settleRun({ ownerId: "owner-1", runId: run.id, leaseToken: "race-lease", status,
    messageStatus: status === "awaiting_approval" ? "completed" : status, messageContent: status });
  return { db, repository, run, thread, message, settle,
    beforeSettlement: (hook: () => Promise<void>) => { beforeSettlement = hook; } };
}

describe("SQLite settlement cancellation race", () => {
  for (const status of ["completed", "awaiting_approval"] as const) it(`rejects ${status} when cancellation commits after the settlement read`, async () => {
    const f = await settlementFixture("sqlite");
    try {
      let hookRan = false;
      f.beforeSettlement(async () => {
        // settleRun already captured the running row with a live lease and no cancellation.
        expect(await f.repository.requestRunCancellation("owner-1", f.run.id)).toBe(true);
        hookRan = true;
      });
      await expect(f.settle(status)).rejects.toThrow("run_cancel_requested");
      expect(hookRan).toBe(true);
      expect(await f.repository.getRun("owner-1", f.run.id)).toMatchObject({ status: "running", leaseToken: "race-lease", cancelRequestedAt: expect.any(String) });
      expect(await f.repository.getMessage("owner-1", f.message.id)).toMatchObject({ content: "partial", status: "streaming" });
      expect(await f.repository.getThread("owner-1", f.thread.id)).toMatchObject({ status: "running" });
      // Cancellation settlement still owns the valid lease; duplicate delivery is safe.
      await expect(f.settle("cancelled")).resolves.toMatchObject({ status: "cancelled" });
      await expect(f.settle("cancelled")).resolves.toMatchObject({ status: "cancelled" });
      expect(await f.repository.getMessage("owner-1", f.message.id)).toMatchObject({ content: "cancelled", status: "cancelled" });
    } finally { f.db?.close(); }
  });
});

for (const kind of ["sqlite", "memory"] as const) describe(`${kind} cancellation linearization`, () => {
  it("lets the first cancellation win without permitting a competing completion", async () => {
    const f = await settlementFixture(kind);
    try {
      const cancellation = f.repository.requestRunCancellation("owner-1", f.run.id);
      const completion = f.settle();
      expect(await cancellation).toBe(true);
      await expect(completion).rejects.toThrow("run_cancel_requested");
      await expect(f.settle("cancelled")).resolves.toMatchObject({ status: "cancelled" });
    } finally { f.db?.close(); }
  });

  it("keeps a completed run terminal when a later cancellation arrives and permits exact settlement replay", async () => {
    const f = await settlementFixture(kind);
    try {
      await expect(f.settle()).resolves.toMatchObject({ status: "completed" });
      expect(await f.repository.requestRunCancellation("owner-1", f.run.id)).toBe(false);
      await expect(f.settle()).resolves.toMatchObject({ status: "completed" });
      expect(await f.repository.getMessage("owner-1", f.message.id)).toMatchObject({ content: "completed", status: "completed" });
    } finally { f.db?.close(); }
  });
});
