import { createHash } from "node:crypto";
import {
  isLessonDesignBasisPatch,
  isPresentationGoalPatch,
  isSemesterFrameworkPatch,
  type AgentApprovalRecord,
  type LessonFileRecord,
} from "../domain.js";
import { applyDocumentPatch, rebaseDocumentPatch } from "../document-patch.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";
import { D1LessonWorkspaceStore } from "./d1-workspace-store.js";

/**
 * Coordinates the document-only approval path. Each conditional statement in
 * the D1 batch proves the prior state, so a stale document cannot leave an
 * approval marked as applied. Other approval resource families are migrated
 * with their own aggregate stores rather than being coerced into this path.
 */
export class D1DocumentApprovalCoordinator implements Pick<LessonRepository, "applyApprovedPatch"> {
  private readonly approvals: D1AgentApprovalStore;
  private readonly workspace: D1LessonWorkspaceStore;

  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {
    this.approvals = new D1AgentApprovalStore(database, clock);
    this.workspace = new D1LessonWorkspaceStore(database, clock);
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const approval = await this.requireDocumentApproval(args.ownerId, args.approvalId);
    return this.applyDocumentApproval(args, approval, approval.encryptedRunState);
  }

  async decideApproval(args: Parameters<LessonRepository["decideApproval"]>[0]) {
    const approval = await this.requireDocumentApproval(args.ownerId, args.approvalId);
    if (Date.parse(approval.expiresAt) <= Date.parse(this.clock())) throw new Error("approval_expired");
    if (!args.approved) {
      if (approval.state !== "pending" && approval.state !== "rejected") throw new Error("approval_already_resolved");
      if (approval.state === "pending") {
        const result = await this.database.query({ sql: `UPDATE agent_approvals SET state = 'rejected', encrypted_run_state = ?,
          continuation_status = 'ready', continuation_lease_token = NULL, continuation_lease_expires_at = NULL,
          continuation_error = NULL, resolved_at = ? WHERE owner_id = ? AND id = ? AND state = 'pending'`, params: [args.encryptedRunState, this.clock(), args.ownerId, args.approvalId] });
        if (!result.rowsAffected) throw new Error("approval_already_resolved");
      }
      return { approval: await this.requireDocumentApproval(args.ownerId, args.approvalId), file: null, framework: null, basis: null };
    }
    if (approval.state === "approved") {
      const file = await this.workspace.getLessonFile(args.ownerId, approval.patch.fileId);
      return { approval, file, framework: null, basis: null };
    }
    const file = await this.applyDocumentApproval({ ownerId: args.ownerId, approvalId: args.approvalId, idempotencyKey: `approval:${args.approvalId}` }, approval, args.encryptedRunState);
    return { approval: await this.requireDocumentApproval(args.ownerId, args.approvalId), file, framework: null, basis: null };
  }

  private async applyDocumentApproval(
    args: Parameters<LessonRepository["applyApprovedPatch"]>[0],
    approval: AgentApprovalRecord & { patch: Extract<AgentApprovalRecord["patch"], { fileId: string }> },
    encryptedRunState: string,
  ) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ approvalId: approval.id, patch: approval.patch })).digest("hex");
    const replay = await this.replay(args.ownerId, args.idempotencyKey, fingerprint);
    if (replay) return replay;
    if (approval.state !== "pending") throw new Error("approval_already_resolved");
    if (Date.parse(approval.expiresAt) <= Date.parse(this.clock())) throw new Error("approval_expired");

    const current = await this.workspace.getLessonFile(args.ownerId, approval.patch.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    const patch = rebaseDocumentPatch(approval.patch, current.document, current.documentVersion);
    const document = applyDocumentPatch(current.document, patch);
    const timestamp = this.clock();
    const saved: LessonFileRecord = { ...current, document, documentVersion: current.documentVersion + 1, updatedAt: timestamp };
    const documentJson = JSON.stringify(document);
    const patchJson = JSON.stringify(patch);
    const responseJson = JSON.stringify(saved);
    const statements: SqlStatement[] = [
      { sql: `UPDATE lesson_files SET document_json = ?, document_version = document_version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ? AND document_version = ?`, params: [documentJson, timestamp, args.ownerId, current.id, current.documentVersion] },
      { sql: `INSERT INTO lesson_file_versions (id, owner_id, lesson_file_id, document_version, document_json, page_count, actor, run_id, idempotency_key, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND document_version = ? AND document_json = ?)
          AND EXISTS (SELECT 1 FROM agent_approvals WHERE owner_id = ? AND id = ? AND state = 'pending')`, params: [crypto.randomUUID(), args.ownerId, current.id, saved.documentVersion, documentJson, saved.pageCount, approval.runId, args.idempotencyKey, timestamp, args.ownerId, current.id, saved.documentVersion, documentJson, args.ownerId, approval.id] },
      { sql: `UPDATE agent_approvals SET state = 'approved', patch_json = ?, encrypted_run_state = ?,
          continuation_status = 'ready', continuation_lease_token = NULL, continuation_lease_expires_at = NULL,
          continuation_error = NULL, resolved_at = ?
        WHERE owner_id = ? AND id = ? AND state = 'pending' AND expires_at > ?
          AND EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND document_version = ? AND document_json = ?)
          AND EXISTS (SELECT 1 FROM lesson_file_versions WHERE owner_id = ? AND lesson_file_id = ? AND document_version = ? AND idempotency_key = ?)`, params: [patchJson, encryptedRunState, timestamp, args.ownerId, approval.id, timestamp, args.ownerId, current.id, saved.documentVersion, documentJson, args.ownerId, current.id, saved.documentVersion, args.idempotencyKey] },
      { sql: `INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at)
        SELECT ?, 'apply_approved_document_patch', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_approvals WHERE owner_id = ? AND id = ? AND state = 'approved')
          AND EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND document_version = ? AND document_json = ?)`, params: [args.ownerId, args.idempotencyKey, fingerprint, responseJson, timestamp, args.ownerId, approval.id, args.ownerId, current.id, saved.documentVersion, documentJson] },
    ];
    const results = await this.database.batch(statements);
    if (results.every((result) => result.rowsAffected === 1)) return saved;
    const completed = await this.replay(args.ownerId, args.idempotencyKey, fingerprint);
    if (completed) return completed;
    const file = await this.workspace.getLessonFile(args.ownerId, approval.patch.fileId);
    if (!file) throw new Error("lesson_file_not_found");
    throw new Error(file.documentVersion === current.documentVersion ? "approval_conflict" : "stale_document");
  }

  private async requireDocumentApproval(ownerId: string, approvalId: string): Promise<AgentApprovalRecord & { patch: Extract<AgentApprovalRecord["patch"], { fileId: string }> }> {
    const approval = await this.approvals.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (isPresentationGoalPatch(approval.patch) || isSemesterFrameworkPatch(approval.patch) || isLessonDesignBasisPatch(approval.patch)) throw new Error("approval_resource_not_migrated");
    return approval as AgentApprovalRecord & { patch: Extract<AgentApprovalRecord["patch"], { fileId: string }> };
  }

  private async replay(ownerId: string, idempotencyKey: string, fingerprint: string) {
    const result = await this.database.query<{ request_fingerprint: string; response_json: string }>({ sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'apply_approved_document_patch' AND idempotency_key = ?", params: [ownerId, idempotencyKey] });
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint) throw new Error("idempotency_conflict");
    return JSON.parse(row.response_json) as LessonFileRecord;
  }
}
