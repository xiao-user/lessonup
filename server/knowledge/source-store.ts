import type { SqlDatabase } from "../platform/sql-database.js";

export type KnowledgeScope = "public" | "user" | "notebook" | "file";
export type KnowledgeStatus = "queued" | "processing" | "ready" | "failed" | "deleted";

export type KnowledgeSourceRecord = {
  id: string;
  owner_id: string;
  notebook_id: string | null;
  lesson_file_id: string | null;
  scope: KnowledgeScope;
  title: string;
  media_type: string;
  storage_key: string | null;
  source_version: number;
  status: KnowledgeStatus;
  index_version: string | null;
  metadata: Record<string, unknown>;
  upload_idempotency_key: string | null;
  attached_message_id: string | null;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  worker_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export interface KnowledgeSourceStore {
  findByUploadIdempotency(ownerId: string, idempotencyKey: string): Promise<KnowledgeSourceRecord | null>;
  enqueue(source: KnowledgeSourceRecord): Promise<KnowledgeSourceRecord>;
  list(ownerId: string, scope: { notebookId?: string; lessonFileId?: string; includeAttached?: boolean }): Promise<KnowledgeSourceRecord[]>;
  get(ownerId: string, sourceId: string): Promise<KnowledgeSourceRecord | null>;
  retry(ownerId: string, sourceId: string, now: string): Promise<KnowledgeSourceRecord | null>;
  delete(ownerId: string, sourceId: string): Promise<KnowledgeSourceRecord | null>;
  listIds(ownerId: string, scope: "notebook" | "lessonFile", resourceId: string): Promise<string[]>;
  audit(ownerId: string, sourceId: string, action: string, details: unknown, createdAt: string): Promise<void>;
  listExpiredDraftIds(ownerId: string, cutoff: string, limit: number): Promise<string[]>;
}

/** In-process implementation for deterministic application and browser tests. */
export class MemoryKnowledgeSourceStore implements KnowledgeSourceStore {
  private readonly sources = new Map<string, KnowledgeSourceRecord>();

  async findByUploadIdempotency(ownerId: string, idempotencyKey: string) {
    return this.clone([...this.sources.values()].find((source) => (
      source.owner_id === ownerId && source.upload_idempotency_key === idempotencyKey
    )) ?? null);
  }

  async enqueue(source: KnowledgeSourceRecord) {
    const existing = source.upload_idempotency_key
      ? await this.findByUploadIdempotency(source.owner_id, source.upload_idempotency_key)
      : null;
    if (existing) return existing;
    this.sources.set(source.id, structuredClone(source));
    return structuredClone(source);
  }

  async list(ownerId: string, scope: { notebookId?: string; lessonFileId?: string; includeAttached?: boolean }) {
    return [...this.sources.values()]
      .filter((source) => source.owner_id === ownerId && source.status !== "deleted")
      .filter((source) => scope.includeAttached || source.attached_message_id === null)
      .filter((source) => !scope.lessonFileId || source.lesson_file_id === scope.lessonFileId)
      .filter((source) => scope.lessonFileId || !scope.notebookId || source.notebook_id === scope.notebookId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((source) => structuredClone(source));
  }

  async get(ownerId: string, sourceId: string) {
    const source = this.sources.get(sourceId);
    return this.clone(source?.owner_id === ownerId ? source : null);
  }

  async retry(ownerId: string, sourceId: string, timestamp: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.owner_id !== ownerId || source.status !== "failed") return null;
    const updated: KnowledgeSourceRecord = {
      ...source, status: "queued", attempt_count: 0, available_at: timestamp,
      lease_expires_at: null, worker_id: null, last_error: null, updated_at: timestamp,
    };
    this.sources.set(sourceId, updated);
    return structuredClone(updated);
  }

  async delete(ownerId: string, sourceId: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.owner_id !== ownerId) return null;
    this.sources.delete(sourceId);
    return structuredClone(source);
  }

  async listIds(ownerId: string, scope: "notebook" | "lessonFile", resourceId: string) {
    return [...this.sources.values()]
      .filter((source) => source.owner_id === ownerId)
      .filter((source) => scope === "notebook"
        ? source.notebook_id === resourceId
        : source.lesson_file_id === resourceId)
      .map((source) => source.id);
  }

  async audit() {}

  async listExpiredDraftIds(ownerId: string, cutoff: string, limit: number) {
    return [...this.sources.values()]
      .filter((source) => source.owner_id === ownerId && source.attached_message_id === null)
      .filter((source) => source.status !== "deleted" && source.updated_at < cutoff)
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      .slice(0, limit)
      .map((source) => source.id);
  }

  async markAttached(ownerId: string, sourceId: string, messageId: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.owner_id !== ownerId) return null;
    const updated = { ...source, attached_message_id: messageId, updated_at: new Date().toISOString() };
    this.sources.set(sourceId, updated);
    return structuredClone(updated);
  }

  private clone(source: KnowledgeSourceRecord | null) {
    return source ? structuredClone(source) : null;
  }
}

