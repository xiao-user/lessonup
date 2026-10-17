import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import type { LearningCommand, LearningCursor, LearningEvidence, LearningInquiry, LearningRecord, LearningRepository } from "../learning/domain.js";
import { learningReviewContext } from "../learning/review-context.js";

export class D1LearningRepository implements LearningRepository {
  constructor(private readonly database: SqlDatabase) {}
  async listLearningReviews(ownerId: string, scope: { lessonFileId?: string; lessonBlueprintId?: string; limit: number }) {
    if ((!scope.lessonFileId && !scope.lessonBlueprintId) || !Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 100) throw new Error("learning_scope_invalid");
    const result = await this.database.query<{ inquiry: string; baseline: string; followup: string }>({
      sql: `SELECT i.record_json AS inquiry, b.record_json AS baseline, f.record_json AS followup
        FROM learning_inquiries i JOIN lesson_files l ON l.owner_id = i.owner_id AND l.id = i.lesson_file_id
        JOIN learning_evidence b ON b.owner_id = i.owner_id AND b.id = i.baseline_evidence_id AND b.lesson_file_id = i.lesson_file_id
        JOIN learning_evidence f ON f.owner_id = i.owner_id AND f.id = json_extract(i.record_json, '$.review.evidenceId') AND f.lesson_file_id = i.lesson_file_id AND f.inquiry_id = i.id
        WHERE i.owner_id = ? AND i.state = 'reviewed'${scope.lessonFileId ? " AND i.lesson_file_id = ?" : ""}${scope.lessonBlueprintId ? " AND l.lesson_blueprint_id = ?" : ""}
        ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
      params: [ownerId, ...(scope.lessonFileId ? [scope.lessonFileId] : []), ...(scope.lessonBlueprintId ? [scope.lessonBlueprintId] : []), scope.limit],
    });
    return result.rows.map((row) => learningReviewContext(JSON.parse(row.inquiry), JSON.parse(row.baseline), JSON.parse(row.followup)));
  }
  private async list<T>(table: "learning_evidence" | "learning_inquiries", ownerId: string, fileId: string, limit: number, before?: LearningCursor): Promise<T[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("learning_limit_invalid");
    const order = table === "learning_evidence" ? "observed_at" : "updated_at";
    const delivered = table === "learning_inquiries" ? " AND (source_run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.owner_id = learning_inquiries.owner_id AND r.id = learning_inquiries.source_run_id AND r.status = 'completed'))" : "";
    const cursor = before ? ` AND (${order}, id) < (?, ?)` : "";
    const result = await this.database.query<{ record_json: string }>({
      sql: `SELECT record_json FROM ${table} WHERE owner_id = ? AND lesson_file_id = ?${delivered}${cursor} ORDER BY ${order} DESC, id DESC LIMIT ?`,
      params: [ownerId, fileId, ...(before ? [before.at, before.id] : []), limit],
    });
    return result.rows.map((row) => JSON.parse(row.record_json) as T);
  }
  private async get<T>(table: "learning_evidence" | "learning_inquiries", ownerId: string, id: string): Promise<T | null> {
    const result = await this.database.query<{ record_json: string }>({ sql: `SELECT record_json FROM ${table} WHERE owner_id = ? AND id = ?`, params: [ownerId, id] });
    return result.rows[0] ? JSON.parse(result.rows[0].record_json) as T : null;
  }
  listLearningEvidence(ownerId: string, fileId: string, limit: number, before?: LearningCursor) { return this.list<LearningEvidence>("learning_evidence", ownerId, fileId, limit, before); }
  listLearningInquiries(ownerId: string, fileId: string, limit: number, before?: LearningCursor) { return this.list<LearningInquiry>("learning_inquiries", ownerId, fileId, limit, before); }
  getLearningEvidence(ownerId: string, id: string) { return this.get<LearningEvidence>("learning_evidence", ownerId, id); }
  getLearningInquiry(ownerId: string, id: string) { return this.get<LearningInquiry>("learning_inquiries", ownerId, id); }

  async getLearningCommandResult(ownerId: string, idempotencyKey: string): Promise<LearningRecord | null> {
    const result = await this.database.query<{ response_json: string }>({
      sql: "SELECT response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'learning' AND idempotency_key = ?",
      params: [ownerId, idempotencyKey],
    });
    return result.rows[0] ? JSON.parse(result.rows[0].response_json) as LearningRecord : null;
  }
  async replayLearningCommand(ownerId: string, command: LearningCommand): Promise<LearningRecord | null> {
    const result = await this.database.query<{ request_fingerprint: string; response_json: string }>({
      sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'learning' AND idempotency_key = ?",
      params: [ownerId, command.idempotencyKey],
    });
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_fingerprint !== command.fingerprint) throw new Error("idempotency_conflict");
    return JSON.parse(row.response_json) as LearningRecord;
  }
  private async persist<T extends LearningRecord>(record: T, command: LearningCommand, writes: SqlStatement[]): Promise<T> {
    const replay = await this.replayLearningCommand(record.ownerId, command);
    if (replay) return replay as T;
    const json = JSON.stringify(record);
    try {
      const result = await this.database.batch([...writes, {
        sql: `INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at)
          SELECT ?, 'learning', ?, ?, ?, ? WHERE changes() = 1`,
        params: [record.ownerId, command.idempotencyKey, command.fingerprint, json, record.createdAt],
      }]);
      if (result[0]?.rowsAffected !== 1) throw new Error("stale_learning_inquiry");
      return record;
    } catch (error) {
      const replay = await this.replayLearningCommand(record.ownerId, command);
      if (replay) return replay as T;
      throw error;
    }
  }
  saveLearningEvidence(record: LearningEvidence, command: LearningCommand) {
    const inquiryGuard = record.inquiryId ? " AND EXISTS (SELECT 1 FROM learning_inquiries WHERE owner_id = ? AND id = ? AND lesson_file_id = ? AND state = 'implemented' AND version = ?)" : "";
    return this.persist(record, command, [{
      sql: `INSERT INTO learning_evidence (id, owner_id, notebook_id, lesson_file_id, inquiry_id, observed_at, created_at, record_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM lesson_files WHERE owner_id = ? AND id = ? AND notebook_id = ? AND document_version = ?${inquiryGuard}`,
      params: [record.id, record.ownerId, record.notebookId, record.lessonFileId, record.inquiryId ?? null, record.observedAt,
        record.createdAt, JSON.stringify(record), record.ownerId, record.lessonFileId, record.notebookId, command.documentVersion ?? -1,
        ...(record.inquiryId ? [record.ownerId, record.inquiryId, record.lessonFileId, command.inquiryVersion ?? -1] : [])],
    }]);
  }
  saveLearningInquiry(record: LearningInquiry, expectedVersion: number | null, command: LearningCommand) {
    const json = JSON.stringify(record);
    const guard = command.documentVersion === undefined ? "" : " AND document_version = ?";
    const guardParams = command.documentVersion === undefined ? [] : [command.documentVersion];
    const scope = `EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND notebook_id = ?${guard})`;
    const scopeParams = [record.ownerId, record.lessonFileId, record.notebookId, ...guardParams];
    const write: SqlStatement = expectedVersion === null ? {
      sql: `INSERT INTO learning_inquiries (id, owner_id, notebook_id, lesson_file_id, baseline_evidence_id, source_run_id, state, version, created_at, updated_at, record_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${scope}`,
      params: [record.id, record.ownerId, record.notebookId, record.lessonFileId, record.baselineEvidenceId, record.sourceRunId ?? null,
        record.state, record.version, record.createdAt, record.updatedAt, json, ...scopeParams],
    } : {
      sql: `UPDATE learning_inquiries SET state = ?, version = ?, updated_at = ?, record_json = ?
        WHERE owner_id = ? AND id = ? AND lesson_file_id = ? AND version = ? AND ${scope}`,
      params: [record.state, record.version, record.updatedAt, json, record.ownerId, record.id, record.lessonFileId, expectedVersion, ...scopeParams],
    };
    return this.persist(record, command, [write, {
      sql: "INSERT INTO learning_inquiry_versions (owner_id, inquiry_id, version, record_json, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1",
      params: [record.ownerId, record.id, record.version, json, record.updatedAt],
    }]);
  }
}
