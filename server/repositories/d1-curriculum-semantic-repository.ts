import type { CurriculumNodeSemanticMapping, CurriculumNodeSemanticsRecord, CurriculumSemanticEntityRecord, CurriculumSemanticPathStep, CurriculumSemanticRelation, CurriculumSemanticSource } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";

type ReleaseRow = { id: string; scope_key: string; catalog_generation_id: string; subject: string; stage: string; edition: string; grade: string; volume: string; schema_version: number; published_at: string | null };
type EntityRow = { release_id: string; semantic_entity_id: string; kind: CurriculumSemanticEntityRecord["kind"]; canonical_name: string; definition: string; payload_json: string; confidence: number };
type RelationRow = { id: string; release_id: string; from_entity_id: string; to_entity_id: string; relation_type: CurriculumSemanticRelation; strength: number; confidence: number; rationale: string };
type MappingRow = { id: string; release_id: string; semantic_entity_id: string; instructional_role: CurriculumNodeSemanticMapping["instructionalRole"]; expected_depth: number; priority: number; confidence: number; rationale: string };
type SourceRow = { owner_id: string; source_ref_id: string; title: string; url: string | null; authority: string; locator: string | null };

export type D1CurriculumSemanticRepository = Pick<LessonRepository,
  "readCurriculumNodeSemantics" | "getCurriculumSemanticEntity" | "traceCurriculumSemanticPath">;

/** Portable read adapter for the reviewed, published semantic graph. */
export class D1CurriculumSemanticReadRepository implements D1CurriculumSemanticRepository {
  constructor(private readonly database: SqlDatabase) {}

  async readCurriculumNodeSemantics(args: { textbookId: string; nodeId: string }): Promise<CurriculumNodeSemanticsRecord> {
    const releaseRows = await this.database.query<ReleaseRow>({ sql: `SELECT r.id, r.scope_key, r.catalog_generation_id, r.subject, r.stage, r.edition, r.grade, r.volume, r.schema_version, r.published_at
      FROM curriculum_semantic_releases r JOIN curriculum_node_semantics m ON m.release_id = r.id
      WHERE r.status = 'published' AND m.review_state = 'approved' AND m.textbook_id = ? AND m.node_id = ?
      ORDER BY r.published_at DESC LIMIT 1`, params: [args.textbookId, args.nodeId] });
    const release = releaseRows.rows[0]; if (!release) return { release: null, mappings: [] };
    const mappings = await this.database.query<MappingRow>({ sql: `SELECT id, release_id, semantic_entity_id, instructional_role, expected_depth, priority, confidence, rationale
      FROM curriculum_node_semantics WHERE release_id = ? AND textbook_id = ? AND node_id = ? AND review_state = 'approved'
      ORDER BY priority, instructional_role, id`, params: [release.id, args.textbookId, args.nodeId] });
    const entities = await this.entities(release.id, mappings.rows.map((row) => row.semantic_entity_id));
    const sources = await this.sources("curriculum_node_semantic_sources", "node_semantic_id", release.id, mappings.rows.map((row) => row.id));
    return { release: releaseRecord(release), mappings: mappings.rows.flatMap((row) => {
      const entity = entities.get(row.semantic_entity_id); if (!entity) return [];
      return [{ id: row.id, instructionalRole: row.instructional_role, expectedDepth: row.expected_depth, priority: row.priority, confidence: row.confidence, rationale: row.rationale, entity, sources: sources.get(row.id) ?? [] }];
    }) };
  }

  async getCurriculumSemanticEntity(entityId: string): Promise<CurriculumSemanticEntityRecord | null> {
    const result = await this.database.query<{ release_id: string }>({ sql: `SELECT e.release_id FROM curriculum_semantic_entity_revisions e
      JOIN curriculum_semantic_releases r ON r.id = e.release_id
      WHERE e.semantic_entity_id = ? AND e.review_state = 'approved' AND r.status = 'published'
      ORDER BY r.published_at DESC LIMIT 1`, params: [entityId] });
    const releaseId = result.rows[0]?.release_id; if (!releaseId) return null;
    return (await this.entities(releaseId, [entityId])).get(entityId) ?? null;
  }

