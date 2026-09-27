import { lessonPlanSchema } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { dashiGoalSchema } from "../presentations/dashi-goal.js";
import type {
  BeginClassroomPresentationGenerationResult,
  ClassroomPresentationGeneration,
  DirectClassroomPresentationRecord,
} from "../presentations/domain.js";
import type { SqlDatabase } from "../platform/sql-database.js";

type Row = Record<string, unknown>;

export type D1ClassroomPresentationStore = Pick<LessonRepository,
  "findClassroomPresentationByRequest" | "saveClassroomPresentation" | "listClassroomPresentations" |
  "listClassroomPresentationsForOwner" | "listRecentClassroomPresentations" | "getClassroomPresentation" |
  "updateClassroomPresentationArtifact" | "updateClassroomPresentationGoal" | "deleteClassroomPresentation" | "beginClassroomPresentationGeneration" |
  "getLatestClassroomPresentationGeneration" | "completeClassroomPresentationGeneration" |
  "failClassroomPresentationGeneration" | "recoverInterruptedClassroomPresentationGenerations"
>;

/** Durable presentation metadata. Deck bytes live exclusively in ObjectStorage/R2. */
export class D1ClassroomPresentationRepository implements D1ClassroomPresentationStore {
  constructor(private readonly database: SqlDatabase) {}

  async findClassroomPresentationByRequest(ownerId: string, idempotencyKey: string) {
    return this.onePresentation("WHERE owner_id = ? AND idempotency_key = ? LIMIT 1", [ownerId, idempotencyKey]);
  }

