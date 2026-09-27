import {
  isLessonDesignBasisPatch,
  isPresentationGoalPatch,
  isSemesterFrameworkPatch,
  type AgentApprovalRecord,
  type LessonDesignBasisAggregate,
  type LessonFileRecord,
  type SemesterFrameworkAggregate,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";
import { D1DocumentApprovalCoordinator } from "./d1-document-approval-coordinator.js";
import { D1LessonDesignBasisRepository } from "./d1-lesson-design-basis-repository.js";
import { D1SemesterFrameworkMutationRepository } from "./d1-semester-framework-mutation-repository.js";
import { D1SemesterFrameworkReadRepository } from "./d1-semester-framework-read-repository.js";
import { D1LessonWorkspaceStore } from "./d1-workspace-store.js";

/**
 * Routes every durable approval through its aggregate-specific writer while
 * keeping continuation state in one place. The resource writers retain their
 * own CAS/idempotency guarantees; this coordinator never lets a resource
 * family fall back to a document-only approval path.
 */
export class D1ApprovalCoordinator implements Pick<LessonRepository, "decideApproval"> {
  private readonly approvals: D1AgentApprovalStore;
  private readonly workspace: D1LessonWorkspaceStore;
  private readonly documents: D1DocumentApprovalCoordinator;
  private readonly frameworks: D1SemesterFrameworkMutationRepository;
  private readonly frameworkReads: D1SemesterFrameworkReadRepository;
  private readonly bases: D1LessonDesignBasisRepository;

  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {
    this.approvals = new D1AgentApprovalStore(database, clock);
    this.workspace = new D1LessonWorkspaceStore(database, clock);
    this.documents = new D1DocumentApprovalCoordinator(database, clock);
    this.frameworks = new D1SemesterFrameworkMutationRepository(database, clock);
    this.frameworkReads = new D1SemesterFrameworkReadRepository(database);
    this.bases = new D1LessonDesignBasisRepository(database, clock);
  }

  async decideApproval(args: Parameters<LessonRepository["decideApproval"]>[0]) {
    let approval = await this.require(args.ownerId, args.approvalId);
    if (Date.parse(approval.expiresAt) <= Date.parse(this.clock())) throw new Error("approval_expired");

    // Document and combined document/design-basis patches preserve the
    // existing document transaction implementation.
    if (!isPresentationGoalPatch(approval.patch) && !isSemesterFrameworkPatch(approval.patch) && !isLessonDesignBasisPatch(approval.patch)) {
      return this.documents.decideApproval(args);
    }

    const desiredState = args.approved ? "approved" : "rejected";
    if (approval.state !== "pending" && approval.state !== desiredState) throw new Error("approval_already_resolved");

    let file: LessonFileRecord | null = null;
    let framework: SemesterFrameworkAggregate | null = null;
    let basis: LessonDesignBasisAggregate | null = null;
    if (approval.state === "pending") {
      if (!args.approved) {
        await this.reject(args);
      } else if (isPresentationGoalPatch(approval.patch)) {
        file = await this.workspace.getLessonFile(args.ownerId, approval.patch.fileId);
        if (!file) throw new Error("lesson_file_not_found");
        if (file.documentVersion !== approval.patch.documentVersion) throw new Error("document_conflict");
        await this.approvals.resolveApproval(args.ownerId, approval.id, "approved");
        await this.saveContinuation(args, "approved");
      } else if (isSemesterFrameworkPatch(approval.patch)) {
        framework = await this.frameworks.applyApprovedSemesterFrameworkPatch({
          ownerId: args.ownerId, approvalId: approval.id, idempotencyKey: `approval:${approval.id}`,
        });
        await this.saveContinuation(args, "approved");
      } else {
        basis = await this.bases.applyApprovedLessonDesignBasisPatch({
          ownerId: args.ownerId, approvalId: approval.id, idempotencyKey: `approval:${approval.id}`,
        });
        await this.saveContinuation(args, "approved");
      }
    } else if (args.approved) {
      if (isPresentationGoalPatch(approval.patch)) {
        file = await this.workspace.getLessonFile(args.ownerId, approval.patch.fileId);
      } else if (isSemesterFrameworkPatch(approval.patch)) {
        framework = await this.frameworkReads.getSemesterFramework(args.ownerId, approval.patch.frameworkId);
      } else {
        basis = await this.bases.getLessonDesignBasis(args.ownerId, approval.patch.fileId);
      }
    }

    approval = await this.require(args.ownerId, args.approvalId);
    return { approval, file, framework, basis };
  }

  private async reject(args: Parameters<LessonRepository["decideApproval"]>[0]) {
    const result = await this.database.query({ sql: `UPDATE agent_approvals
      SET state = 'rejected', encrypted_run_state = ?, continuation_status = 'ready',
          continuation_lease_token = NULL, continuation_lease_expires_at = NULL,
          continuation_error = NULL, resolved_at = ?
      WHERE owner_id = ? AND id = ? AND state = 'pending'`, params: [
      args.encryptedRunState, this.clock(), args.ownerId, args.approvalId,
    ] });
    if (!result.rowsAffected) throw new Error("approval_already_resolved");
  }

  private async saveContinuation(args: Parameters<LessonRepository["decideApproval"]>[0], state: "approved" | "rejected") {
    const result = await this.database.query({ sql: `UPDATE agent_approvals
      SET encrypted_run_state = ?, continuation_status = 'ready',
          continuation_lease_token = NULL, continuation_lease_expires_at = NULL, continuation_error = NULL
      WHERE owner_id = ? AND id = ? AND state = ?
        AND continuation_status = 'pending' AND continuation_lease_token IS NULL`, params: [
      args.encryptedRunState, args.ownerId, args.approvalId, state,
    ] });
    if (!result.rowsAffected && (await this.require(args.ownerId, args.approvalId)).state !== state) {
      throw new Error("approval_already_resolved");
    }
  }

  private async require(ownerId: string, approvalId: string): Promise<AgentApprovalRecord> {
    const approval = await this.approvals.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    return approval;
  }
}
