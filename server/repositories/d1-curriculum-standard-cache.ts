import type { CurriculumStandardSearchCacheRecord, KnowledgeResult } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";

export type D1CurriculumStandardCache = Pick<LessonRepository, "getCurriculumStandardSearchCache" | "saveCurriculumStandardSearchCache">;

export class D1CurriculumStandardCacheRepository implements D1CurriculumStandardCache {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}
  async getCurriculumStandardSearchCache(input: { contextFingerprint: string; querySha256: string; limit: number }) {
    const result = await this.database.query<{ results_json: string; updated_at: string }>({ sql: "SELECT results_json, updated_at FROM curriculum_standard_query_cache WHERE context_fingerprint = ? AND query_sha256 = ? AND result_limit = ?", params: [input.contextFingerprint, input.querySha256, input.limit] });
    const row = result.rows[0]; if (!row) return null;
    return { contextFingerprint: input.contextFingerprint, querySha256: input.querySha256, limit: input.limit, results: JSON.parse(row.results_json) as KnowledgeResult[], updatedAt: row.updated_at } satisfies CurriculumStandardSearchCacheRecord;
  }
  async saveCurriculumStandardSearchCache(input: { contextFingerprint: string; querySha256: string; limit: number; results: KnowledgeResult[] }) {
    const updatedAt = this.clock();
    await this.database.query({ sql: `INSERT INTO curriculum_standard_query_cache (context_fingerprint, query_sha256, result_limit, results_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(context_fingerprint, query_sha256, result_limit) DO UPDATE SET results_json = excluded.results_json, updated_at = excluded.updated_at`, params: [input.contextFingerprint, input.querySha256, input.limit, JSON.stringify(input.results), updatedAt] });
    return { ...input, updatedAt };
  }
}
