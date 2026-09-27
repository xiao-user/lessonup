import { describe, expect, it } from "vitest";
import { D1KnowledgeSourceStore, MemoryKnowledgeSourceStore, type KnowledgeSourceRecord } from "./source-store.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

const source: KnowledgeSourceRecord = {
  id: "source-1", owner_id: "user-1", notebook_id: "notebook-1", lesson_file_id: "file-1",
  scope: "file", title: "观察记录", media_type: "text/markdown", storage_key: "user-1/source-1/source.md",
  source_version: 1, status: "queued", index_version: null, metadata: { bytes: 20 },
  upload_idempotency_key: "upload-key", attached_message_id: null, attempt_count: 0, max_attempts: 3,
  available_at: "2026-08-24T00:00:00.000Z", lease_expires_at: null, worker_id: null, last_error: null,
  created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z",
};

describe("D1KnowledgeSourceStore", () => {
  it("uses portable parameterized SQL to enqueue a source and its audit record", async () => {
    const batches: SqlStatement[][] = [];
    const database: SqlDatabase = {
      query: async () => ({ rows: [], rowsAffected: 0 }),
      batch: async (statements) => {
        batches.push(statements);
        return statements.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const store = new D1KnowledgeSourceStore(database);
    await expect(store.enqueue(source)).resolves.toEqual(source);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.sql).toContain("INSERT INTO knowledge_sources");
    expect(batches[0]?.[0]?.params).toContain("user-1");
    expect(batches[0]?.[0]?.sql).not.toContain("user-1");
    expect(batches[0]?.[1]?.sql).toContain("knowledge_audit_events");
  });

  it("fails closed when a worker no longer owns its D1 lease", async () => {
    const statements: SqlStatement[] = [];
    const database: SqlDatabase = {
      query: async (statement) => {
        statements.push(statement);
        return { rows: [], rowsAffected: 0 };
      },
      batch: async () => [],
    };
    const store = new D1KnowledgeSourceStore(database);
    await expect(store.heartbeat("source-1", "worker-1", "2026-08-24T00:00:00.000Z", "2026-08-24T00:15:00.000Z"))
      .rejects.toThrow("knowledge_worker_lease_lost");
    expect(statements[0]?.sql).toContain("worker_id = ?");
    expect(statements[0]?.params).toContain("worker-1");
  });
});

describe("MemoryKnowledgeSourceStore", () => {
  it("uses the same draft visibility contract as the durable store", async () => {
    const store = new MemoryKnowledgeSourceStore();
    await store.enqueue(source);
    expect(await store.list("user-1", { lessonFileId: "file-1" })).toHaveLength(1);

    await store.markAttached("user-1", "source-1", "message-1");
    expect(await store.list("user-1", { lessonFileId: "file-1" })).toHaveLength(0);
    expect(await store.list("user-1", { includeAttached: true })).toHaveLength(1);
  });
});