export type IndexedKnowledgeChunk = {
  stableChunkId: string;
  section?: string;
  page?: number;
  passage: string;
  adjacentBefore?: string;
  adjacentAfter?: string;
  embedding: number[];
};

/** Queue operations used by the asynchronous parser/indexer. */
export interface KnowledgeIndexQueue {
  claim(workerId: string, now: string, leaseExpiresAt: string): Promise<KnowledgeSourceRecord | null>;
  heartbeat(sourceId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<void>;
  stage(sourceId: string, workerId: string, indexVersion: string, chunks: IndexedKnowledgeChunk[], now: string): Promise<void>;
  publish(sourceId: string, workerId: string, indexVersion: string, expectedCount: number, metadata: Record<string, unknown>, now: string): Promise<void>;
  fail(sourceId: string, workerId: string, error: string, now: string): Promise<void>;
}

type D1SourceRow = Omit<KnowledgeSourceRecord, "metadata"> & { metadata_json: string };

/**
 * D1-only implementation of the metadata queue. It deliberately uses the
 * generic SqlDatabase port, so the same class shape can be reproduced for
 * PostgreSQL without exposing D1 bindings to upload services.
 */
export class D1KnowledgeSourceStore implements KnowledgeSourceStore, KnowledgeIndexQueue {
  constructor(private readonly database: SqlDatabase) {}

