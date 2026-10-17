import type { AgentRunEvidenceKind, AgentRunEvidenceRecord, KnowledgeResult, SourceRef } from "../domain.js";
import { runEvidenceIdentity, uniqueRunEvidenceSources } from "../run-evidence.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlValue } from "../platform/sql-database.js";
import { lexicalScore } from "./lexical-score.js";

/**
 * Chunks ranked per search. Only text is read for these; vectors (about 10 KB
 * each) are fetched afterwards for the best candidates alone, so a large
 * library costs one text scan instead of a full vector transfer. Retain the
 * former recent-vector window as well, so semantic-only matches are not lost.
 */
const KNOWLEDGE_SCAN_LIMIT = 1_500;
const KNOWLEDGE_VECTOR_CANDIDATES = 120;
const KNOWLEDGE_RECENT_VECTOR_CANDIDATES = 300;
/** Leaves room for the scope predicates under D1's 100 bound-parameter limit. */
const VECTOR_FETCH_BATCH = 80;

type ChunkRow = { source_id: string; title: string; scope: string; page: number | null; stable_chunk_id: string; passage: string; section: string | null; embedding_json: string | null };

/**
 * Portable knowledge read model. D1 stores vectors as JSON; ranking happens in
 * application code so neither services nor data schema depend on FTS/SQLite
 * functions. A future Postgres implementation can push the same contract down
 * to pgvector without changing callers.
 */
export type D1KnowledgeRepository = Pick<LessonRepository,
  "searchKnowledge" | "getKnowledgePassage" | "getKnowledgeSourcePassages" |
  "listProjectSources" | "attachKnowledgeSources" | "recordRunEvidence" |
  "listRunEvidence">;

export class D1KnowledgeReadRepository implements D1KnowledgeRepository {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}

  async searchKnowledge(ownerId: string, scopes: string[], query: string, limit: number, embedding?: number[]) {
    const { clause, params } = scopeClause(ownerId, scopes, "k");
    if (!clause) return [];
    const scanned = await this.database.query<ChunkRow & { id: string }>({ sql: `SELECT k.id, k.source_id, s.title, k.scope, k.page, k.stable_chunk_id, k.passage, k.section, NULL AS embedding_json
      FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.source_id
      WHERE s.status = 'ready' AND (s.scope = 'public' OR s.attached_message_id IS NOT NULL)
        AND ${clause} ORDER BY k.created_at DESC, k.id LIMIT ${KNOWLEDGE_SCAN_LIMIT}`, params });
    const size = Math.max(1, Math.min(limit, 32));
    // Sorting is stable, so equal scores keep the newest-first order of the scan.
    const ranked = scanned.rows
      .map((row) => ({ row, lexical: lexicalScore(query, `${row.title}\n${row.section ?? ""}\n${row.passage}`) }))
      .sort((left, right) => right.lexical - left.lexical);
    if (!embedding) {
      return ranked.map(({ row, lexical }) => knowledgeResult(row, lexical, 0))
        .filter((result) => result.score > 0)
        .sort(byScore)
        .slice(0, size);
    }
    const candidateIds = new Set([
      ...ranked.slice(0, KNOWLEDGE_VECTOR_CANDIDATES).map(({ row }) => row.id),
      ...scanned.rows.slice(0, KNOWLEDGE_RECENT_VECTOR_CANDIDATES).map((row) => row.id),
    ]);
    const candidates = ranked.filter(({ row }) => candidateIds.has(row.id));
    const vectors = await this.vectors(ownerId, scopes, candidates.map(({ row }) => row.id));
    return candidates.map(({ row, lexical }) => knowledgeResult(row, lexical, cosine(embedding, vectors.get(row.id) ?? [])))
      .filter((result) => result.score > 0)
      .sort(byScore)
      .slice(0, size);
  }

  /** Vectors for already-selected chunk ids, re-checked against the caller's scope. */
  private async vectors(ownerId: string, scopes: string[], ids: string[]) {
    const { clause, params } = scopeClause(ownerId, scopes, "k");
    const vectors = new Map<string, number[]>();
    if (!clause) return vectors;
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += VECTOR_FETCH_BATCH) batches.push(ids.slice(start, start + VECTOR_FETCH_BATCH));
    const results = await Promise.all(batches.map((batch) => this.database.query<{ id: string; embedding_json: string | null }>({
      sql: `SELECT k.id, k.embedding_json FROM knowledge_chunks k WHERE k.id IN (${batch.map(() => "?").join(",")}) AND ${clause}`,
      params: [...batch, ...params],
    })));
    for (const result of results) for (const row of result.rows) vectors.set(row.id, parseEmbedding(row.embedding_json));
    return vectors;
  }

  async getKnowledgePassage(ownerId: string, scopes: string[], chunkId: string) {
    const { clause, params } = scopeClause(ownerId, scopes, "k"); if (!clause) return null;
    const result = await this.database.query<ChunkRow>({ sql: `SELECT k.source_id, s.title, k.scope, k.page, k.stable_chunk_id, k.passage, k.section, NULL AS embedding_json
      FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.source_id
      WHERE s.status = 'ready' AND (s.scope = 'public' OR s.attached_message_id IS NOT NULL)
        AND k.stable_chunk_id = ? AND ${clause} LIMIT 1`, params: [chunkId, ...params] });
    return result.rows[0] ? knowledgeResult(result.rows[0], 0.01, 0) : null;
  }

  async getKnowledgeSourcePassages(ownerId: string, scopes: string[], sourceId: string, limit: number) {
    const { clause, params } = scopeClause(ownerId, scopes, "k"); if (!clause) return [];
    const result = await this.database.query<ChunkRow>({ sql: `SELECT k.source_id, s.title, k.scope, k.page, k.stable_chunk_id, k.passage, k.section, NULL AS embedding_json
      FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.source_id
      WHERE s.status = 'ready' AND (s.scope = 'public' OR s.attached_message_id IS NOT NULL)
        AND k.source_id = ? AND ${clause} ORDER BY k.created_at, k.id LIMIT ?`, params: [sourceId, ...params, Math.max(1, Math.min(limit, 32))] });
    return result.rows.map((row) => knowledgeResult(row, 0.01, 0));
  }

  async listProjectSources(ownerId: string, scopes: string[]): Promise<SourceRef[]> {
    const { clause, params } = scopeClause(ownerId, scopes, "s"); if (!clause) return [];
    const result = await this.database.query<{ id: string; title: string; scope: string }>({ sql: `SELECT s.id, s.title, s.scope FROM knowledge_sources s
      WHERE s.status = 'ready' AND (s.scope = 'public' OR s.attached_message_id IS NOT NULL)
        AND ${clause} ORDER BY s.updated_at DESC`, params });
    return result.rows.map((row): SourceRef => ({ id: row.id, title: row.title, kind: row.scope === "public" ? "public" : "private" }));
  }

  async attachKnowledgeSources(ownerId: string, lessonFileId: string, messageId: string, sourceIds: string[]): Promise<SourceRef[]> {
    const ids = [...new Set(sourceIds)]; if (!ids.length) return [];
    const file = await this.database.query<{ notebook_id: string }>({ sql: "SELECT notebook_id FROM lesson_files WHERE owner_id = ? AND id = ?", params: [ownerId, lessonFileId] });
    if (!file.rows[0]) throw new Error("knowledge_attachment_unavailable");
    const markers = ids.map(() => "?").join(",");
    const sources = await this.database.query<{ id: string; title: string; scope: string }>({ sql: `SELECT id, title, scope FROM knowledge_sources
      WHERE owner_id = ? AND id IN (${markers}) AND status = 'ready'
        AND (scope = 'user' OR (scope = 'notebook' AND notebook_id = ?) OR (scope = 'file' AND lesson_file_id = ?))`, params: [ownerId, ...ids, file.rows[0].notebook_id, lessonFileId] });
    if (sources.rows.length !== ids.length) throw new Error("knowledge_attachment_unavailable");
    await this.database.batch(sources.rows.map((source) => ({ sql: "UPDATE knowledge_sources SET attached_message_id = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND attached_message_id IS NULL", params: [messageId, this.clock(), ownerId, source.id] })));
    return sources.rows.map((source): SourceRef => ({ id: source.id, title: source.title, kind: source.scope === "public" ? "public" : "private" }));
  }

  async recordRunEvidence(ownerId: string, runId: string, kind: AgentRunEvidenceKind, sources: SourceRef[]) {
    const now = this.clock(); const unique = uniqueRunEvidenceSources(sources); if (!unique.length) return;
    await this.database.batch(unique.map((source) => ({ sql: `INSERT INTO agent_run_evidence (owner_id, run_id, kind, evidence_key, source_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, run_id, kind, evidence_key) DO NOTHING`, params: [ownerId, runId, kind, runEvidenceIdentity(source), JSON.stringify(source), now] })));
  }

  async listRunEvidence(ownerId: string, runId: string) {
    const result = await this.database.query<{ kind: AgentRunEvidenceKind; source_json: string; created_at: string }>({ sql: "SELECT kind, source_json, created_at FROM agent_run_evidence WHERE owner_id = ? AND run_id = ? ORDER BY created_at", params: [ownerId, runId] });
    return result.rows.map((row): AgentRunEvidenceRecord => ({ ownerId, runId, kind: row.kind, source: JSON.parse(row.source_json) as SourceRef, createdAt: row.created_at }));
  }
}

