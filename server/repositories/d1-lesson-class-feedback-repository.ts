import type { CreateLessonClassFeedbackInput, LessonClassFeedbackRecord, SemesterFrameworkWritebackIntentRecord } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { defaultClassFeedbackWritebackStatus } from "../curriculum/continuity-adoption.js";

type Row = Record<string, unknown>;
export type D1LessonClassFeedbackStore = Pick<LessonRepository,
  "createLessonClassFeedback" | "markLessonClassFeedbackWriteback" | "listLessonClassFeedback" |
  "getPendingSemesterFrameworkWritebackIntent" | "enqueueSemesterFrameworkWritebackIntent" |
  "claimSemesterFrameworkWritebackIntent">;

export class D1LessonClassFeedbackRepository implements D1LessonClassFeedbackStore {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}

  async createLessonClassFeedback(ownerId: string, input: CreateLessonClassFeedbackInput) {
    const file = await this.database.query<{ id: string; notebook_id: string; lesson_blueprint_id: string | null }>({
      sql: "SELECT id, notebook_id, lesson_blueprint_id FROM lesson_files WHERE owner_id = ? AND id = ? LIMIT 1", params: [ownerId, input.lessonFileId],
    });
    const current = file.rows[0];
    if (!current) throw new Error("lesson_file_not_found");
    const now = this.clock(); const id = crypto.randomUUID();
    const writebackStatus = input.writebackStatus ?? defaultClassFeedbackWritebackStatus({ kind: input.kind, continuityOutcome: input.continuityOutcome ?? null });
    await this.database.query({ sql: `INSERT INTO lesson_class_feedback
      (id, owner_id, notebook_id, lesson_file_id, lesson_blueprint_id, semester_framework_id, kind, statement, related_entity_id, continuity_fingerprint, continuity_direction, continuity_outcome, writeback_status, evidence_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [
      id, ownerId, current.notebook_id, current.id, input.lessonBlueprintId ?? current.lesson_blueprint_id ?? null,
      input.semesterFrameworkId ?? null, input.kind, input.statement.trim(), input.relatedEntityId ?? null,
      input.continuityFingerprint ?? null, input.continuityDirection ?? null, input.continuityOutcome ?? null,
      writebackStatus ?? null, JSON.stringify(input.evidence ?? {}), now, now,
    ] });
    return (await this.require(ownerId, id));
  }

  async markLessonClassFeedbackWriteback(ownerId: string, feedbackId: string, status: "pending" | "applied" | "not_applicable") {
    await this.database.query({ sql: "UPDATE lesson_class_feedback SET writeback_status = ?, updated_at = ? WHERE owner_id = ? AND id = ?", params: [status, this.clock(), ownerId, feedbackId] });
    return this.require(ownerId, feedbackId);
  }

  async listLessonClassFeedback(ownerId: string, filter: Parameters<LessonRepository["listLessonClassFeedback"]>[1]) {
    if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100)) {
      throw new Error("class_feedback_limit_invalid");
    }
    const clauses = ["owner_id = ?"]; const params: Array<string | number | null> = [ownerId];
    if (filter.lessonFileId) { clauses.push("lesson_file_id = ?"); params.push(filter.lessonFileId); }
    if (filter.lessonBlueprintId) { clauses.push("lesson_blueprint_id = ?"); params.push(filter.lessonBlueprintId); }
    if (filter.semesterFrameworkId) { clauses.push("semester_framework_id = ?"); params.push(filter.semesterFrameworkId); }
    if (filter.limit !== undefined) params.push(filter.limit);
    const result = await this.database.query<Row>({ sql: `${select} WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC${filter.limit === undefined ? "" : " LIMIT ?"}`, params });
    return result.rows.map(record);
  }

  async getPendingSemesterFrameworkWritebackIntent(ownerId: string, frameworkId: string) {
    const result = await this.database.query<Row>({
      sql: `${writebackIntentSelect} WHERE owner_id = ? AND framework_id = ? AND state = 'pending' ORDER BY created_at, id LIMIT 1`,
      params: [ownerId, frameworkId],
    });
    return result.rows[0] ? writebackIntent(result.rows[0]) : null;
  }

  async enqueueSemesterFrameworkWritebackIntent(input: Parameters<LessonRepository["enqueueSemesterFrameworkWritebackIntent"]>[0]) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("framework_writeback_prompt_empty");
    const feedback = await this.database.query<Row>({
      sql: `${select} WHERE owner_id = ? AND id = ? AND semester_framework_id = ? LIMIT 1`,
      params: [input.ownerId, input.feedbackId, input.frameworkId],
    });
    if (!feedback.rows[0]) throw new Error("class_feedback_scope_invalid");
    const timestamp = this.clock();
    const candidate: SemesterFrameworkWritebackIntentRecord = {
      id: crypto.randomUUID(), ownerId: input.ownerId, frameworkId: input.frameworkId,
      feedbackId: input.feedbackId, prompt, state: "pending", createdAt: timestamp,
    };
    await this.database.query({
      sql: `INSERT INTO semester_framework_writeback_intents
        (id, owner_id, framework_id, feedback_id, prompt, state, run_id, created_at, claimed_at)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
        ON CONFLICT(feedback_id) DO NOTHING`,
      params: [candidate.id, candidate.ownerId, candidate.frameworkId, candidate.feedbackId, candidate.prompt, candidate.createdAt],
    });
    const stored = await this.database.query<Row>({
      sql: `${writebackIntentSelect} WHERE owner_id = ? AND feedback_id = ? LIMIT 1`,
      params: [input.ownerId, input.feedbackId],
    });
    if (!stored.rows[0]) throw new Error("framework_writeback_intent_not_created");
    return writebackIntent(stored.rows[0]);
  }

  async claimSemesterFrameworkWritebackIntent(input: Parameters<LessonRepository["claimSemesterFrameworkWritebackIntent"]>[0]) {
    const pending = await this.database.query<Row>({
      sql: `${writebackIntentSelect} WHERE owner_id = ? AND framework_id = ? AND id = ? AND state = 'pending' LIMIT 1`,
      params: [input.ownerId, input.frameworkId, input.intentId],
    });
    const intent = pending.rows[0];
    if (!intent) throw new Error("semester_framework_writeback_intent_unavailable");
    const claimedAt = this.clock();
    const result = await this.database.query({
      sql: `UPDATE semester_framework_writeback_intents SET state = 'claimed', run_id = ?, claimed_at = ?
        WHERE owner_id = ? AND framework_id = ? AND id = ? AND state = 'pending'`,
      params: [input.runId, claimedAt, input.ownerId, input.frameworkId, input.intentId],
    });
    if (!result.rowsAffected) throw new Error("semester_framework_writeback_intent_unavailable");
    return { ...writebackIntent(intent), state: "claimed" as const, runId: input.runId, claimedAt };
  }

  private async require(ownerId: string, feedbackId: string) {
    const result = await this.database.query<Row>({ sql: `${select} WHERE owner_id = ? AND id = ? LIMIT 1`, params: [ownerId, feedbackId] });
    if (!result.rows[0]) throw new Error("lesson_class_feedback_not_found");
    return record(result.rows[0]);
  }
}

const select = "SELECT id, notebook_id, lesson_file_id, lesson_blueprint_id, semester_framework_id, kind, statement, related_entity_id, continuity_fingerprint, continuity_direction, continuity_outcome, writeback_status, evidence_json, created_at, updated_at FROM lesson_class_feedback";
const writebackIntentSelect = "SELECT id, owner_id, framework_id, feedback_id, prompt, state, run_id, created_at, claimed_at FROM semester_framework_writeback_intents";
function record(row: Row): LessonClassFeedbackRecord { return {
  id: text(row.id), notebookId: text(row.notebook_id), lessonFileId: text(row.lesson_file_id), lessonBlueprintId: nullable(row.lesson_blueprint_id), semesterFrameworkId: nullable(row.semester_framework_id),
  kind: text(row.kind) as LessonClassFeedbackRecord["kind"], statement: text(row.statement), relatedEntityId: nullable(row.related_entity_id), continuityFingerprint: nullable(row.continuity_fingerprint),
  continuityDirection: nullable(row.continuity_direction) as LessonClassFeedbackRecord["continuityDirection"], continuityOutcome: nullable(row.continuity_outcome) as LessonClassFeedbackRecord["continuityOutcome"],
  writebackStatus: nullable(row.writeback_status) as LessonClassFeedbackRecord["writebackStatus"], evidence: json(row.evidence_json), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
}; }
function writebackIntent(row: Row): SemesterFrameworkWritebackIntentRecord { return {
  id: text(row.id), ownerId: text(row.owner_id), frameworkId: text(row.framework_id), feedbackId: text(row.feedback_id),
  prompt: text(row.prompt), state: text(row.state) as SemesterFrameworkWritebackIntentRecord["state"],
  runId: nullable(row.run_id) ?? undefined, createdAt: text(row.created_at), claimedAt: nullable(row.claimed_at) ?? undefined,
}; }
function json(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
const text = (value: unknown) => String(value ?? ""); const nullable = (value: unknown) => value == null ? null : String(value);
