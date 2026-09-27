import type { KnowledgeResult, SourceRef } from "../domain.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import type { LessonRepository } from "../repository.js";

type StandardChunkRow = {
  document_id: string; title: string; source_url: string | null; document_kind: string;
  stage_scope_json: string; grade_scope_json: string; page: number | null; stable_chunk_id: string;
  passage: string; section: string | null; curriculum_stage: string | null; grade_start: number | null;
  grade_end: number | null; curriculum_domain: string | null; embedding_json: string | null;
};

/**
 * Public standards read model. D1 holds ordinary rows and JSON text while the
 * portable ranking policy stays here; a Postgres adapter can later use the
 * same contract with JSONB/pgvector without altering callers.
 */
export type D1CurriculumStandardRepository = Pick<LessonRepository,
  "searchCurriculumStandards" | "getPublishedCurriculumStandardFingerprint" |
  "filterCurrentCurriculumStandardSources">;

export class D1CurriculumStandardReadRepository implements D1CurriculumStandardRepository {
  constructor(private readonly database: SqlDatabase) {}

  async searchCurriculumStandards(input: { query: string; subject: string; stage?: string; grade?: string; limit: number; embedding?: number[] }): Promise<KnowledgeResult[]> {
    const rows = await this.database.query<StandardChunkRow>({ sql: `SELECT d.id AS document_id, d.title, d.source_url, d.document_kind, d.stage_scope_json, d.grade_scope_json,
      c.page, c.stable_chunk_id, c.passage, c.section, c.curriculum_stage, c.grade_start, c.grade_end, c.curriculum_domain, c.embedding_json
      FROM curriculum_standard_chunks c
      JOIN curriculum_standard_documents d ON d.id = c.document_id
      JOIN curriculum_standard_releases r ON r.id = d.release_id
      WHERE r.status = 'published' AND (d.subject = ? OR d.document_kind = 'curriculum_plan')
      ORDER BY c.created_at DESC, c.stable_chunk_id LIMIT 300`, params: [input.subject] });
    const gradeNumber = parseGrade(input.grade);
    return rows.rows
      .filter((row) => documentMatches(row, input.stage, input.grade) && chunkMatches(row, input.stage, gradeNumber))
      .map((row) => standardResult(row, input.query, input.embedding, gradeNumber))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || (left.chunkId ?? "").localeCompare(right.chunkId ?? ""))
      .slice(0, Math.max(1, Math.min(input.limit, 8)));
  }

  async getPublishedCurriculumStandardFingerprint(): Promise<string | null> {
    const result = await this.database.query<{ id: string; release_key: string; updated_at: string }>({ sql: "SELECT id, release_key, updated_at FROM curriculum_standard_releases WHERE status = 'published' ORDER BY series_key, release_key" });
    return result.rows.length ? result.rows.map((row) => `${row.id}:${row.release_key}:${row.updated_at}`).join("|") : null;
  }

  async filterCurrentCurriculumStandardSources(sources: SourceRef[]): Promise<SourceRef[]> {
    const ids = [...new Set(sources.filter((source) => source.kind === "public").map((source) => source.id))];
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    const result = await this.database.query<{ document_id: string }>({ sql: `SELECT d.id AS document_id FROM curriculum_standard_documents d
      JOIN curriculum_standard_releases r ON r.id = d.release_id
      WHERE r.status = 'published' AND d.id IN (${marks})`, params: ids });
    const current = new Set(result.rows.map((row) => row.document_id));
    return sources.filter((source) => source.kind !== "public" || current.has(source.id));
  }
}

function documentMatches(row: StandardChunkRow, stage?: string, grade?: string) {
  const stages = parseStrings(row.stage_scope_json); const grades = parseStrings(row.grade_scope_json);
  return (!stage || stages.includes(stage)) && (!grade || !grades.length || grades.includes(grade));
}
function chunkMatches(row: StandardChunkRow, stage: string | undefined, grade: number | null) {
  return (!stage || !row.curriculum_stage || row.curriculum_stage === stage)
    && (grade === null || row.grade_start === null || row.grade_end === null || (grade >= row.grade_start && grade <= row.grade_end));
}
function standardResult(row: StandardChunkRow, query: string, embedding: number[] | undefined, grade: number | null): KnowledgeResult {
  const searchable = `${row.title}\n${row.section ?? ""}\n${row.passage}`.toLocaleLowerCase();
  const terms = query.toLocaleLowerCase().split(/[\s,，。；;、]+/).filter(Boolean);
  const lexical = terms.length ? terms.reduce((score, term) => score + (searchable.includes(term) ? 1 : 0), 0) / terms.length : 0.01;
  const vector = embedding ? cosine(embedding, parseNumbers(row.embedding_json)) : 0;
  const section = sectionBoost(row.section, query);
  const scope = grade !== null && row.grade_start !== null && row.grade_end !== null ? 0.02 : 0;
  return { id: row.document_id, title: row.title, url: row.source_url ?? undefined, kind: "public", page: row.page ?? undefined,
    chunkId: row.stable_chunk_id, passage: row.passage, section: row.section ?? undefined,
    score: lexical * 0.35 + Math.max(0, vector) * 0.65 + section + scope };
}
function sectionBoost(section: string | null, query: string) {
  const value = section ?? "";
  if (/(案例|示例|例子|怎么教|教学活动|活动设计)/.test(query) && value.includes("附录")) return 0.12;
  if (value.includes("课程内容") && value.includes("内容要求")) return 0.09;
  if (value.includes("课程内容") && value.includes("学业要求")) return 0.08;
  if (value.includes("教学提示")) return 0.055;
  if (value.includes("课程目标") || value.includes("学业质量")) return 0.04;
  return value.includes("附录") ? -0.01 : 0;
}
function parseStrings(value: string) { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function parseNumbers(value: string | null) { try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : []; } catch { return []; } }
function parseGrade(value: string | undefined) { if (!value) return null; const named = ["一", "二", "三", "四", "五", "六", "七", "八", "九"].indexOf(value[0] ?? ""); if (named >= 0) return named + 1; const numeric = Number.parseInt(value, 10); return Number.isInteger(numeric) && numeric >= 1 && numeric <= 12 ? numeric : null; }
function cosine(left: number[], right: number[]) { if (!left.length || left.length !== right.length) return 0; let dot = 0; let a = 0; let b = 0; for (let index = 0; index < left.length; index += 1) { dot += left[index]! * right[index]!; a += left[index]! ** 2; b += right[index]! ** 2; } return a && b ? dot / Math.sqrt(a * b) : 0; }