  async saveClassroomPresentation(presentation: DirectClassroomPresentationRecord) {
    const replay = await this.findClassroomPresentationByRequest(presentation.ownerId, presentation.idempotencyKey);
    if (replay) return replay;
    await this.database.query({
      sql: `INSERT OR IGNORE INTO classroom_presentation_documents
        (id, owner_id, notebook_id, lesson_file_id, title, theme, source_document_version, source_document_json, dashi_goal_json, delivery, storage_key, media_type, byte_size, checksum, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [presentation.id, presentation.ownerId, presentation.notebookId, presentation.lessonFileId, presentation.title,
        presentation.theme, presentation.sourceDocumentVersion, JSON.stringify(presentation.sourceDocument),
        presentation.dashiGoal ? JSON.stringify(presentation.dashiGoal) : null, presentation.delivery, presentation.storageKey,
        presentation.mediaType, presentation.byteSize, presentation.checksum, presentation.idempotencyKey,
        presentation.createdAt, presentation.updatedAt],
    });
    const stored = await this.findClassroomPresentationByRequest(presentation.ownerId, presentation.idempotencyKey);
    if (!stored) throw new Error("presentation_save_failed");
    return stored;
  }

  async listClassroomPresentations(ownerId: string, lessonFileId: string) {
    const result = await this.database.query<Row>({
      sql: `${presentationSelect} WHERE owner_id = ? AND lesson_file_id = ? ORDER BY updated_at DESC, id`,
      params: [ownerId, lessonFileId],
    });
    return result.rows.map(presentation);
  }

  async listClassroomPresentationsForOwner(ownerId: string) {
    const result = await this.database.query<Row>({ sql: `${presentationSelect} WHERE owner_id = ? ORDER BY updated_at DESC, id`, params: [ownerId] });
    return result.rows.map(presentation);
  }

  async listRecentClassroomPresentations(ownerId: string, limit = 8) {
    const result = await this.database.query<Row>({ sql: `${presentationSelect} WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT ?`, params: [ownerId, Math.max(1, Math.min(limit, 100))] });
    return result.rows.map(presentation);
  }

  async getClassroomPresentation(ownerId: string, presentationId: string) {
    return this.onePresentation("WHERE owner_id = ? AND id = ? LIMIT 1", [ownerId, presentationId]);
  }

  async updateClassroomPresentationArtifact(args: {
    ownerId: string; presentationId: string; storageKey: string; byteSize: number; updatedAt: string;
  }) {
    await this.database.query({
      sql: "UPDATE classroom_presentation_documents SET storage_key = ?, byte_size = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
      params: [args.storageKey, args.byteSize, args.updatedAt, args.ownerId, args.presentationId],
    });
    const updated = await this.getClassroomPresentation(args.ownerId, args.presentationId);
    if (!updated) throw new Error("presentation_not_found");
    return updated;
  }

  async updateClassroomPresentationGoal(args: Parameters<LessonRepository["updateClassroomPresentationGoal"]>[0]) {
    const result = await this.database.query({
      sql: "UPDATE classroom_presentation_documents SET title = ?, theme = ?, dashi_goal_json = ?, checksum = ?, updated_at = ?, storage_key = COALESCE(?, storage_key), byte_size = COALESCE(?, byte_size) WHERE owner_id = ? AND id = ? AND checksum = ? RETURNING *",
      params: [args.goal.title, args.goal.themePack, JSON.stringify(args.goal), args.checksum, args.updatedAt,
        args.artifact?.storageKey ?? null, args.artifact?.byteSize ?? null, args.ownerId, args.presentationId, args.expectedChecksum],
    });
    if (!result.rowsAffected) {
      const current = await this.getClassroomPresentation(args.ownerId, args.presentationId);
      throw new Error(current ? "presentation_edit_conflict" : "presentation_not_found");
    }
    return presentation(result.rows[0]!);
  }

  async deleteClassroomPresentation(ownerId: string, presentationId: string) {
    const result = await this.database.query({ sql: "DELETE FROM classroom_presentation_documents WHERE owner_id = ? AND id = ?", params: [ownerId, presentationId] });
    if (!result.rowsAffected) throw new Error("presentation_not_found");
  }

  async beginClassroomPresentationGeneration(generation: ClassroomPresentationGeneration): Promise<BeginClassroomPresentationGenerationResult> {
    const insert = await this.database.query({
      sql: `INSERT OR IGNORE INTO classroom_presentation_generations
        (id, owner_id, notebook_id, lesson_file_id, source_document_version, source_document_json, lesson_title, subject, grade_level, learner_profile, lesson_duration_minutes, storyboard_json, status, presentation_id, error_code, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', NULL, NULL, ?)`,
      params: [generation.id, generation.ownerId, generation.notebookId, generation.lessonFileId, generation.sourceDocumentVersion,
        JSON.stringify(generation.sourceDocument), generation.lessonTitle, generation.subject, generation.gradeLevel,
        generation.learnerProfile, generation.lessonDurationMinutes, generation.goal ? JSON.stringify(generation.goal) : null,
        generation.startedAt],
    });
    if (insert.rowsAffected) return { generation, created: true };
    const active = await this.oneGeneration("WHERE owner_id = ? AND lesson_file_id = ? AND status = 'generating' LIMIT 1", [generation.ownerId, generation.lessonFileId]);
    if (active) return { generation: active, created: false };
    throw new Error("presentation_generation_start_failed");
  }

  async getLatestClassroomPresentationGeneration(ownerId: string, lessonFileId: string) {
    return this.oneGeneration("WHERE owner_id = ? AND lesson_file_id = ? ORDER BY CASE status WHEN 'generating' THEN 0 ELSE 1 END, started_at DESC, id LIMIT 1", [ownerId, lessonFileId]);
  }

  async completeClassroomPresentationGeneration(args: { ownerId: string; generationId: string; presentationId: string; completedAt: string; durationMs: number }) {
    return this.finishGeneration(args, "ready", args.presentationId, null);
  }

  async failClassroomPresentationGeneration(args: { ownerId: string; generationId: string; errorCode: string; completedAt: string; durationMs: number }) {
    return this.finishGeneration(args, "failed", null, args.errorCode);
  }

  async recoverInterruptedClassroomPresentationGenerations(completedAt: string) {
    const pending = await this.database.query<{ id: string; owner_id: string; started_at: string }>({ sql: "SELECT id, owner_id, started_at FROM classroom_presentation_generations WHERE status = 'generating'" });
    if (!pending.rows.length) return 0;
    const results = await this.database.batch(pending.rows.map((row) => ({
      sql: `UPDATE classroom_presentation_generations SET status = 'failed', presentation_id = NULL, error_code = 'presentation_generation_interrupted', completed_at = ?, duration_ms = ?
        WHERE owner_id = ? AND id = ? AND status = 'generating'`,
      params: [completedAt, Math.max(0, Date.parse(completedAt) - Date.parse(row.started_at)), row.owner_id, row.id],
    })));
    return results.reduce((total, result) => total + result.rowsAffected, 0);
  }

  private async finishGeneration(args: { ownerId: string; generationId: string; completedAt: string; durationMs: number }, status: "ready" | "failed", presentationId: string | null, errorCode: string | null) {
    await this.database.query({
      sql: "UPDATE classroom_presentation_generations SET status = ?, presentation_id = ?, error_code = ?, completed_at = ?, duration_ms = ? WHERE owner_id = ? AND id = ? AND status = 'generating'",
      params: [status, presentationId, errorCode, args.completedAt, args.durationMs, args.ownerId, args.generationId],
    });
    const updated = await this.oneGeneration("WHERE owner_id = ? AND id = ? LIMIT 1", [args.ownerId, args.generationId]);
    if (!updated || updated.status !== status) throw new Error("presentation_generation_not_found");
    return updated;
  }

  private async onePresentation(where: string, params: Array<string | number | null>) {
    const result = await this.database.query<Row>({ sql: `${presentationSelect} ${where}`, params });
    return result.rows[0] ? presentation(result.rows[0]) : null;
  }

  private async oneGeneration(where: string, params: Array<string | number | null>) {
    const result = await this.database.query<Row>({ sql: `${generationSelect} ${where}`, params });
    return result.rows[0] ? generation(result.rows[0]) : null;
  }
}

const presentationSelect = "SELECT id, owner_id, notebook_id, lesson_file_id, title, theme, source_document_version, source_document_json, dashi_goal_json, delivery, storage_key, media_type, byte_size, checksum, idempotency_key, created_at, updated_at FROM classroom_presentation_documents";
const generationSelect = "SELECT id, owner_id, notebook_id, lesson_file_id, source_document_version, source_document_json, lesson_title, subject, grade_level, learner_profile, lesson_duration_minutes, storyboard_json, status, presentation_id, error_code, started_at, completed_at, duration_ms FROM classroom_presentation_generations";

function presentation(row: Row): DirectClassroomPresentationRecord {
  return {
    id: text(row.id), ownerId: text(row.owner_id), notebookId: text(row.notebook_id), lessonFileId: text(row.lesson_file_id), title: text(row.title),
    theme: text(row.theme) as DirectClassroomPresentationRecord["theme"], sourceDocumentVersion: number(row.source_document_version),
    sourceDocument: lessonPlanSchema.parse(json(row.source_document_json, {})), dashiGoal: dashiGoalSchema.safeParse(json(row.dashi_goal_json, null)).data ?? null,
    delivery: row.delivery === "native-dashi" ? "native-dashi" : "legacy-static", storageKey: text(row.storage_key), mediaType: text(row.media_type),
    byteSize: number(row.byte_size), checksum: text(row.checksum), idempotencyKey: text(row.idempotency_key), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  };
}

function generation(row: Row): ClassroomPresentationGeneration {
  return {
    id: text(row.id), ownerId: text(row.owner_id), notebookId: text(row.notebook_id), lessonFileId: text(row.lesson_file_id),
    sourceDocumentVersion: number(row.source_document_version), sourceDocument: lessonPlanSchema.parse(json(row.source_document_json, {})),
    lessonTitle: text(row.lesson_title), subject: text(row.subject), gradeLevel: text(row.grade_level), learnerProfile: text(row.learner_profile),
    lessonDurationMinutes: number(row.lesson_duration_minutes), goal: dashiGoalSchema.safeParse(json(row.storyboard_json, null)).data ?? null,
    status: text(row.status) as ClassroomPresentationGeneration["status"], presentationId: nullable(row.presentation_id), errorCode: nullable(row.error_code),
    startedAt: text(row.started_at), completedAt: nullable(row.completed_at), durationMs: row.duration_ms == null ? null : number(row.duration_ms),
  };
}

function json(value: unknown, fallback: unknown) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
const text = (value: unknown) => String(value ?? "");
const number = (value: unknown) => Number(value ?? 0);
const nullable = (value: unknown) => value == null ? null : String(value);
