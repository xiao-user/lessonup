import { createHash } from "node:crypto";
import {
  isSemesterFrameworkPatch,
  type CreateLessonBlueprintInput,
  type DeleteLessonBlueprintInput,
  type SemesterFrameworkAggregate,
  type SemesterFrameworkPatch,
  type UpdateLessonBlueprintInput,
} from "../domain.js";
import { applySemesterFrameworkPatch } from "../semester-framework-patch.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { D1AgentApprovalStore } from "./d1-agent-approval-store.js";
import { D1SemesterFrameworkReadRepository } from "./d1-semester-framework-read-repository.js";

export type D1SemesterFrameworkMutationStore = Pick<LessonRepository,
  "applyManualSemesterFrameworkPatch" | "applyApprovedSemesterFrameworkPatch" |
  "createLessonBlueprint" | "updateLessonBlueprint" | "deleteLessonBlueprint"
>;

/** Atomic aggregate writer; D1 details never leave this repository. */
export class D1SemesterFrameworkMutationRepository implements D1SemesterFrameworkMutationStore {
  private readonly reads: D1SemesterFrameworkReadRepository;
  private readonly approvals: D1AgentApprovalStore;
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {
    this.reads = new D1SemesterFrameworkReadRepository(database);
    this.approvals = new D1AgentApprovalStore(database, clock);
  }

  async applyManualSemesterFrameworkPatch(ownerId: string, patch: SemesterFrameworkPatch, idempotencyKey: string) {
    const current = await this.require(ownerId, patch.frameworkId);
    return this.apply(ownerId, current, patch, { actor: "manual", idempotencyKey });
  }

  async applyApprovedSemesterFrameworkPatch(args: Parameters<LessonRepository["applyApprovedSemesterFrameworkPatch"]>[0]) {
    const approval = await this.approvals.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (!isSemesterFrameworkPatch(approval.patch)) throw new Error("approval_resource_scope_invalid");
    if (approval.state !== "pending" && approval.state !== "approved") throw new Error("approval_not_approvable");
    const current = await this.require(args.ownerId, approval.patch.frameworkId);
    const saved = await this.apply(args.ownerId, current, approval.patch, {
      actor: "agent", idempotencyKey: args.idempotencyKey, approvalId: approval.id, runId: approval.runId,
    });
    if (approval.state === "pending") await this.approvals.resolveApproval(args.ownerId, approval.id, "approved");
    return saved;
  }

  async createLessonBlueprint(ownerId: string, frameworkId: string, input: CreateLessonBlueprintInput, idempotencyKey: string) {
    const current = await this.require(ownerId, frameworkId);
    const unit = current.units.find((item) => item.id === input.semesterUnitId);
    if (!unit) throw new Error("semester_unit_not_found");
    const byUnit = current.blueprints.filter((item) => item.semesterUnitId === unit.id);
    const byNode = byUnit.filter((item) => item.curriculumNodeId === input.curriculumNodeId);
    const patch: SemesterFrameworkPatch = {
      frameworkId, baseFrameworkVersion: current.framework.version, summary: "创建课时蓝图", operations: [{
        op: "create_lesson_blueprint", blueprintId: crypto.randomUUID(), semesterUnitId: unit.id,
        curriculumNodeId: input.curriculumNodeId, chapterPeriodNo: input.chapterPeriodNo ?? Math.max(0, ...byNode.map((item) => item.chapterPeriodNo)) + 1,
        plannedPeriod: Math.max(0, ...byUnit.map((item) => item.plannedPeriod)) + 1,
        sortNo: Math.max(0, ...current.blueprints.map((item) => item.sortNo)) + 1,
        title: input.title, mainActivity: input.mainActivity, observableProduct: input.observableProduct,
        assessmentEvidence: input.assessmentEvidence, anticipatedDifficulties: input.anticipatedDifficulties,
        plannedMinutes: input.plannedMinutes ?? current.framework.lessonDurationMinutes, teacherNotes: input.teacherNotes, status: "draft",
      }],
    };
    return this.apply(ownerId, current, patch, { actor: "manual", idempotencyKey });
  }

  async updateLessonBlueprint(ownerId: string, frameworkId: string, blueprintId: string, input: UpdateLessonBlueprintInput, idempotencyKey: string) {
    const current = await this.require(ownerId, frameworkId);
    const blueprint = current.blueprints.find((item) => item.id === blueprintId);
    if (!blueprint || blueprint.version !== input.expectedVersion) throw new Error("stale_resource");
    const fields = ["title", "mainActivity", "observableProduct", "assessmentEvidence", "anticipatedDifficulties", "plannedMinutes", "teacherNotes", "status"] as const;
    const operations = fields.flatMap((field) => input[field] === undefined ? [] : [{
      op: "replace_lesson_blueprint_field" as const, blueprintId, field, expectedValue: blueprint[field], replacement: input[field]!,
    }]);
    if (!operations.length) throw new Error("empty_blueprint_patch");
    return this.apply(ownerId, current, { frameworkId, baseFrameworkVersion: current.framework.version, summary: "更新课时蓝图", operations }, { actor: "manual", idempotencyKey });
  }

