import { describe, expect, it } from "vitest";
import { D1DocumentApprovalCoordinator } from "./d1-document-approval-coordinator.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";

describe("D1DocumentApprovalCoordinator", () => {
  it("puts document CAS, history, approval transition, and replay record in one guarded batch", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT request_fingerprint")) return { rows: [], rowsAffected: 0 };
        if (statement.sql.includes("FROM agent_approvals")) return { rows: [approvalRow], rowsAffected: 1 };
        if (statement.sql.includes("FROM lesson_files")) return { rows: [fileRow], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => { batches.push(statements); return statements.map(() => ({ rows: [], rowsAffected: 1 })); },
    } as unknown as SqlDatabase;
    const coordinator = new D1DocumentApprovalCoordinator(database, () => "2026-08-24T00:00:00.000Z");
    await expect(coordinator.applyApprovedPatch({ ownerId: "owner-1", approvalId: "approval-1", idempotencyKey: "approval:approval-1" })).resolves.toMatchObject({ documentVersion: 1, document: { objectives: "可评价目标" } });
    expect(batches[0]).toHaveLength(5);
    expect(batches[0]?.[0]?.sql).toContain("document_version = ?");
    expect(batches[0]?.[0]?.sql).toContain("ELSE NULL");
    expect(batches[0]?.[3]?.sql).toContain("state = 'pending'");
    expect(batches[0]?.[4]?.sql).toContain("operation_idempotency");
  });

  it("uses the same guarded document path for an approval decision", async () => {
    const batches: SqlStatement[][] = [];
    const database = {
      query: async (statement: SqlStatement) => {
        if (statement.sql.startsWith("SELECT request_fingerprint")) return { rows: [], rowsAffected: 0 };
        if (statement.sql.includes("FROM agent_approvals")) return { rows: [approvalRow], rowsAffected: 1 };
        if (statement.sql.includes("FROM lesson_files")) return { rows: [fileRow], rowsAffected: 1 };
        return { rows: [], rowsAffected: 0 };
      },
      batch: async (statements: SqlStatement[]) => { batches.push(statements); return statements.map(() => ({ rows: [], rowsAffected: 1 })); },
    } as unknown as SqlDatabase;
    const coordinator = new D1DocumentApprovalCoordinator(database, () => "2026-08-24T00:00:00.000Z");
    await expect(coordinator.decideApproval({ ownerId: "owner-1", approvalId: "approval-1", approved: true, encryptedRunState: "after-decision" })).resolves.toMatchObject({ file: { documentVersion: 1 }, approval: { state: "pending" } });
    expect(batches[0]?.[3]?.params).toContain("after-decision");
  });
});

const plan = { unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标", knowledgePoints: "", continuity: "", focus: "重点", preparation: "准备", process: "过程", assessment: "评价", homework: "作业", board: "板书", reflection: "反思" };
const fileRow = { id: "file-1", owner_id: "owner-1", notebook_id: "notebook-1", lesson_blueprint_id: null, title: "课题", type: "教案", image: null, document_json: JSON.stringify(plan), context_profile_json: "{}", document_version: 0, page_count: 1, updated_at: "2026-08-24T00:00:00.000Z" };
const approvalRow = { id: "approval-1", owner_id: "owner-1", run_id: "run-1", thread_id: "thread-1", branch_id: "branch-1", assistant_message_id: null, state: "pending", patch_json: JSON.stringify({ fileId: "file-1", baseDocumentVersion: 0, summary: "修改目标", operations: [{ op: "replace_text", field: "objectives", start: 0, end: 2, expectedText: "目标", replacement: "可评价目标" }] }), encrypted_run_state: "encrypted", agent_definition_version: "v1", resource_type: "lesson_file", patch_kind: "document", lesson_file_id: "file-1", semester_framework_id: null, base_resource_version: 0, document_version: 0, continuation_status: "pending", continuation_lease_token: null, continuation_lease_expires_at: null, continuation_attempt_count: 0, continuation_error: null, continuation_message_id: null, expires_at: "2026-08-25T00:00:00.000Z", created_at: "2026-08-24T00:00:00.000Z" };
