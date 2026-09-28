import { createHash } from "node:crypto";
import { isLessonDesignBasisPatch, lessonDesignBasisStatusSchema, type LessonDesignBasisAggregate, type LessonDesignBasisEntryRecord, type LessonDesignBasisPatch, type LessonDesignBasisRecord } from "../domain.js";
import { applyLessonDesignBasisPatch } from "../lesson-design-basis-patch.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";

type Row = Record<string, unknown>;
export type D1LessonDesignBasisStore = Pick<LessonRepository, "getLessonDesignBasis" | "applyManualLessonDesignBasisPatch" | "applyApprovedLessonDesignBasisPatch">;

export class D1LessonDesignBasisRepository implements D1LessonDesignBasisStore {
  private readonly approvals: D1AgentApprovalStore;
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) { this.approvals = new D1AgentApprovalStore(database, clock); }

  async getLessonDesignBasis(ownerId: string, lessonFileId: string): Promise<LessonDesignBasisAggregate | null> {
    const basis = await this.database.query<Row>({ sql: `${basisSelect} WHERE owner_id = ? AND lesson_file_id = ? LIMIT 1`, params: [ownerId, lessonFileId] });
    if (!basis.rows[0]) return null;
    const entries = await this.database.query<Row>({ sql: `${entrySelect} WHERE owner_id = ? AND basis_id = ? ORDER BY sort_no, id`, params: [ownerId, basis.rows[0].id as string] });
    return { basis: basisRecord(basis.rows[0]), entries: entries.rows.map(entryRecord) };
  }

  async applyManualLessonDesignBasisPatch(ownerId: string, patch: LessonDesignBasisPatch, idempotencyKey: string) {
    const current = await this.getLessonDesignBasis(ownerId, patch.fileId);
    if (!current) throw new Error("lesson_design_basis_not_found");
    return this.apply(ownerId, current, patch, { actor: "manual", idempotencyKey });
  }

  async applyApprovedLessonDesignBasisPatch(args: Parameters<LessonRepository["applyApprovedLessonDesignBasisPatch"]>[0]) {
    const approval = await this.approvals.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (!isLessonDesignBasisPatch(approval.patch)) throw new Error("approval_resource_scope_invalid");
    if (approval.state !== "pending" && approval.state !== "approved") throw new Error("approval_not_approvable");
    const current = await this.getLessonDesignBasis(args.ownerId, approval.patch.fileId);
    if (!current) throw new Error("lesson_design_basis_not_found");
    const saved = await this.apply(args.ownerId, current, approval.patch, { actor: "agent", idempotencyKey: args.idempotencyKey, approvalId: approval.id, runId: approval.runId });
    if (approval.state === "pending") await this.approvals.resolveApproval(args.ownerId, approval.id, "approved");
    return saved;
  }

  private async apply(ownerId: string, current: LessonDesignBasisAggregate, patch: LessonDesignBasisPatch, context: { actor: "manual" | "agent"; idempotencyKey: string; approvalId?: string; runId?: string }) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ patch, approvalId: context.approvalId ?? null })).digest("hex");
    const replay = await this.database.query<{ request_fingerprint: string; response_json: string }>({ sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'lesson_design_basis_patch' AND idempotency_key = ?", params: [ownerId, context.idempotencyKey] });
    if (replay.rows[0]) { if (replay.rows[0].request_fingerprint !== fingerprint) throw new Error("idempotency_conflict"); return JSON.parse(replay.rows[0].response_json) as LessonDesignBasisAggregate; }
    const now = this.clock(); const next = applyLessonDesignBasisPatch(current, patch, now); const snapshot = JSON.stringify(next);
    const statements: SqlStatement[] = [
      ...designBasisSnapshotStatements(ownerId, current, next, { ...context, fingerprint, now }),
      { sql: "INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at) VALUES (?, 'lesson_design_basis_patch', ?, ?, ?, ?)", params: [ownerId, context.idempotencyKey, fingerprint, snapshot, now] },
    ];
    const result = await this.database.batch(statements); if (result[0]?.rowsAffected !== 1) throw new Error("stale_resource"); return next;
  }
}

