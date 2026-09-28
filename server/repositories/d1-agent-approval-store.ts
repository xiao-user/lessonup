import type { AgentApprovalRecord, ResourcePatch } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement, SqlValue } from "../platform/sql-database.js";
import { D1AgentRuntimeStore } from "./d1-agent-runtime-store.js";

type ApprovalRow = Record<string, unknown>;

/**
 * Durable approval state and continuation leases. Document/framework mutation
 * deliberately stays outside this store: each resource adapter owns its CAS
 * write, then a composite repository coordinates the recoverable decision.
 */
export type AgentApprovalStore = Pick<LessonRepository,
  "saveApproval" | "getApproval" | "listApprovals" | "listPendingApprovals" |
  "resolveApproval" | "expireApprovalLifecycle" | "claimApprovalContinuation" |
  "finishApprovalContinuation" | "settleApprovalContinuation">;

export class D1AgentApprovalStore implements AgentApprovalStore {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}

  async saveApproval(value: AgentApprovalRecord) {
    await this.database.query({ sql: `INSERT INTO agent_approvals (
      id, owner_id, run_id, thread_id, branch_id, assistant_message_id, tool_call_id, state,
      patch_json, encrypted_run_state, agent_definition_version, resource_type,
      patch_kind, lesson_file_id, semester_framework_id, base_resource_version,
      document_version, continuation_status, continuation_lease_token,
      continuation_lease_expires_at, continuation_attempt_count,
      continuation_error, continuation_message_id, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: approvalParams(value) });
  }

  async getApproval(ownerId: string, approvalId: string) {
    const result = await this.database.query<ApprovalRow>({ sql: `${approvalSelect} WHERE owner_id = ? AND id = ?`, params: [ownerId, approvalId] });
    return result.rows[0] ? approval(result.rows[0]) : null;
  }

  async listApprovals(ownerId: string, threadId: string, branchId: string) {
    const result = await this.database.query<ApprovalRow>({ sql: `${approvalSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ORDER BY created_at, id`, params: [ownerId, threadId, branchId] });
    return result.rows.map(approval);
  }

  async listPendingApprovals(ownerId: string, threadId: string, branchId: string) {
    const result = await this.database.query<ApprovalRow>({ sql: `${approvalSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND expires_at > ? AND (state = 'pending' OR continuation_status IN ('ready', 'running')) ORDER BY created_at DESC, id DESC`, params: [ownerId, threadId, branchId, this.clock()] });
    return result.rows.map(approval);
  }

  async resolveApproval(ownerId: string, approvalId: string, state: "approved" | "rejected" | "expired") {
    const current = await this.requireApproval(ownerId, approvalId);
    if (current.state === state) return current;
    if (current.state !== "pending") throw new Error("approval_already_resolved");
    const result = await this.database.query({ sql: "UPDATE agent_approvals SET state = ?, resolved_at = ? WHERE owner_id = ? AND id = ? AND state = 'pending'", params: [state, this.clock(), ownerId, approvalId] });
    if (!result.rowsAffected) throw new Error("approval_already_resolved");
    return this.requireApproval(ownerId, approvalId);
  }

  /**
   * Expiry transitions the approval and owning run together. The thread becomes
   * idle: its failed run remains durable, but a terminal failure must never
   * prevent the teacher from beginning an intentional next turn.
   * Each later statement is guarded by the new approval state, so a concurrent
   * decision cannot incorrectly fail a successfully decided run.
   */
  async expireApprovalLifecycle(ownerId: string, approvalId: string) {
    const now = this.clock();
    const current = await this.requireApproval(ownerId, approvalId);
    if (current.state !== "pending") return current;
    const results = await this.database.batch([
      { sql: "UPDATE agent_approvals SET state = 'expired', continuation_error = 'approval_expired', resolved_at = ? WHERE owner_id = ? AND id = ? AND state = 'pending' AND expires_at <= ?", params: [now, ownerId, approvalId, now] },
      { sql: "UPDATE agent_runs SET status = 'failed', error = 'approval_expired', completed_at = ? WHERE owner_id = ? AND id = ? AND status NOT IN ('completed', 'cancelled') AND EXISTS (SELECT 1 FROM agent_approvals WHERE owner_id = ? AND id = ? AND state = 'expired')", params: [now, ownerId, current.runId, ownerId, approvalId] },
      { sql: "UPDATE agent_threads SET status = 'idle', updated_at = ? WHERE owner_id = ? AND id = ? AND status IN ('awaiting_approval', 'running') AND EXISTS (SELECT 1 FROM agent_approvals WHERE owner_id = ? AND id = ? AND state = 'expired') AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND thread_id = ? AND status IN ('queued', 'running', 'awaiting_approval'))", params: [now, ownerId, current.threadId, ownerId, approvalId, ownerId, current.threadId] },
    ]);
    if (!results[0]?.rowsAffected) {
      const refreshed = await this.requireApproval(ownerId, approvalId);
      if (refreshed.state !== "expired") throw new Error("approval_not_expired");
    }
    return this.requireApproval(ownerId, approvalId);
  }

  async claimApprovalContinuation(args: Parameters<LessonRepository["claimApprovalContinuation"]>[0]) {
    const current = await this.requireApproval(args.ownerId, args.approvalId);
    if (current.state === "pending") throw new Error("approval_decision_missing");
    if (current.state === "expired") throw new Error("approval_expired");
    if (current.continuationStatus === "completed") return current;
    const now = this.clock();
    const messageId = current.continuationMessageId ?? crypto.randomUUID();
    const results = await this.database.batch([{ sql: `UPDATE agent_approvals
      SET continuation_status = 'running', continuation_lease_token = ?,
          continuation_lease_expires_at = ?, continuation_attempt_count = continuation_attempt_count + 1,
          continuation_error = NULL, continuation_message_id = ?
      WHERE owner_id = ? AND id = ? AND state IN ('approved', 'rejected')
        AND continuation_status <> 'completed'
        AND EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND id = ?
          AND status NOT IN ('completed', 'cancelled') AND cancel_requested_at IS NULL
          AND (status <> 'running' OR lease_expires_at <= ?))
        AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND thread_id = ? AND id <> ?
          AND status IN ('queued', 'running', 'awaiting_approval'))
        AND (continuation_status <> 'running' OR continuation_lease_expires_at IS NULL OR continuation_lease_expires_at <= ?)`,
      params: [args.leaseToken, args.leaseExpiresAt, messageId, args.ownerId, args.approvalId, args.ownerId, current.runId, now,
        args.ownerId, current.threadId, current.runId, now] },
      // The unique active-run index is the arbiter for both new turns and
      // approval continuations. A conflict rolls back the approval claim too.
      { sql: `UPDATE agent_runs SET status = 'running', lease_token = ?, lease_expires_at = ?,
          heartbeat_at = ?, completed_at = NULL, error = NULL
        WHERE owner_id = ? AND id = ? AND changes() = 1`,
        params: [args.leaseToken, args.leaseExpiresAt, now, args.ownerId, current.runId] },
      { sql: `UPDATE agent_threads SET status = 'running', updated_at = ?
        WHERE owner_id = ? AND id = ? AND changes() = 1`, params: [now, args.ownerId, current.threadId] },
    ]);
    if (!results[0]?.rowsAffected) {
      const refreshed = await this.requireApproval(args.ownerId, args.approvalId);
      if (refreshed.continuationStatus === "completed") return refreshed;
      throw new Error("active_run_exists");
    }
    return this.requireApproval(args.ownerId, args.approvalId);
  }

  async finishApprovalContinuation(args: Parameters<LessonRepository["finishApprovalContinuation"]>[0]) {
    return this.settleApprovalContinuation({ ...args, outcome: args.status });
  }

  async settleApprovalContinuation(args: Parameters<LessonRepository["settleApprovalContinuation"]>[0]) {
    const approval = await this.requireApproval(args.ownerId, args.approvalId);
    const terminal = args.outcome === "completed" || args.outcome === "cancelled";
    const continuationStatus = terminal || args.outcome === "paused" ? "completed" : "ready";
    // Replays are reads, never another opportunity to alter a terminal result.
    if (approval.continuationStatus === "completed") return approval;
    if (approval.continuationStatus === "ready" && !approval.continuationLeaseToken) return approval;
    if (
      approval.continuationStatus !== "running" || approval.continuationLeaseToken !== args.leaseToken
    ) {
      throw new Error("approval_lease_lost");
    }
    const runtime = new D1AgentRuntimeStore(this.database, this.clock);
    if (args.sessionItems) await runtime.replaceSessionItems(args.ownerId, approval.threadId, approval.branchId, args.sessionItems);
    const sessionCursor = args.sessionItems?.length ?? args.sessionCursor;
    const statements: SqlStatement[] = [{ sql: `UPDATE agent_approvals
      SET encrypted_run_state = ?, continuation_status = ?, continuation_lease_token = NULL,
          continuation_lease_expires_at = NULL, continuation_error = ?
      WHERE owner_id = ? AND id = ?
        AND continuation_status = 'running' AND continuation_lease_token = ?
        AND EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND id = ?
          AND status = 'running' AND lease_token = ? AND lease_expires_at > ?
          AND (cancel_requested_at IS NULL OR ? = 'cancelled'))`, params: [
      args.encryptedRunState ?? approval.encryptedRunState, continuationStatus,
      args.error ?? approval.continuationError ?? null,
      args.ownerId, args.approvalId, args.leaseToken,
      args.ownerId, approval.runId, args.leaseToken, this.clock(), args.outcome,
    ] }];

    const run = await runtime.getRun(args.ownerId, approval.runId);
    if (!run) throw new Error("run_not_found");
    const runStatus = args.outcome === "cancelled" ? "cancelled"
      : args.outcome === "completed" ? "completed"
        : args.outcome === "paused" ? "awaiting_approval"
        : "failed";
    const now = this.clock();
    statements.push({
      sql: `UPDATE agent_runs
        SET status = ?, token_usage_json = ?, error = ?, completed_at = CASE WHEN ? = 'awaiting_approval' THEN NULL ELSE COALESCE(completed_at, ?) END,
            lease_token = NULL, lease_expires_at = NULL, heartbeat_at = ?
        WHERE owner_id = ? AND id = ? AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM agent_approvals
            WHERE owner_id = ? AND id = ? AND continuation_status = ?
              AND continuation_lease_token IS NULL
          )`,
      params: [
        runStatus, JSON.stringify(args.tokenUsage ?? run.tokenUsage ?? {}),
        runStatus === "failed" ? args.error ?? run.error ?? null : null, runStatus, now, now,
        args.ownerId, run.id, args.ownerId, args.approvalId, continuationStatus,
      ],
    });
    statements.push({
      sql: `UPDATE agent_threads
        SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM agent_runs
            WHERE owner_id = ? AND thread_id = ? AND status = 'awaiting_approval'
          ) THEN 'awaiting_approval'
          WHEN EXISTS (
            SELECT 1 FROM agent_runs
            WHERE owner_id = ? AND thread_id = ? AND status IN ('queued', 'running')
          ) THEN 'running'
          ELSE 'idle'
        END,
        updated_at = ?
        WHERE owner_id = ? AND id = ? AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM agent_approvals
            WHERE owner_id = ? AND id = ? AND continuation_status = ?
              AND continuation_lease_token IS NULL
          )`,
      params: [
        args.ownerId, approval.threadId, args.ownerId, approval.threadId, now,
        args.ownerId, approval.threadId, args.ownerId, args.approvalId, continuationStatus,
      ],
    });
    if (args.assistantMessageId) statements.push(approvalMessageSettlement({
      ownerId: args.ownerId, approvalId: args.approvalId, continuationStatus,
      assistantMessageId: args.assistantMessageId,
      status: runStatus === "cancelled" ? "cancelled" : runStatus === "failed" ? "failed" : "completed",
      error: runStatus === "failed" ? args.error : undefined,
      content: args.content, sources: args.sources, sessionCursor,
    }));
    const settled = await this.database.batch(statements);
    if (!settled[0]?.rowsAffected) throw new Error("approval_lease_lost");
    return this.requireApproval(args.ownerId, args.approvalId);
  }

  private async requireApproval(ownerId: string, approvalId: string) {
    const value = await this.getApproval(ownerId, approvalId);
    if (!value) throw new Error("approval_not_found");
    return value;
  }
}

const approvalSelect = `SELECT id, owner_id, run_id, thread_id, branch_id, assistant_message_id, tool_call_id, state, patch_json,
  encrypted_run_state, agent_definition_version, resource_type, patch_kind, lesson_file_id,
  semester_framework_id, base_resource_version, document_version, continuation_status,
  continuation_lease_token, continuation_lease_expires_at, continuation_attempt_count,
  continuation_error, continuation_message_id, expires_at, created_at FROM agent_approvals`;
const parse = <T>(value: unknown, fallback: T): T => { try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; } };
const asNumber = (value: unknown) => value == null ? undefined : Number(value);
const approval = (row: ApprovalRow): AgentApprovalRecord => ({
  id: String(row.id), ownerId: String(row.owner_id), runId: String(row.run_id), threadId: String(row.thread_id), branchId: String(row.branch_id),
  assistantMessageId: row.assistant_message_id ? String(row.assistant_message_id) : undefined,
  toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
  state: row.state as AgentApprovalRecord["state"], patch: parse<ResourcePatch>(row.patch_json, {} as ResourcePatch),
  encryptedRunState: String(row.encrypted_run_state), agentDefinitionVersion: String(row.agent_definition_version),
  resourceType: row.resource_type as AgentApprovalRecord["resourceType"], patchKind: row.patch_kind as AgentApprovalRecord["patchKind"],
  lessonFileId: row.lesson_file_id ? String(row.lesson_file_id) : undefined, semesterFrameworkId: row.semester_framework_id ? String(row.semester_framework_id) : undefined,
  baseResourceVersion: asNumber(row.base_resource_version), documentVersion: asNumber(row.document_version),
  continuationStatus: row.continuation_status as AgentApprovalRecord["continuationStatus"], continuationLeaseToken: row.continuation_lease_token ? String(row.continuation_lease_token) : undefined,
  continuationLeaseExpiresAt: row.continuation_lease_expires_at ? String(row.continuation_lease_expires_at) : undefined,
  continuationAttemptCount: asNumber(row.continuation_attempt_count), continuationError: row.continuation_error ? String(row.continuation_error) : undefined,
  continuationMessageId: row.continuation_message_id ? String(row.continuation_message_id) : undefined,
  expiresAt: String(row.expires_at), createdAt: String(row.created_at),
});
const approvalParams = (value: AgentApprovalRecord): SqlValue[] => [
  value.id, value.ownerId, value.runId, value.threadId, value.branchId, value.assistantMessageId ?? null,
  value.toolCallId ?? null, value.state,
  JSON.stringify(value.patch), value.encryptedRunState, value.agentDefinitionVersion, value.resourceType ?? null,
  value.patchKind ?? null, value.lessonFileId ?? null, value.semesterFrameworkId ?? null, value.baseResourceVersion ?? null,
  value.documentVersion ?? null, value.continuationStatus ?? "pending", value.continuationLeaseToken ?? null,
  value.continuationLeaseExpiresAt ?? null, value.continuationAttemptCount ?? 0, value.continuationError ?? null,
  value.continuationMessageId ?? null, value.expiresAt, value.createdAt,
];

function approvalMessageSettlement(args: {
  ownerId: string;
  approvalId: string;
  continuationStatus: NonNullable<AgentApprovalRecord["continuationStatus"]>;
  assistantMessageId: string;
  status: "completed" | "cancelled" | "failed";
  error?: string;
  content?: string;
  sources?: unknown[];
  sessionCursor?: number;
}) {
  const assignments = ["status = ?", "error = ?"];
  const params: SqlValue[] = [args.status, args.error ?? null];
  if (args.content !== undefined) {
    assignments.push("content = ?");
    params.push(args.content);
  }
  if (args.sources !== undefined) {
    assignments.push("sources_json = ?");
    params.push(JSON.stringify(args.sources));
  }
  if (args.sessionCursor !== undefined) {
    assignments.push("session_cursor = ?");
    params.push(args.sessionCursor);
  }
  params.push(
    args.ownerId, args.assistantMessageId,
    args.ownerId, args.approvalId, args.continuationStatus,
  );
  return {
    sql: `UPDATE agent_messages SET ${assignments.join(", ")}
      WHERE owner_id = ? AND id = ? AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM agent_approvals
          WHERE owner_id = ? AND id = ? AND continuation_status = ?
            AND continuation_lease_token IS NULL
        )`,
    params,
  };
}
