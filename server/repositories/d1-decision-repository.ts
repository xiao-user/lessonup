import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import type { DecisionCommand, DecisionCursor, DecisionEvent, DecisionRecord, EvidenceCard } from "../decisions/contracts.js";
import type { DecisionRepository } from "../decisions/repository.js";

export class D1DecisionRepository implements DecisionRepository {
  constructor(private readonly database: SqlDatabase) {}

  async listDecisions(ownerId: string, lessonFileId: string, limit: number, before?: DecisionCursor) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("decision_limit_invalid");
    const cursor = before ? " AND (updated_at, id) < (?, ?)" : "";
    const result = await this.database.query<{ record_json: string }>({
      sql: `SELECT record_json FROM lesson_decisions WHERE owner_id = ? AND lesson_file_id = ?${cursor}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
      params: [ownerId, lessonFileId, ...(before ? [before.at, before.id] : []), limit],
    });
    return result.rows.map((row) => JSON.parse(row.record_json) as DecisionRecord);
  }

  async getDecision(ownerId: string, decisionId: string) {
    const result = await this.database.query<{ record_json: string }>({
      sql: "SELECT record_json FROM lesson_decisions WHERE owner_id = ? AND id = ?",
      params: [ownerId, decisionId],
    });
    return result.rows[0] ? JSON.parse(result.rows[0].record_json) as DecisionRecord : null;
  }

  async listDecisionVersions(ownerId: string, decisionId: string) {
    const result = await this.database.query<{ record_json: string }>({
      sql: "SELECT record_json FROM lesson_decision_versions WHERE owner_id = ? AND decision_id = ? ORDER BY version ASC",
      params: [ownerId, decisionId],
    });
    return result.rows.map((row) => JSON.parse(row.record_json) as DecisionRecord);
  }

  async listDecisionEvidenceCards(ownerId: string, lessonFileId: string, evidenceIds?: string[]) {
    if (evidenceIds && evidenceIds.length === 0) return [];
    if (!evidenceIds) {
      const result = await this.database.query<{ record_json: string }>({
        sql: "SELECT record_json FROM lesson_evidence_cards WHERE owner_id = ? AND lesson_file_id = ? ORDER BY created_at DESC LIMIT 200",
        params: [ownerId, lessonFileId],
      });
      return result.rows.map((row) => JSON.parse(row.record_json) as EvidenceCard);
    }
    const placeholders = evidenceIds.map(() => "?").join(", ");
    const result = await this.database.query<{ record_json: string }>({
      sql: `SELECT record_json FROM lesson_evidence_cards WHERE owner_id = ? AND lesson_file_id = ? AND id IN (${placeholders})`,
      params: [ownerId, lessonFileId, ...evidenceIds],
    });
    return result.rows.map((row) => JSON.parse(row.record_json) as EvidenceCard);
  }

  async getDecisionCommandResult(ownerId: string, idempotencyKey: string) {
    const result = await this.database.query<{ response_json: string }>({
      sql: "SELECT response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'decision' AND idempotency_key = ?",
      params: [ownerId, idempotencyKey],
    });
    return result.rows[0] ? JSON.parse(result.rows[0].response_json) as DecisionRecord : null;
  }

  async replayDecisionCommand(ownerId: string, command: DecisionCommand) {
    const result = await this.database.query<{ request_fingerprint: string; response_json: string }>({
      sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = 'decision' AND idempotency_key = ?",
      params: [ownerId, command.idempotencyKey],
    });
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_fingerprint !== command.fingerprint) throw new Error("idempotency_conflict");
    return JSON.parse(row.response_json) as DecisionRecord;
  }

  async saveDecisionEvent(event: DecisionEvent) {
    const result = await this.database.query<{ id: string }>({
      sql: `INSERT INTO lesson_decision_events (id, owner_id, lesson_file_id, event_type, record_json, created_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ?)`,
      params: [event.id, event.ownerId, event.lessonFileId, event.type, JSON.stringify(event), event.createdAt,
        event.ownerId, event.lessonFileId],
    });
    if (result.rowsAffected !== 1) throw new Error("lesson_file_not_found");
    return event;
  }

  async listDecisionEvents(ownerId: string, lessonFileId: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("decision_limit_invalid");
    const result = await this.database.query<{ record_json: string }>({
      sql: `SELECT record_json FROM lesson_decision_events WHERE owner_id = ? AND lesson_file_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      params: [ownerId, lessonFileId, limit],
    });
    return result.rows.map((row) => JSON.parse(row.record_json) as DecisionEvent);
  }

  async saveDecision(
    record: DecisionRecord,
    expectedVersion: number | null,
    command: DecisionCommand,
    evidenceCards: EvidenceCard[],
  ) {
    const replay = await this.replayDecisionCommand(record.ownerId, command);
    if (replay) return replay;
    const json = JSON.stringify(record);
    const writes: SqlStatement[] = [];
    if (expectedVersion === null) {
      const origin = command.agentRun;
      const modelProposal = record.provenance.createdBy === "agent" || record.provenance.modelRunId !== null;
      if (modelProposal && (!origin || origin.runId !== record.provenance.modelRunId)) throw new Error("decision_scope_invalid");
      const runGuard = !modelProposal ? "" : ` AND EXISTS (
        SELECT 1 FROM agent_runs r
        JOIN agent_threads t ON t.owner_id = r.owner_id AND t.id = r.thread_id
        JOIN agent_branches b ON b.owner_id = r.owner_id AND b.thread_id = r.thread_id AND b.id = r.branch_id
        WHERE r.owner_id = ? AND r.id = ? AND r.thread_id = ? AND r.branch_id = ?
          AND r.status = 'running' AND r.cancel_requested_at IS NULL
          AND t.resource_type = 'lesson_file' AND t.lesson_file_id = ?
      )`;
      writes.push({
        sql: `INSERT INTO lesson_decisions (id, owner_id, notebook_id, lesson_file_id, decision_type, status, version,
            chosen_option_id, confidence, review_at, created_at, updated_at, record_json)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND notebook_id = ? AND document_version = ?
          )${runGuard}`,
        params: [record.id, record.ownerId, record.notebookId, record.lessonFileId, record.decisionType, record.status,
          record.version, record.chosenOptionId, record.confidence, record.reviewAt, record.createdAt, record.updatedAt, json,
          record.ownerId, record.lessonFileId, record.notebookId, command.documentVersion ?? -1,
          ...(modelProposal ? [record.ownerId, origin!.runId, origin!.threadId, origin!.branchId, record.lessonFileId] : [])],
      });
    } else {
      writes.push({
        sql: `UPDATE lesson_decisions SET status = ?, version = ?, chosen_option_id = ?, confidence = ?, review_at = ?,
            updated_at = ?, record_json = ?
          WHERE owner_id = ? AND id = ? AND lesson_file_id = ? AND version = ?${command.documentVersion === undefined ? "" : " AND EXISTS (SELECT 1 FROM lesson_files WHERE owner_id = ? AND id = ? AND document_version = ?)"}`,
        params: [record.status, record.version, record.chosenOptionId, record.confidence, record.reviewAt,
          record.updatedAt, json, record.ownerId, record.id, record.lessonFileId, expectedVersion,
          ...(command.documentVersion === undefined ? [] : [record.ownerId, record.lessonFileId, command.documentVersion])],
      });
    }
    writes.push({
      sql: `INSERT INTO lesson_decision_versions (owner_id, decision_id, version, record_json, created_at)
        SELECT ?, ?, ?, ?, ? WHERE changes() = 1`,
      params: [record.ownerId, record.id, record.version, json, record.updatedAt],
    });
    // The receipt follows the version insert immediately. changes() cannot be
    // confused with a rival command's already-existing version or evidence row.
    writes.push({
      sql: `INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at)
        SELECT ?, 'decision', ?, ?, ?, ? WHERE changes() = 1`,
      params: [record.ownerId, command.idempotencyKey, command.fingerprint, json, record.updatedAt],
    });
    const receiptIndex = writes.length - 1;
    for (const card of evidenceCards) {
      writes.push({
        sql: `INSERT INTO lesson_evidence_cards (id, owner_id, notebook_id, lesson_file_id, kind, level, pii_level, record_json, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM operation_idempotency WHERE owner_id = ? AND operation = 'decision'
              AND idempotency_key = ? AND request_fingerprint = ? AND response_json = ?
          )`,
        params: [card.id, record.ownerId, record.notebookId, record.lessonFileId, card.kind, card.level, card.piiLevel,
          JSON.stringify(card), record.updatedAt, record.ownerId, command.idempotencyKey, command.fingerprint, json],
      });
    }
    try {
      const result = await this.database.batch(writes);
      if (result[receiptIndex]?.rowsAffected !== 1) throw new Error("stale_decision");
      return record;
    } catch (error) {
      const replayAfter = await this.replayDecisionCommand(record.ownerId, command).catch(() => null);
      if (replayAfter) return replayAfter;
      throw error;
    }
  }
}