function scopeClause(ownerId: string, scopes: string[], alias: "k" | "s") {
  const clauses: string[] = []; const params: SqlValue[] = [];
  for (const scope of scopes) {
    if (scope === "public") { clauses.push(`${alias}.scope = 'public'`); continue; }
    const [kind, id] = scope.split(":", 2); if (!id) continue;
    if (kind === "user" && id === ownerId) { clauses.push(`(${alias}.scope = 'user' AND ${alias}.owner_id = ?)`); params.push(ownerId); }
    if (kind === "notebook") { clauses.push(`(${alias}.scope = 'notebook' AND ${alias}.owner_id = ? AND ${alias}.notebook_id = ?)`); params.push(ownerId, id); }
    if (kind === "file") { clauses.push(`(${alias}.scope = 'file' AND ${alias}.owner_id = ? AND ${alias}.lesson_file_id = ?)`); params.push(ownerId, id); }
  }
  return { clause: clauses.length ? `(${clauses.join(" OR ")})` : "", params };
}

function knowledgeResult(row: ChunkRow, lexical: number, vector: number): KnowledgeResult {
  return { id: row.source_id, title: row.title, kind: row.scope === "public" ? "public" : "private", page: row.page ?? undefined, chunkId: row.stable_chunk_id, passage: row.passage, section: row.section ?? undefined, score: lexical * 0.35 + Math.max(0, vector) * 0.65 };
}
const byScore = (left: KnowledgeResult, right: KnowledgeResult) => right.score - left.score || left.id.localeCompare(right.id);
function parseEmbedding(value: string | null) { try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : []; } catch { return []; } }
function cosine(left: number[], right: number[]) { if (!left.length || left.length !== right.length) return 0; let dot = 0; let a = 0; let b = 0; for (let index = 0; index < left.length; index += 1) { dot += left[index]! * right[index]!; a += left[index]! ** 2; b += right[index]! ** 2; } return a && b ? dot / Math.sqrt(a * b) : 0; }