  async traceCurriculumSemanticPath(args: { entityId: string; direction: "backward" | "forward"; relationTypes?: CurriculumSemanticRelation[]; maxDepth?: number }): Promise<CurriculumSemanticPathStep[]> {
    const types = (args.relationTypes?.length ? args.relationTypes : ["prerequisite", "develops_into", "supports"]).slice(0, 7);
    const depthLimit = Math.min(Math.max(args.maxDepth ?? 3, 1), 6);
    const marks = types.map(() => "?").join(",");
    const relationRows = await this.database.query<RelationRow>({ sql: `SELECT x.id, x.release_id, x.from_entity_id, x.to_entity_id, x.relation_type, x.strength, x.confidence, x.rationale
      FROM curriculum_semantic_relations x JOIN curriculum_semantic_releases r ON r.id = x.release_id
      WHERE r.status = 'published' AND x.review_state = 'approved' AND x.relation_type IN (${marks})`, params: types });
    const directed = relationRows.rows.map((row) => ({ row, current: args.direction === "forward" ? row.from_entity_id : row.to_entity_id, next: args.direction === "forward" ? row.to_entity_id : row.from_entity_id }));
    const queue = [{ current: args.entityId, depth: 0, visited: new Set([args.entityId]) }];
    const found: Array<{ row: RelationRow; next: string; depth: number }> = [];
    while (queue.length) {
      const state = queue.shift()!; if (state.depth >= depthLimit) continue;
      for (const edge of directed.filter((edge) => edge.current === state.current && !state.visited.has(edge.next))) {
        const depth = state.depth + 1; found.push({ row: edge.row, next: edge.next, depth });
        queue.push({ current: edge.next, depth, visited: new Set([...state.visited, edge.next]) });
      }
    }
    const entityCache = new Map<string, CurriculumSemanticEntityRecord>();
    const unique = (values: string[]) => [...new Set(values)];
    for (const releaseId of unique(found.map((item) => item.row.release_id))) {
      const ids = unique(found.filter((item) => item.row.release_id === releaseId).flatMap((item) => [item.row.from_entity_id, item.row.to_entity_id]));
      for (const [id, entity] of await this.entities(releaseId, ids)) entityCache.set(`${releaseId}:${id}`, entity);
    }
    const relationSources = await this.sources("curriculum_semantic_relation_sources", "relation_id", undefined, found.map((item) => item.row.id));
    const locations = await this.locations(unique(found.map((item) => item.next)));
    return found.flatMap((item) => {
      const from = entityCache.get(`${item.row.release_id}:${item.row.from_entity_id}`); const to = entityCache.get(`${item.row.release_id}:${item.row.to_entity_id}`); const reached = entityCache.get(`${item.row.release_id}:${item.next}`);
      if (!from || !to || !reached) return [];
      return [{ relationId: item.row.id, relationType: item.row.relation_type, depth: item.depth, strength: item.row.strength, confidence: item.row.confidence, rationale: item.row.rationale, fromEntity: from, toEntity: to, reachedEntity: reached, locations: locations.get(item.next) ?? [], sources: relationSources.get(item.row.id) ?? [] }];
    }).sort((left, right) => left.depth - right.depth || left.relationType.localeCompare(right.relationType) || left.relationId.localeCompare(right.relationId));
  }

  private async entities(releaseId: string, ids: string[]) {
    const unique = [...new Set(ids)]; if (!unique.length) return new Map<string, CurriculumSemanticEntityRecord>();
    const marks = unique.map(() => "?").join(",");
    const result = await this.database.query<EntityRow>({ sql: `SELECT v.release_id, v.semantic_entity_id, e.kind, v.canonical_name, v.definition, v.payload_json, v.confidence
      FROM curriculum_semantic_entity_revisions v JOIN curriculum_semantic_entities e ON e.id = v.semantic_entity_id
      WHERE v.release_id = ? AND v.review_state = 'approved' AND v.semantic_entity_id IN (${marks})`, params: [releaseId, ...unique] });
    const sources = await this.sources("curriculum_semantic_entity_sources", "semantic_entity_id", releaseId, unique);
    return new Map(result.rows.map((row) => [row.semantic_entity_id, { id: row.semantic_entity_id, kind: row.kind, canonicalName: row.canonical_name, definition: row.definition, payload: parseObject(row.payload_json), confidence: row.confidence, sources: sources.get(row.semantic_entity_id) ?? [] }]));
  }