  async findByUploadIdempotency(ownerId: string, idempotencyKey: string) {
    const result = await this.database.query<D1SourceRow>({
      sql: `${selectSource} WHERE owner_id = ? AND upload_idempotency_key = ?`,
      params: [ownerId, idempotencyKey],
    });
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async enqueue(source: KnowledgeSourceRecord) {
    const existing = await this.findByUploadIdempotency(source.owner_id, source.upload_idempotency_key ?? "");
    if (existing) return existing;
    await this.database.batch([
      {
        sql: `INSERT INTO knowledge_sources (
          id, owner_id, notebook_id, lesson_file_id, scope, title, media_type,
          storage_key, source_version, status, index_version, metadata_json,
          upload_idempotency_key, attached_message_id, attempt_count, max_attempts,
          available_at, lease_expires_at, worker_id, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: sourceParams(source),
      },
      {
        sql: "INSERT INTO knowledge_audit_events (id, owner_id, source_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [crypto.randomUUID(), source.owner_id, source.id, "upload.queued", JSON.stringify({ scope: source.scope, storageKey: source.storage_key }), source.created_at],
      },
    ]);
    return source;
  }

  async list(ownerId: string, scope: { notebookId?: string; lessonFileId?: string; includeAttached?: boolean }) {
    const where = ["owner_id = ?", "status <> 'deleted'"];
    const params: Array<string> = [ownerId];
    if (!scope.includeAttached) where.push("attached_message_id IS NULL");
    if (scope.lessonFileId) { where.push("lesson_file_id = ?"); params.push(scope.lessonFileId); }
    else if (scope.notebookId) { where.push("notebook_id = ?"); params.push(scope.notebookId); }
    const result = await this.database.query<D1SourceRow>({
      sql: `${selectSource} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`, params,
    });
    return result.rows.map(fromRow);
  }

  async get(ownerId: string, sourceId: string) {
    const result = await this.database.query<D1SourceRow>({
      sql: `${selectSource} WHERE owner_id = ? AND id = ?`, params: [ownerId, sourceId],
    });
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async retry(ownerId: string, sourceId: string, now: string) {
    const updated = await this.database.query({
      sql: `UPDATE knowledge_sources
            SET status = 'queued', attempt_count = 0, available_at = ?, worker_id = NULL,
                lease_expires_at = NULL, last_error = NULL, updated_at = ?
            WHERE owner_id = ? AND id = ? AND status = 'failed'`,
      params: [now, now, ownerId, sourceId],
    });
    return updated.rowsAffected ? this.get(ownerId, sourceId) : null;
  }

  async delete(ownerId: string, sourceId: string) {
    const source = await this.get(ownerId, sourceId);
    if (!source) return null;
    await this.database.query({ sql: "DELETE FROM knowledge_sources WHERE owner_id = ? AND id = ?", params: [ownerId, sourceId] });
    return source;
  }

  async listIds(ownerId: string, scope: "notebook" | "lessonFile", resourceId: string) {
    const column = scope === "notebook" ? "notebook_id" : "lesson_file_id";
    const result = await this.database.query<{ id: string }>({
      sql: `SELECT id FROM knowledge_sources WHERE owner_id = ? AND ${column} = ?`, params: [ownerId, resourceId],
    });
    return result.rows.map((row) => row.id);
  }

  async audit(ownerId: string, sourceId: string, action: string, details: unknown, createdAt: string) {
    await this.database.query({
      sql: "INSERT INTO knowledge_audit_events (id, owner_id, source_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      params: [crypto.randomUUID(), ownerId, sourceId, action, JSON.stringify(details ?? {}), createdAt],
    });
  }

  async listExpiredDraftIds(ownerId: string, cutoff: string, limit: number) {
    const result = await this.database.query<{ id: string }>({
      sql: `SELECT id FROM knowledge_sources
            WHERE owner_id = ? AND attached_message_id IS NULL AND status <> 'deleted' AND updated_at < ?
            ORDER BY updated_at ASC LIMIT ?`, params: [ownerId, cutoff, limit],
    });
    return result.rows.map((row) => row.id);
  }

  async claim(workerId: string, now: string, leaseExpiresAt: string) {
    await this.database.query({
      sql: `UPDATE knowledge_sources SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
            available_at = ?, worker_id = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'worker_lease_expired'), updated_at = ?
            WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      params: [now, now, now],
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidates = await this.database.query<D1SourceRow>({
        sql: `${selectSource} WHERE status = 'queued' AND storage_key IS NOT NULL AND available_at <= ?
              AND attempt_count < max_attempts ORDER BY available_at, created_at LIMIT 1`, params: [now],
      });
      const candidate = candidates.rows[0];
      if (!candidate) return null;
      const claimed = await this.database.query({
        sql: `UPDATE knowledge_sources SET status = 'processing', attempt_count = attempt_count + 1,
              worker_id = ?, lease_expires_at = ?, last_error = NULL, updated_at = ?
              WHERE id = ? AND status = 'queued' AND attempt_count < max_attempts`,
        params: [workerId, leaseExpiresAt, now, candidate.id],
      });
      if (claimed.rowsAffected) return fromRow({ ...candidate, status: "processing", attempt_count: candidate.attempt_count + 1, worker_id: workerId, lease_expires_at: leaseExpiresAt, last_error: null, updated_at: now });
    }
    return null;
  }

  async heartbeat(sourceId: string, workerId: string, now: string, leaseExpiresAt: string) {
    const result = await this.database.query({
      sql: `UPDATE knowledge_sources SET lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'processing' AND worker_id = ? AND lease_expires_at > ?`,
      params: [leaseExpiresAt, now, sourceId, workerId, now],
    });
    if (!result.rowsAffected) throw new Error("knowledge_worker_lease_lost");
  }

  async stage(sourceId: string, workerId: string, indexVersion: string, chunks: IndexedKnowledgeChunk[], now: string) {
    await this.assertLease(sourceId, workerId, now);
    if (!chunks.length) return;
    const source = await this.getSourceById(sourceId);
    if (!source) throw new Error("knowledge_worker_lease_lost");
    await this.database.batch(chunks.map((chunk) => ({
      sql: `INSERT INTO knowledge_chunk_staging (
        id, source_id, worker_id, owner_id, notebook_id, lesson_file_id, scope,
        stable_chunk_id, section, page, passage, adjacent_before, adjacent_after,
        embedding_json, index_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [crypto.randomUUID(), sourceId, workerId, source.owner_id, source.notebook_id,
        source.lesson_file_id, source.scope, chunk.stableChunkId, chunk.section ?? null,
        chunk.page ?? null, chunk.passage, chunk.adjacentBefore ?? null, chunk.adjacentAfter ?? null,
        JSON.stringify(chunk.embedding), indexVersion, now],
    })));
  }

  async publish(sourceId: string, workerId: string, indexVersion: string, expectedCount: number, metadata: Record<string, unknown>, now: string) {
    await this.assertLease(sourceId, workerId, now);
    const source = await this.getSourceById(sourceId);
    if (!source) throw new Error("knowledge_worker_lease_lost");
    const staged = await this.database.query<Record<string, unknown>>({
      sql: `SELECT stable_chunk_id, section, page, passage, adjacent_before, adjacent_after, embedding_json, index_version, created_at
            FROM knowledge_chunk_staging WHERE source_id = ? AND worker_id = ? ORDER BY created_at, id`,
      params: [sourceId, workerId],
    });
    if (!staged.rows.length || staged.rows.length !== expectedCount) throw new Error("knowledge_staging_incomplete");
    const statements = [
      { sql: "DELETE FROM knowledge_chunks WHERE source_id = ?", params: [sourceId] },
      ...staged.rows.map((row) => ({
        sql: `INSERT INTO knowledge_chunks (id, source_id, owner_id, notebook_id, lesson_file_id, scope, stable_chunk_id, section, page, passage, adjacent_before, adjacent_after, embedding_json, index_version, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [crypto.randomUUID(), sourceId, source.owner_id, source.notebook_id, source.lesson_file_id, source.scope,
          String(row.stable_chunk_id), asStringOrNull(row.section), asNumberOrNull(row.page), String(row.passage),
          asStringOrNull(row.adjacent_before), asStringOrNull(row.adjacent_after), asStringOrNull(row.embedding_json), String(row.index_version), String(row.created_at)],
      })),
      { sql: `UPDATE knowledge_sources SET status = 'ready', index_version = ?, metadata_json = ?, worker_id = NULL,
              lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'processing'`,
        params: [indexVersion, JSON.stringify(metadata), now, sourceId, workerId] },
      { sql: "DELETE FROM knowledge_chunk_staging WHERE source_id = ?", params: [sourceId] },
      { sql: "INSERT INTO knowledge_audit_events (id, owner_id, source_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [crypto.randomUUID(), source.owner_id, sourceId, "index.ready", JSON.stringify({ chunkCount: expectedCount, indexVersion }), now] },
    ];
    await this.database.batch(statements);
  }

  async fail(sourceId: string, workerId: string, error: string, now: string) {
    const source = await this.getSourceById(sourceId);
    if (!source || source.status !== "processing" || source.worker_id !== workerId) throw new Error("knowledge_worker_lease_lost");
    const retry = source.attempt_count < source.max_attempts;
    const delaySeconds = Math.min(300, 10 * 2 ** Math.max(0, source.attempt_count - 1));
    const availableAt = new Date(Date.parse(now) + delaySeconds * 1_000).toISOString();
    const message = error.slice(0, 500);
    await this.database.batch([
      { sql: `UPDATE knowledge_sources SET status = ?, available_at = ?, worker_id = NULL, lease_expires_at = NULL,
              last_error = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'processing'`,
        params: [retry ? "queued" : "failed", availableAt, message, JSON.stringify({ ...source.metadata, error: message, failedAt: now }), now, sourceId, workerId] },
      { sql: "DELETE FROM knowledge_chunk_staging WHERE source_id = ?", params: [sourceId] },
      { sql: "INSERT INTO knowledge_audit_events (id, owner_id, source_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [crypto.randomUUID(), source.owner_id, sourceId, retry ? "index.retry_scheduled" : "index.failed", JSON.stringify({ error: message, attempt: source.attempt_count }), now] },
    ]);
  }

  private async assertLease(sourceId: string, workerId: string, now: string) {
    const source = await this.getSourceById(sourceId);
    if (!source || source.status !== "processing" || source.worker_id !== workerId || !source.lease_expires_at || source.lease_expires_at <= now) {
      throw new Error("knowledge_worker_lease_lost");
    }
  }

  private async getSourceById(sourceId: string) {
    const result = await this.database.query<D1SourceRow>({ sql: `${selectSource} WHERE id = ?`, params: [sourceId] });
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
}

const selectSource = `SELECT id, owner_id, notebook_id, lesson_file_id, scope, title, media_type,
  storage_key, source_version, status, index_version, metadata_json, upload_idempotency_key,
  attached_message_id, attempt_count, max_attempts, available_at, lease_expires_at, worker_id,
  last_error, created_at, updated_at FROM knowledge_sources`;

function sourceParams(source: KnowledgeSourceRecord) {
  return [source.id, source.owner_id, source.notebook_id, source.lesson_file_id, source.scope,
    source.title, source.media_type, source.storage_key, source.source_version, source.status,
    source.index_version, JSON.stringify(source.metadata), source.upload_idempotency_key,
    source.attached_message_id, source.attempt_count, source.max_attempts, source.available_at,
    source.lease_expires_at, source.worker_id, source.last_error, source.created_at, source.updated_at];
}

function fromRow(row: D1SourceRow): KnowledgeSourceRecord {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { /* invalid metadata is treated as opaque empty data */ }
  const { metadata_json: _metadata, ...source } = row;
  return { ...source, metadata };
}

function asStringOrNull(value: unknown) { return typeof value === "string" ? value : null; }
function asNumberOrNull(value: unknown) { return typeof value === "number" ? value : null; }
