import type { CurriculumKnowledgeContinuityRecord, CurriculumKnowledgeSearchResult, CurriculumNodeKnowledgeRecord, CurriculumNodeKnowledgePoint, CurriculumPeriodRecommendation, CurriculumSemanticEntityRecord, CurriculumSemanticReleaseRecord, CurriculumSemanticSource } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { lexicalScore } from "./lexical-score.js";

type ReleaseRow = { id: string; scope_key: string; catalog_generation_id: string; subject: string; stage: string; edition: string; grade: string; volume: string; schema_version: number; published_at: string };
type PointRow = { id: string; semantic_entity_id: string; sequence_no: number | null; printed_pages: string | null; recommended_period: number | null; payload_json: string; priority: number; external_id: string | null; canonical_name: string; definition: string; entity_payload_json: string; confidence: number; kind: CurriculumSemanticEntityRecord["kind"]; embedding_json: string | null; search_text: string };
type EntityRow = { semantic_entity_id: string; external_id: string | null; canonical_name: string; definition: string; payload_json: string; confidence: number; kind: CurriculumSemanticEntityRecord["kind"] };
type OccurrenceRow = { id: string; semantic_entity_id: string; node_id: string; node_title: string; page_number: number | null; sequence_no: number | null; printed_pages: string | null; recommended_period: number | null; payload_json: string };

export type D1CurriculumKnowledgeRepository = Pick<LessonRepository,
  "readCurriculumNodeKnowledgePoints" | "readCurriculumNodesKnowledgePoints" |
  "searchCurriculumKnowledgePoints" | "readCurriculumKnowledgeContinuity">;

export class D1CurriculumKnowledgeReadRepository implements D1CurriculumKnowledgeRepository {
  constructor(private readonly database: SqlDatabase) {}

  async readCurriculumNodeKnowledgePoints(args: { textbookId: string; nodeId: string }): Promise<CurriculumNodeKnowledgeRecord> {
    const release = await this.releaseForNode(args.textbookId, args.nodeId, true);
    return release ? this.nodeKnowledge(release, args.textbookId, args.nodeId) : emptyNodeKnowledge();
  }

  async readCurriculumNodesKnowledgePoints(args: { textbookId: string; nodeIds: string[] }) {
    const nodeIds = [...new Set(args.nodeIds)].slice(0, 100);
    const results = await Promise.all(nodeIds.map(async (nodeId) => [nodeId, await this.readCurriculumNodeKnowledgePoints({ textbookId: args.textbookId, nodeId })] as const));
    return Object.fromEntries(results);
  }