  private async sources(linkTable: "curriculum_semantic_entity_sources" | "curriculum_semantic_relation_sources" | "curriculum_node_semantic_sources", linkColumn: "semantic_entity_id" | "relation_id" | "node_semantic_id", releaseId: string | undefined, ids: string[]) {
    const unique = [...new Set(ids)]; if (!unique.length) return new Map<string, CurriculumSemanticSource[]>();
    const marks = unique.map(() => "?").join(","); const release = releaseId ? ` AND link.release_id = ?` : "";
    const result = await this.database.query<SourceRow>({ sql: `SELECT link.${linkColumn} AS owner_id, s.source_ref_id, s.title, s.url, s.authority, s.locator
      FROM ${linkTable} link JOIN curriculum_semantic_sources s ON s.release_id = link.release_id AND s.id = link.source_id
      WHERE link.${linkColumn} IN (${marks})${release} ORDER BY s.title, s.source_ref_id`, params: releaseId ? [...unique, releaseId] : unique });
    const grouped = new Map<string, CurriculumSemanticSource[]>();
    for (const row of result.rows) { const list = grouped.get(row.owner_id) ?? []; list.push({ id: row.source_ref_id, title: row.title, url: row.url ?? undefined, kind: "public", authority: row.authority, locator: row.locator ?? undefined }); grouped.set(row.owner_id, list); }
    return grouped;
  }

  private async locations(entityIds: string[]) {
    const unique = [...new Set(entityIds)]; if (!unique.length) return new Map<string, CurriculumSemanticPathStep["locations"]>();
    const marks = unique.map(() => "?").join(",");
    const result = await this.database.query<Record<string, unknown>>({ sql: `SELECT m.semantic_entity_id, m.instructional_role, m.expected_depth, b.id AS textbook_id, b.title AS textbook_title, b.stage, b.subject, b.edition, b.grade, b.volume, b.publisher_id, b.ebook_id, b.detail_url, b.tree_url, b.source_pdf_url, b.source_list_url, b.node_count, b.source_updated_at, n.node_id, n.parent_id, n.level, n.sort_no, n.title AS node_title, n.page_number
      FROM curriculum_node_semantics m JOIN curriculum_semantic_releases r ON r.id = m.release_id
      JOIN curriculum_catalog_releases cr ON cr.generation_id = r.catalog_generation_id AND cr.status = 'published'
      JOIN curriculum_textbooks b ON b.catalog_release_id = cr.id AND b.id = m.textbook_id
      JOIN curriculum_nodes n ON n.catalog_release_id = b.catalog_release_id AND n.textbook_id = m.textbook_id AND n.node_id = m.node_id
      WHERE r.status = 'published' AND m.review_state = 'approved' AND m.semantic_entity_id IN (${marks})
      ORDER BY b.grade, b.title, n.level, n.sort_no, n.node_id`, params: unique });
    const grouped = new Map<string, CurriculumSemanticPathStep["locations"]>();
    for (const row of result.rows) { const list = grouped.get(String(row.semantic_entity_id)) ?? []; list.push({ textbook: { id: String(row.textbook_id), title: String(row.textbook_title), stage: String(row.stage), subject: String(row.subject), edition: String(row.edition), grade: String(row.grade), volume: String(row.volume), publisherId: String(row.publisher_id), ebookId: nullable(row.ebook_id), detailUrl: nullable(row.detail_url), treeUrl: nullable(row.tree_url), sourcePdfUrl: nullable(row.source_pdf_url), sourceListUrl: nullable(row.source_list_url), nodeCount: Number(row.node_count), sourceUpdatedAt: nullable(row.source_updated_at) }, node: { textbookId: String(row.textbook_id), nodeId: String(row.node_id), parentId: nullable(row.parent_id), level: Number(row.level), sortNo: Number(row.sort_no), title: String(row.node_title), pageNumber: row.page_number == null ? null : Number(row.page_number) }, instructionalRole: row.instructional_role as CurriculumNodeSemanticMapping["instructionalRole"], expectedDepth: Number(row.expected_depth) }); grouped.set(String(row.semantic_entity_id), list); }
    return grouped;
  }
}

function releaseRecord(row: ReleaseRow) { return { id: row.id, scopeKey: row.scope_key, catalogGenerationId: row.catalog_generation_id, subject: row.subject, stage: row.stage, edition: row.edition, grade: row.grade, volume: row.volume, schemaVersion: row.schema_version, publishedAt: row.published_at ?? "" }; }
function nullable(value: unknown) { return value == null ? null : String(value); }
function parseObject(value: string) { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