  async deleteLessonBlueprint(ownerId: string, frameworkId: string, blueprintId: string, input: DeleteLessonBlueprintInput, idempotencyKey: string) {
    const current = await this.require(ownerId, frameworkId);
    const blueprint = current.blueprints.find((item) => item.id === blueprintId);
    if (!blueprint || blueprint.version !== input.expectedVersion) throw new Error("stale_resource");
    return this.apply(ownerId, current, { frameworkId, baseFrameworkVersion: current.framework.version, summary: "删除课时蓝图", operations: [{
      op: "delete_lesson_blueprint", blueprintId, expectedVersion: input.expectedVersion, expectedTitle: blueprint.title, expectedSemesterUnitId: blueprint.semesterUnitId,
    }] }, { actor: "manual", idempotencyKey });
  }

  private async apply(ownerId: string, current: SemesterFrameworkAggregate, patch: SemesterFrameworkPatch, context: { actor: "manual" | "agent"; idempotencyKey: string; approvalId?: string; runId?: string }) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ patch, approvalId: context.approvalId ?? null })).digest("hex");
    const replay = await this.database.query<{ request_fingerprint: string; response_json: string }>({ sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'semester_framework_patch' AND idempotency_key = ?", params: [ownerId, context.idempotencyKey] });
    if (replay.rows[0]) {
      if (replay.rows[0].request_fingerprint !== fingerprint) throw new Error("idempotency_conflict");
      return JSON.parse(replay.rows[0].response_json) as SemesterFrameworkAggregate;
    }
    const now = this.clock(); const next = applySemesterFrameworkPatch(current, patch, now);
    const snapshot = JSON.stringify(next); const removed = current.blueprints.filter((old) => !next.blueprints.some((item) => item.id === old.id)).map((item) => item.id);
    const guard = "owner_id = ? AND id = ? AND version = ?";
    const statements: SqlStatement[] = [
      { sql: `UPDATE semester_frameworks SET title = ?, term = ?, start_date = ?, total_weeks = ?, weekly_periods = ?, lesson_duration_minutes = ?, capacity_ratio = ?, planning_horizon_weeks = ?, context_profile_json = ?, status = ?, version = ?, updated_at = ? WHERE ${guard}`,
        params: [next.framework.title, next.framework.term, next.framework.startDate, next.framework.totalWeeks, next.framework.weeklyPeriods, next.framework.lessonDurationMinutes, next.framework.capacityRatio, next.framework.planningHorizonWeeks, JSON.stringify(next.framework.contextProfile), next.framework.status, next.framework.version, now, ownerId, current.framework.id, current.framework.version] },
      ...next.units.map((unit) => ({ sql: "UPDATE semester_units SET planned_start_week = ?, planned_end_week = ?, planned_periods = ?, learning_goals = ?, teacher_notes = ?, status = ?, version = ?, updated_at = ? WHERE owner_id = ? AND framework_id = ? AND id = ?", params: [unit.plannedStartWeek, unit.plannedEndWeek, unit.plannedPeriods, unit.learningGoals, unit.teacherNotes, unit.status, unit.version, unit.updatedAt, ownerId, current.framework.id, unit.id] })),
      ...removed.map((id) => ({ sql: "DELETE FROM framework_outcome_selections WHERE owner_id = ? AND framework_id = ? AND lesson_blueprint_id = ?", params: [ownerId, current.framework.id, id] })),
      ...removed.map((id) => ({ sql: "DELETE FROM lesson_blueprints WHERE owner_id = ? AND framework_id = ? AND id = ?", params: [ownerId, current.framework.id, id] })),
      ...next.blueprints.map((blueprint) => ({ sql: `INSERT INTO lesson_blueprints (id, owner_id, framework_id, semester_unit_id, curriculum_node_id, chapter_period_no, planned_period, sort_no, title, main_activity, observable_product, assessment_evidence, anticipated_difficulties_json, planned_minutes, teacher_notes, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET semester_unit_id = excluded.semester_unit_id, curriculum_node_id = excluded.curriculum_node_id, chapter_period_no = excluded.chapter_period_no, planned_period = excluded.planned_period, sort_no = excluded.sort_no, title = excluded.title, main_activity = excluded.main_activity, observable_product = excluded.observable_product, assessment_evidence = excluded.assessment_evidence, anticipated_difficulties_json = excluded.anticipated_difficulties_json, planned_minutes = excluded.planned_minutes, teacher_notes = excluded.teacher_notes, status = excluded.status, version = excluded.version, updated_at = excluded.updated_at`, params: [blueprint.id, ownerId, current.framework.id, blueprint.semesterUnitId, blueprint.curriculumNodeId, blueprint.chapterPeriodNo, blueprint.plannedPeriod, blueprint.sortNo, blueprint.title, blueprint.mainActivity, blueprint.observableProduct, blueprint.assessmentEvidence, JSON.stringify(blueprint.anticipatedDifficulties), blueprint.plannedMinutes, blueprint.teacherNotes, blueprint.status, blueprint.version, blueprint.createdAt, blueprint.updatedAt] })),
      { sql: "INSERT INTO semester_framework_versions (id, owner_id, framework_id, framework_version, snapshot_json, actor, run_id, approval_id, idempotency_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, current.framework.id, next.framework.version, snapshot, context.actor, context.runId ?? null, context.approvalId ?? null, context.idempotencyKey, fingerprint, now] },
      { sql: "INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at) VALUES (?, 'semester_framework_patch', ?, ?, ?, ?)", params: [ownerId, context.idempotencyKey, fingerprint, snapshot, now] },
    ];
    const result = await this.database.batch(statements);
    if (result[0]?.rowsAffected !== 1) throw new Error("stale_resource");
    return next;
  }

  private async require(ownerId: string, frameworkId: string) { const value = await this.reads.getSemesterFramework(ownerId, frameworkId); if (!value) throw new Error("semester_framework_not_found"); return value; }
}