  async searchCurriculumKnowledgePoints(args: { textbookId: string; query: string; embedding?: number[]; limit?: number }): Promise<CurriculumKnowledgeSearchResult[]> {
    if (!args.query.trim()) return [];
    const release = await this.releaseForTextbook(args.textbookId); if (!release) return [];
    const rows = firstByEntity(await this.points(release.id, args.textbookId));
    const limit = Math.min(Math.max(args.limit ?? 12, 1), 30);
    const entities = await this.entities(release.id, rows.map((row) => row.semantic_entity_id));
    const occurrences = await this.occurrences(release.id, args.textbookId, rows.map((row) => row.semantic_entity_id));
    return rows.flatMap((row) => {
      const point = entities.get(row.semantic_entity_id); if (!point) return [];
      const lexical = lexicalScore(args.query, `${row.search_text}\n${row.canonical_name}\n${row.definition}`);
      const vector = args.embedding ? cosine(args.embedding, numbers(row.embedding_json)) : 0;
      const score = args.embedding && numbers(row.embedding_json).length ? Math.max(0, vector) : lexical;
      return [{ point, score, retrievalMethod: args.embedding && numbers(row.embedding_json).length ? "embedding" as const : "lexical" as const, occurrences: occurrences.get(row.semantic_entity_id) ?? [] }];
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.point.id.localeCompare(b.point.id)).slice(0, limit);
  }

  async readCurriculumKnowledgeContinuity(args: { textbookId: string; currentNodeId: string; entityId: string; limit?: number }): Promise<CurriculumKnowledgeContinuityRecord> {
    const release = await this.releaseForNode(args.textbookId, args.currentNodeId, false); if (!release) return unavailable();
    const current = await this.database.query<{ sequence_no: number | null }>({ sql: `SELECT sequence_no FROM curriculum_node_semantics
      WHERE release_id = ? AND textbook_id = ? AND node_id = ? AND review_state = 'approved' ORDER BY sequence_no LIMIT 1`, params: [release.id, args.textbookId, args.currentNodeId] });
    const targetRows = await this.pointById(release.id, args.entityId); const target = targetRows[0]; if (!target) return unavailable();
    const targetEntity = (await this.entities(release.id, [args.entityId])).get(args.entityId); if (!targetEntity) return unavailable();
    const candidates = firstByEntity(await this.points(release.id, args.textbookId));
    const candidateIds = candidates.map((row) => row.semantic_entity_id).filter((id) => id !== args.entityId);
    const occurrences = await this.occurrences(release.id, args.textbookId, [args.entityId, ...candidateIds]);
    const same = occurrences.get(args.entityId)?.filter((item) => item.nodeId !== args.currentNodeId) ?? [];
    const hasEmbedding = numbers(target.embedding_json).length > 0;
    const entities = await this.entities(release.id, candidateIds);
    const ranked = candidates.flatMap((row) => {
      const occurrence = occurrences.get(row.semantic_entity_id)?.filter((item) => item.nodeId !== args.currentNodeId) ?? []; if (!occurrence.length) return [];
      const point = entities.get(row.semantic_entity_id); if (!point) return [];
      const embedding = numbers(row.embedding_json); if (!hasEmbedding || !embedding.length) return [];
      return [{ point, score: Math.max(0, cosine(numbers(target.embedding_json), embedding)), retrievalMethod: "embedding" as const, occurrences: occurrence.map((item) => ({ ...item, position: position(item.sequenceNo, current.rows[0]?.sequence_no ?? null) })) }];
    });
    if (!hasEmbedding && !same.length) return { status: "semantic_search_unavailable", currentSequenceNo: current.rows[0]?.sequence_no ?? null, target: targetEntity, candidates: [] };
    const exact: CurriculumKnowledgeSearchResult[] = same.length ? [{ point: targetEntity, score: 1, retrievalMethod: "exact", occurrences: same.map((item) => ({ ...item, position: position(item.sequenceNo, current.rows[0]?.sequence_no ?? null) })) }] : [];
    return { status: "available", currentSequenceNo: current.rows[0]?.sequence_no ?? null, target: targetEntity, candidates: [...exact, ...ranked].sort((a, b) => b.score - a.score || a.point.id.localeCompare(b.point.id)).slice(0, Math.min(Math.max(args.limit ?? 12, 1), 30)) };
  }

  private async nodeKnowledge(release: ReleaseRow, textbookId: string, nodeId: string): Promise<CurriculumNodeKnowledgeRecord> {
    const rows = await this.database.query<PointRow>({ sql: `${pointSelect} WHERE m.release_id = ? AND m.textbook_id = ? AND m.node_id = ? AND m.instructional_role = 'occurs_in' AND m.review_state = 'approved' AND v.review_state = 'approved' ORDER BY m.priority, v.external_id, m.id`, params: [release.id, textbookId, nodeId] });
    const entities = await this.entities(release.id, rows.rows.map((row) => row.semantic_entity_id));
    const periods = await this.periods(release.id, textbookId, nodeId);
    const points: CurriculumNodeKnowledgePoint[] = rows.rows.flatMap((row) => { const point = entities.get(row.semantic_entity_id); return point ? [{ mappingId: row.id, sequenceNo: row.sequence_no ?? 0, printedPages: row.printed_pages ?? undefined, recommendedPeriod: row.recommended_period ?? undefined, mappingPayload: object(row.payload_json), point }] : []; });
    return { release: releaseRecord(release), points, periodRecommendations: periods };
  }

  private async releaseForTextbook(textbookId: string) { const result = await this.database.query<ReleaseRow>({ sql: `${releaseSelect} JOIN curriculum_node_semantics m ON m.release_id = r.id WHERE r.status = 'published' AND m.review_state = 'approved' AND m.textbook_id = ? AND m.instructional_role = 'occurs_in' ORDER BY r.published_at DESC LIMIT 1`, params: [textbookId] }); return result.rows[0] ?? null; }
  private async releaseForNode(textbookId: string, nodeId: string, occursOnly: boolean) { const role = occursOnly ? " AND m.instructional_role = 'occurs_in'" : ""; const result = await this.database.query<ReleaseRow>({ sql: `${releaseSelect} JOIN curriculum_node_semantics m ON m.release_id = r.id WHERE r.status = 'published' AND m.review_state = 'approved' AND m.textbook_id = ? AND m.node_id = ?${role} ORDER BY r.published_at DESC LIMIT 1`, params: [textbookId, nodeId] }); return result.rows[0] ?? null; }
  private async points(releaseId: string, textbookId: string) { const result = await this.database.query<PointRow>({ sql: `${pointSelect} WHERE m.release_id = ? AND m.textbook_id = ? AND m.review_state = 'approved' AND v.review_state = 'approved' AND e.kind = 'knowledge_point' ORDER BY m.semantic_entity_id, m.priority, m.id`, params: [releaseId, textbookId] }); return result.rows; }
  private async pointById(releaseId: string, entityId: string) { const result = await this.database.query<PointRow>({ sql: `${pointSelect} WHERE m.release_id = ? AND m.semantic_entity_id = ? AND m.review_state = 'approved' AND v.review_state = 'approved' AND e.kind = 'knowledge_point' LIMIT 1`, params: [releaseId, entityId] }); return result.rows; }
  private async entities(releaseId: string, ids: string[]) { const unique = [...new Set(ids)]; if (!unique.length) return new Map<string, CurriculumSemanticEntityRecord>(); const marks = unique.map(() => "?").join(","); const rows = await this.database.query<EntityRow>({ sql: `SELECT v.semantic_entity_id, v.external_id, v.canonical_name, v.definition, v.payload_json, v.confidence, e.kind FROM curriculum_semantic_entity_revisions v JOIN curriculum_semantic_entities e ON e.id = v.semantic_entity_id WHERE v.release_id = ? AND v.review_state = 'approved' AND v.semantic_entity_id IN (${marks})`, params: [releaseId, ...unique] }); const sources = await this.entitySources(releaseId, unique); return new Map(rows.rows.map((row) => [row.semantic_entity_id, { id: row.semantic_entity_id, externalId: row.external_id ?? undefined, kind: row.kind, canonicalName: row.canonical_name, definition: row.definition, payload: object(row.payload_json), confidence: row.confidence, sources: sources.get(row.semantic_entity_id) ?? [] }])); }
  private async entitySources(releaseId: string, ids: string[]) { const marks = ids.map(() => "?").join(","); const result = await this.database.query<{ semantic_entity_id: string; source_ref_id: string; title: string; url: string | null; authority: string; locator: string | null }>({ sql: `SELECT link.semantic_entity_id, s.source_ref_id, s.title, s.url, s.authority, s.locator FROM curriculum_semantic_entity_sources link JOIN curriculum_semantic_sources s ON s.release_id = link.release_id AND s.id = link.source_id WHERE link.release_id = ? AND link.semantic_entity_id IN (${marks}) ORDER BY s.title`, params: [releaseId, ...ids] }); const grouped = new Map<string, CurriculumSemanticSource[]>(); for (const row of result.rows) { const list = grouped.get(row.semantic_entity_id) ?? []; list.push({ id: row.source_ref_id, title: row.title, url: row.url ?? undefined, kind: "public", authority: row.authority, locator: row.locator ?? undefined }); grouped.set(row.semantic_entity_id, list); } return grouped; }
  private async occurrences(releaseId: string, textbookId: string, entityIds: string[]) { const unique = [...new Set(entityIds)]; if (!unique.length) return new Map<string, CurriculumKnowledgeSearchResult["occurrences"]>(); const marks = unique.map(() => "?").join(","); const result = await this.database.query<OccurrenceRow>({ sql: `SELECT m.id, m.semantic_entity_id, m.node_id, n.title AS node_title, n.page_number, m.sequence_no, m.printed_pages, m.recommended_period, m.payload_json FROM curriculum_node_semantics m JOIN curriculum_semantic_releases r ON r.id = m.release_id JOIN curriculum_catalog_releases cr ON cr.generation_id = r.catalog_generation_id AND cr.status = 'published' JOIN curriculum_nodes n ON n.catalog_release_id = cr.id AND n.textbook_id = m.textbook_id AND n.node_id = m.node_id WHERE m.release_id = ? AND m.textbook_id = ? AND m.review_state = 'approved' AND m.semantic_entity_id IN (${marks}) ORDER BY m.sequence_no, n.level, n.sort_no`, params: [releaseId, textbookId, ...unique] }); const grouped = new Map<string, CurriculumKnowledgeSearchResult["occurrences"]>(); for (const row of result.rows) { const list = grouped.get(row.semantic_entity_id) ?? []; list.push({ mappingId: row.id, nodeId: row.node_id, nodeTitle: row.node_title, pageNumber: row.page_number, sequenceNo: row.sequence_no ?? 0, printedPages: row.printed_pages ?? undefined, recommendedPeriod: row.recommended_period ?? undefined, payload: object(row.payload_json) }); grouped.set(row.semantic_entity_id, list); } return grouped; }
  private async periods(releaseId: string, textbookId: string, nodeId: string): Promise<CurriculumPeriodRecommendation[]> { const rows = await this.database.query<{ id: string; period_no: number; title: string; mapping_type: string; is_official: number; note: string }>({ sql: "SELECT id, period_no, title, mapping_type, is_official, note FROM curriculum_period_recommendations WHERE release_id = ? AND textbook_id = ? AND node_id = ? AND review_state = 'approved' ORDER BY period_no", params: [releaseId, textbookId, nodeId] }); if (!rows.rows.length) return []; const ids = rows.rows.map((row) => row.id); const marks = ids.map(() => "?").join(","); const links = await this.database.query<{ period_recommendation_id: string; semantic_entity_id: string }>({ sql: `SELECT period_recommendation_id, semantic_entity_id FROM curriculum_period_recommendation_points WHERE release_id = ? AND period_recommendation_id IN (${marks}) ORDER BY sort_no`, params: [releaseId, ...ids] }); return rows.rows.map((row) => ({ id: row.id, periodNo: row.period_no, title: row.title, mappingType: row.mapping_type, isOfficial: Boolean(row.is_official), note: row.note, pointIds: links.rows.filter((link) => link.period_recommendation_id === row.id).map((link) => link.semantic_entity_id) })); }
}

const releaseSelect = "SELECT r.id, r.scope_key, r.catalog_generation_id, r.subject, r.stage, r.edition, r.grade, r.volume, r.schema_version, r.published_at FROM curriculum_semantic_releases r";
const pointSelect = "SELECT m.id, m.semantic_entity_id, m.sequence_no, m.printed_pages, m.recommended_period, m.payload_json, m.priority, v.external_id, v.canonical_name, v.definition, v.payload_json AS entity_payload_json, v.confidence, e.kind, v.embedding_json, v.search_text FROM curriculum_node_semantics m JOIN curriculum_semantic_entity_revisions v ON v.release_id = m.release_id AND v.semantic_entity_id = m.semantic_entity_id JOIN curriculum_semantic_entities e ON e.id = m.semantic_entity_id";
const releaseRecord = (row: ReleaseRow): CurriculumSemanticReleaseRecord => ({ id: row.id, scopeKey: row.scope_key, catalogGenerationId: row.catalog_generation_id, subject: row.subject, stage: row.stage, edition: row.edition, grade: row.grade, volume: row.volume, schemaVersion: row.schema_version, publishedAt: row.published_at });
const emptyNodeKnowledge = (): CurriculumNodeKnowledgeRecord => ({ release: null, points: [], periodRecommendations: [] });
const unavailable = (): CurriculumKnowledgeContinuityRecord => ({ status: "unavailable", currentSequenceNo: null, candidates: [] });
function object(value: string) { try { const result = JSON.parse(value); return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {}; } catch { return {}; } }
function numbers(value: string | null) { try { const result = JSON.parse(value ?? "[]"); return Array.isArray(result) && result.every((item) => typeof item === "number") ? result : []; } catch { return []; } }
function cosine(left: number[], right: number[]) { if (!left.length || left.length !== right.length) return 0; let dot = 0; let a = 0; let b = 0; for (let i = 0; i < left.length; i += 1) { dot += left[i]! * right[i]!; a += left[i]! ** 2; b += right[i]! ** 2; } return a && b ? dot / Math.sqrt(a * b) : 0; }
function position(sequence: number, current: number | null) { return !current || sequence === current ? "current" as const : sequence < current ? "before" as const : "after" as const; }
function firstByEntity(rows: PointRow[]) { const unique = new Map<string, PointRow>(); for (const row of rows) unique.set(row.semantic_entity_id, unique.get(row.semantic_entity_id) ?? row); return [...unique.values()]; }
