import { describe, expect, it } from "vitest";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1AgentApprovalStore", () => {
  it("guards continuation claiming with the decision state and expired lease predicate", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [approvalRow], rowsAffected: 1 }; }, batch: async (statements: SqlStatement[]) => { queries.push(...statements); return statements.map(() => ({ rows: [], rowsAffected: 1 })); } } as unknown as SqlDatabase;
    const store = new D1AgentApprovalStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.claimApprovalContinuation({ ownerId: "owner-1", approvalId: "approval-1", leaseToken: "lease-1", leaseExpiresAt: "2026-08-24T00:05:00.000Z" });
    const statement = queries[1]!;
    expect(statement.sql).toContain("state IN ('approved', 'rejected')");
    expect(statement.sql).toContain("continuation_lease_expires_at <= ?");
  });

  it("persists the proposing tool call and keeps the insert shape consistent", async () => {
    const queries: SqlStatement[] = [];
    const database = { query: async (statement: SqlStatement) => { queries.push(statement); return { rows: [approvalRow], rowsAffected: 1 }; }, batch: async () => [] } as unknown as SqlDatabase;
    const store = new D1AgentApprovalStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.saveApproval({
      id: "approval-1", ownerId: "owner-1", runId: "run-1", threadId: "thread-1", branchId: "branch-1",
      toolCallId: "call-7", state: "pending",
      patch: { fileId: "file-1", baseDocumentVersion: 0, summary: "修改", operations: [] },
      encryptedRunState: "encrypted", agentDefinitionVersion: "v1",
      expiresAt: "2026-08-25T00:00:00.000Z", createdAt: "2026-08-24T00:00:00.000Z",
    });
    const insert = queries[0]!;
    const columns = insert.sql.slice(insert.sql.indexOf("(") + 1, insert.sql.indexOf(")")).split(",");
    expect(columns.map((column) => column.trim())).toContain("tool_call_id");
    expect(insert.sql.match(/\?/g)).toHaveLength(columns.length);
    expect(insert.params).toHaveLength(columns.length);
    expect(insert.params?.[columns.findIndex((column) => column.trim() === "tool_call_id")]).toBe("call-7");
  });

  it("reads an approval stored before tool-call attribution existed", async () => {
    const database = { query: async () => ({ rows: [approvalRow], rowsAffected: 1 }), batch: async () => [] } as unknown as SqlDatabase;
    const store = new D1AgentApprovalStore(database, () => "2026-08-24T00:00:00.000Z");
    await expect(store.getApproval("owner-1", "approval-1")).resolves.toMatchObject({
      id: "approval-1",
      toolCallId: undefined,
    });
  });

  it("uses a single conditional batch to expire the approval, run, and thread", async () => {
    const batches: SqlStatement[][] = [];
    const database = { query: async () => ({ rows: [{ ...approvalRow, state: "pending" }], rowsAffected: 1 }), batch: async (statements: SqlStatement[]) => { batches.push(statements); return statements.map(() => ({ rows: [], rowsAffected: 1 })); } } as unknown as SqlDatabase;
    const store = new D1AgentApprovalStore(database, () => "2026-08-24T00:00:00.000Z");
    await store.expireApprovalLifecycle("owner-1", "approval-1");
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]?.[1]?.sql).toContain("EXISTS (SELECT 1 FROM agent_approvals");
  });
});

const approvalRow = { id: "approval-1", owner_id: "owner-1", run_id: "run-1", thread_id: "thread-1", branch_id: "branch-1", assistant_message_id: null, state: "approved", patch_json: JSON.stringify({ fileId: "file-1", baseDocumentVersion: 0, summary: "修改", operations: [] }), encrypted_run_state: "encrypted", agent_definition_version: "v1", resource_type: "lesson_file", patch_kind: "document", lesson_file_id: "file-1", semester_framework_id: null, base_resource_version: 0, document_version: 0, continuation_status: "ready", continuation_lease_token: null, continuation_lease_expires_at: null, continuation_attempt_count: 0, continuation_error: null, continuation_message_id: null, expires_at: "2026-08-25T00:00:00.000Z", created_at: "2026-08-24T00:00:00.000Z" };