/** Composable writes; the caller owns the surrounding D1 transaction/CAS. */
export function designBasisSnapshotStatements(ownerId: string, current: LessonDesignBasisAggregate, next: LessonDesignBasisAggregate, context: {
  actor: "manual" | "agent"; idempotencyKey: string; fingerprint: string; now: string; approvalId?: string; runId?: string;
}): SqlStatement[] {
  const removed = current.entries.filter(entry => !next.entries.some(item => item.id === entry.id));
  return [
    { sql: "UPDATE lesson_design_bases SET learner_context_json = ?, teacher_notes = ?, status = ?, version = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND version = ?", params: [JSON.stringify(next.basis.learnerContext), next.basis.teacherNotes, next.basis.status, next.basis.version, context.now, ownerId, current.basis.id, current.basis.version] },
    ...removed.map(entry => ({ sql: "DELETE FROM lesson_design_basis_entries WHERE owner_id = ? AND basis_id = ? AND id = ?", params: [ownerId, current.basis.id, entry.id] })),
    ...next.entries.map(entry => entryStatement(ownerId, current.basis.id, entry)),
    { sql: "INSERT INTO lesson_design_basis_versions (id, owner_id, basis_id, basis_version, snapshot_json, actor, run_id, approval_id, idempotency_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, current.basis.id, next.basis.version, JSON.stringify(next), context.actor, context.runId ?? null, context.approvalId ?? null, context.idempotencyKey, context.fingerprint, context.now] },
  ];
}

const basisSelect = "SELECT id, owner_id, notebook_id, lesson_file_id, framework_id, semester_unit_id, lesson_blueprint_id, catalog_release_id, textbook_id, curriculum_node_id, semantic_release_id, source_framework_version, source_blueprint_version, learner_context_json, teacher_notes, status, version, created_at, updated_at FROM lesson_design_bases";
const entrySelect = "SELECT id, basis_id, kind, semantic_entity_id, semantic_entity_name, related_semantic_entity_id, related_semantic_entity_name, related_curriculum_node_id, related_curriculum_node_title, statement, rationale, evidence_json, decision, teacher_confirmed, origin, sort_no, version, created_at, updated_at FROM lesson_design_basis_entries";
function basisRecord(row: Row): LessonDesignBasisRecord { return { id: text(row.id), ownerId: text(row.owner_id), notebookId: text(row.notebook_id), lessonFileId: text(row.lesson_file_id), frameworkId: nullable(row.framework_id), semesterUnitId: nullable(row.semester_unit_id), lessonBlueprintId: nullable(row.lesson_blueprint_id), catalogReleaseId: nullable(row.catalog_release_id), textbookId: nullable(row.textbook_id), curriculumNodeId: nullable(row.curriculum_node_id), semanticReleaseId: nullable(row.semantic_release_id), sourceFrameworkVersion: nullableNumber(row.source_framework_version), sourceBlueprintVersion: nullableNumber(row.source_blueprint_version), learnerContext: object(row.learner_context_json), teacherNotes: text(row.teacher_notes), status: lessonDesignBasisStatusSchema.parse(row.status), version: number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at) }; }
function entryRecord(row: Row): LessonDesignBasisEntryRecord { return { id: text(row.id), basisId: text(row.basis_id), kind: text(row.kind) as LessonDesignBasisEntryRecord["kind"], semanticEntityId: nullable(row.semantic_entity_id), semanticEntityName: nullable(row.semantic_entity_name), relatedSemanticEntityId: nullable(row.related_semantic_entity_id), relatedSemanticEntityName: nullable(row.related_semantic_entity_name), relatedCurriculumNodeId: nullable(row.related_curriculum_node_id), relatedCurriculumNodeTitle: nullable(row.related_curriculum_node_title), statement: text(row.statement), rationale: text(row.rationale), evidence: array(row.evidence_json), decision: text(row.decision) as LessonDesignBasisEntryRecord["decision"], teacherConfirmed: Boolean(row.teacher_confirmed), origin: text(row.origin) as LessonDesignBasisEntryRecord["origin"], sortNo: number(row.sort_no), version: number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at) }; }
function entryStatement(ownerId: string, basisId: string, entry: LessonDesignBasisEntryRecord): SqlStatement { return { sql: `INSERT INTO lesson_design_basis_entries (id, owner_id, basis_id, kind, semantic_entity_id, semantic_entity_name, related_semantic_entity_id, related_semantic_entity_name, related_curriculum_node_id, related_curriculum_node_title, statement, rationale, evidence_json, decision, teacher_confirmed, origin, sort_no, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, semantic_entity_id = excluded.semantic_entity_id, semantic_entity_name = excluded.semantic_entity_name, related_semantic_entity_id = excluded.related_semantic_entity_id, related_semantic_entity_name = excluded.related_semantic_entity_name, related_curriculum_node_id = excluded.related_curriculum_node_id, related_curriculum_node_title = excluded.related_curriculum_node_title, statement = excluded.statement, rationale = excluded.rationale, evidence_json = excluded.evidence_json, decision = excluded.decision, teacher_confirmed = excluded.teacher_confirmed, origin = excluded.origin, sort_no = excluded.sort_no, version = excluded.version, updated_at = excluded.updated_at`, params: [entry.id, ownerId, basisId, entry.kind, entry.semanticEntityId, entry.semanticEntityName, entry.relatedSemanticEntityId, entry.relatedSemanticEntityName, entry.relatedCurriculumNodeId, entry.relatedCurriculumNodeTitle, entry.statement, entry.rationale, JSON.stringify(entry.evidence), entry.decision, entry.teacherConfirmed ? 1 : 0, entry.origin, entry.sortNo, entry.version, entry.createdAt, entry.updatedAt] }; }
function object(value: unknown) { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function array(value: unknown) { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
const text = (value: unknown) => String(value ?? ""); const number = (value: unknown) => Number(value ?? 0); const nullable = (value: unknown) => value == null ? null : String(value); const nullableNumber = (value: unknown) => value == null ? null : Number(value);
