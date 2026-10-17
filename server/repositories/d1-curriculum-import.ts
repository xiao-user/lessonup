import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../domain.js";
import { deterministicUuid } from "../curriculum/knowledge-sample.js";
import type { CurriculumStandardChunk } from "../curriculum/standard-chunker.js";
import type { SqlDatabase, SqlStatement, SqlValue } from "../platform/sql-database.js";

/**
 * Offline writers for platform curriculum data (catalog, knowledge network,
 * national standards). They run from maintenance scripts through the same
 * `SqlDatabase` port as the Worker repositories, so they are testable against
 * the real D1 migrations.
 *
 * `SqlDatabase.batch` is only atomic on a real D1 binding. Scripts drive these
 * writers through the Wrangler CLI, where it is not, so every writer loads data
 * under a draft release id that no reader can see, verifies it, and only then
 * flips visibility with one small final batch.
 */

/** D1 rejects statements with more than 100 bound parameters. */
const MAX_STATEMENT_PARAMETERS = 100;
/** D1 rejects statements larger than 100 KB; stay well below it. */
const MAX_STATEMENT_BYTES = 60_000;
const WRITE_BATCH_STATEMENTS = 150;
const ID_LIST_SIZE = 90;

type Row = readonly SqlValue[];

export type CurriculumImportOptions = {
  now?: string;
  onProgress?: (message: string) => void;
  /** Remote CLI batches are not atomic; do not replace a live catalog through them. */
  allowCatalogReplacement?: boolean;
};

function rowBytes(row: Row) {
  return row.reduce<number>((total, value) => total + (typeof value === "string" ? value.length : 8), 0);
}

function insertRows(table: string, columns: readonly string[], rows: readonly Row[], suffix: string): SqlStatement[] {
  const maxRows = Math.max(1, Math.floor(MAX_STATEMENT_PARAMETERS / columns.length));
  const marks = `(${columns.map(() => "?").join(", ")})`;
  const statements: SqlStatement[] = [];
  let group: Row[] = [];
  let bytes = 0;
  const flush = () => {
    if (!group.length) return;
    statements.push({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => marks).join(", ")} ${suffix}`,
      params: group.flat(),
    });
    group = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = rowBytes(row);
    if (group.length && (group.length >= maxRows || bytes + size > MAX_STATEMENT_BYTES)) flush();
    group.push(row);
    bytes += size;
  }
  flush();
  return statements;
}

async function writeAll(db: SqlDatabase, statements: readonly SqlStatement[], label: string, options: CurriculumImportOptions) {
  for (let start = 0; start < statements.length; start += WRITE_BATCH_STATEMENTS) {
    await db.batch(statements.slice(start, start + WRITE_BATCH_STATEMENTS));
    options.onProgress?.(`${label}: ${Math.min(start + WRITE_BATCH_STATEMENTS, statements.length)}/${statements.length} batches`);
  }
}

const upsertAssignments = (columns: readonly string[]) => columns
  .map((column) => `${column} = excluded.${column}`)
  .join(", ");

function chunk<T>(items: readonly T[], size: number) {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

/** Single precision is what the embedding models produce; it keeps rows under D1's size limits. */
const embeddingJson = (vector: readonly number[]) => JSON.stringify(vector.map((value) => Number(value.toPrecision(7))));

// ---------------------------------------------------------------------------
// Textbook catalog
// ---------------------------------------------------------------------------

export type CurriculumCatalogImportInput = {
  /** Stable hash of the source files; equal content always maps to one release. */
  generationId: string;
  manifest: Record<string, unknown>;
  textbooks: readonly CurriculumTextbookRecord[];
  nodes: readonly CurriculumNodeRecord[];
};

const textbookColumns = [
  "id", "catalog_release_id", "title", "stage", "subject", "edition", "grade", "volume", "publisher_id",
  "ebook_id", "detail_url", "tree_url", "source_pdf_url", "source_list_url", "node_count", "source_updated_at",
] as const;
const nodeColumns = [
  "catalog_release_id", "textbook_id", "node_id", "parent_id", "level", "sort_no", "title", "page_number",
] as const;

function assertCatalogConsistency(input: CurriculumCatalogImportInput) {
  const textbookIds = new Set<string>();
  for (const book of input.textbooks) {
    if (textbookIds.has(book.id)) throw new Error("curriculum_catalog_duplicate_textbook");
    textbookIds.add(book.id);
  }
  const nodeKeys = new Set<string>();
  const counts = new Map<string, number>();
  for (const node of input.nodes) {
    if (!textbookIds.has(node.textbookId)) throw new Error("curriculum_catalog_unknown_textbook");
    const key = `${node.textbookId}\u0000${node.nodeId}`;
    if (nodeKeys.has(key)) throw new Error("curriculum_catalog_duplicate_node");
    nodeKeys.add(key);
    counts.set(node.textbookId, (counts.get(node.textbookId) ?? 0) + 1);
  }
  for (const node of input.nodes) {
    if (node.parentId !== null && !nodeKeys.has(`${node.textbookId}\u0000${node.parentId}`)) {
      throw new Error("curriculum_catalog_orphan_node");
    }
  }
  for (const book of input.textbooks) {
    if (book.nodeCount !== (counts.get(book.id) ?? 0)) throw new Error("curriculum_catalog_book_count_mismatch");
  }
}

/**
 * Loads one catalog snapshot and makes it current.
 *
 * Nodes are keyed by release, so the new snapshot loads invisibly. A textbook
 * row is keyed by its stable id alone and belongs to exactly one release: rows
 * that already exist get their metadata refreshed in place but stay attached
 * to the release readers currently use until the final publish batch moves
 * them together with the `curriculum_catalog_current` pointer.
 */
export async function importCurriculumCatalog(
  db: SqlDatabase,
  input: CurriculumCatalogImportInput,
  options: CurriculumImportOptions = {},
) {
  const now = options.now ?? new Date().toISOString();
  assertCatalogConsistency(input);
  const [existing, current] = await Promise.all([
    db.query<{ id: string }>({
      sql: "SELECT id FROM curriculum_catalog_releases WHERE generation_id = ? ORDER BY created_at LIMIT 1",
      params: [input.generationId],
    }),
    db.query<{ catalog_release_id: string }>({
      sql: "SELECT catalog_release_id FROM curriculum_catalog_current WHERE singleton = 1",
    }),
  ]);
  const releaseId = existing.rows[0]?.id ?? deterministicUuid("lessonup:curriculum-catalog-release", input.generationId);
  const summary = { releaseId, textbooks: input.textbooks.length, nodes: input.nodes.length };
  if (current.rows[0]?.catalog_release_id === releaseId) return { status: "already_current" as const, ...summary };
  const currentReleaseId = current.rows[0]?.catalog_release_id;
  if (currentReleaseId) {
    if (options.allowCatalogReplacement === false) throw new Error("curriculum_catalog_remote_replacement_requires_migration");
    const references = await db.query<{ total: number }>({
      sql: "SELECT COUNT(*) AS total FROM semester_frameworks WHERE catalog_release_id = ?",
      params: [currentReleaseId],
    });
    if (Number(references.rows[0]?.total ?? 0) > 0) throw new Error("curriculum_catalog_release_in_use");
  }

  await db.query({
    sql: `INSERT INTO curriculum_catalog_releases
      (id, generation_id, status, snapshot_complete, manifest_json, textbook_count, node_count, created_at)
      VALUES (?, ?, 'draft', 0, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    params: [releaseId, input.generationId, json(input.manifest), input.textbooks.length, input.nodes.length, now],
  });
  await writeAll(db, insertRows(
    "curriculum_textbooks",
    textbookColumns,
    input.textbooks.map((book) => [
      book.id, releaseId, book.title, book.stage, book.subject, book.edition, book.grade, book.volume,
      book.publisherId, book.ebookId, book.detailUrl, book.treeUrl, book.sourcePdfUrl, book.sourceListUrl,
      book.nodeCount, book.sourceUpdatedAt,
    ]),
    `ON CONFLICT(id) DO UPDATE SET ${upsertAssignments(textbookColumns.filter((column) => column !== "id" && column !== "catalog_release_id"))}`,
  ), "textbooks", options);
  await writeAll(db, insertRows(
    "curriculum_nodes",
    nodeColumns,
    input.nodes.map((node) => [
      releaseId, node.textbookId, node.nodeId, node.parentId, node.level, node.sortNo, node.title, node.pageNumber,
    ]),
    `ON CONFLICT(catalog_release_id, textbook_id, node_id) DO UPDATE SET ${upsertAssignments(nodeColumns.filter((column) => !["catalog_release_id", "textbook_id", "node_id"].includes(column)))}`,
  ), "nodes", options);

  const [storedNodes, storedBooks] = await Promise.all([
    db.query<{ textbook_id: string; total: number }>({
      sql: "SELECT textbook_id, COUNT(*) AS total FROM curriculum_nodes WHERE catalog_release_id = ? GROUP BY textbook_id",
      params: [releaseId],
    }),
    db.query<{ id: string }>({ sql: "SELECT id FROM curriculum_textbooks" }),
  ]);
  const nodeCounts = new Map(storedNodes.rows.map((row) => [row.textbook_id, Number(row.total)]));
  const storedBookIds = new Set(storedBooks.rows.map((row) => row.id));
  const expectedCounts = new Map<string, number>();
  for (const node of input.nodes) expectedCounts.set(node.textbookId, (expectedCounts.get(node.textbookId) ?? 0) + 1);
  const complete = nodeCounts.size === expectedCounts.size
    && [...expectedCounts].every(([id, total]) => nodeCounts.get(id) === total)
    && input.textbooks.every((book) => storedBookIds.has(book.id));
  if (!complete) throw new Error("curriculum_catalog_import_incomplete");

  await db.batch([
    ...chunk(input.textbooks.map((book) => book.id), ID_LIST_SIZE).map((ids) => ({
      sql: `UPDATE curriculum_textbooks SET catalog_release_id = ? WHERE id IN (${ids.map(() => "?").join(", ")})`,
      params: [releaseId, ...ids],
    })),
    {
      sql: "UPDATE curriculum_catalog_releases SET status = 'retired', retired_at = ? WHERE status = 'published' AND id <> ?",
      params: [now, releaseId],
    },
    {
      sql: `UPDATE curriculum_catalog_releases SET status = 'published', snapshot_complete = 1, manifest_json = ?,
        textbook_count = ?, node_count = ?, published_at = ?, retired_at = NULL WHERE id = ?`,
      params: [json(input.manifest), input.textbooks.length, input.nodes.length, now, releaseId],
    },
    {
      sql: `INSERT INTO curriculum_catalog_current (singleton, catalog_release_id, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET catalog_release_id = excluded.catalog_release_id, updated_at = excluded.updated_at`,
      params: [releaseId, now],
    },
  ]);
  return { status: "published" as const, ...summary };
}

// ---------------------------------------------------------------------------
// Knowledge network (semantic release)
// ---------------------------------------------------------------------------

export type CurriculumKnowledgeImportPayload = {
  release: {
    id: string;
    scopeKey: string;
    catalogGenerationId: string;
    subject: string;
    stage: string;
    edition: string;
    grade: string;
    volume: string;
    sourceManifest: Record<string, unknown>;
  };
  entities: Array<{
    id: string;
    externalId: string;
    canonicalKey: string;
    name: string;
    definition: string;
    payload: Record<string, unknown>;
    embedding?: readonly number[];
    embeddingModel?: string;
    source: { id: string; refId: string; title: string; url?: string | null; authority: string; locator?: string | null };
  }>;
  occurrences: Array<{
    id: string;
    entityId: string;
    sourceId: string;
    textbookId: string;
    nodeId: string;
    sequenceNo: number;
    priority: number;
    printedPages: string;
    recommendedPeriod: number | null;
    payload: Record<string, unknown>;
  }>;
  periodRecommendations: Array<{
    id: string;
    textbookId: string;
    nodeId: string;
    periodNo: number;
    sequenceNo: number;
    title: string;
    mappingType: string;
    isOfficial: boolean;
    note: string;
    points: Array<{ entityId: string; sortNo: number }>;
  }>;
};

async function currentCatalog(db: SqlDatabase) {
  const result = await db.query<{ release_id: string; generation_id: string }>({
    sql: `SELECT r.id AS release_id, r.generation_id FROM curriculum_catalog_current c
      JOIN curriculum_catalog_releases r ON r.id = c.catalog_release_id WHERE c.singleton = 1`,
  });
  return result.rows[0] ?? null;
}

async function assertSingleRow(db: SqlDatabase, sql: string, params: SqlValue[], error: string) {
  const result = await db.query<{ total: number }>({ sql, params });
  if (Number(result.rows[0]?.total ?? 0) > 0) throw new Error(error);
}

/**
 * Publishes a draft semantic release after the same publication checks the
 * former database function made. This importer never writes relations, so a
 * release that has any is refused rather than published without a cycle check.
 */
export async function publishCurriculumSemanticRelease(db: SqlDatabase, releaseId: string, now = new Date().toISOString()) {
  const release = (await db.query<{ status: string; scope_key: string; catalog_generation_id: string }>({
    sql: "SELECT status, scope_key, catalog_generation_id FROM curriculum_semantic_releases WHERE id = ?",
    params: [releaseId],
  })).rows[0];
  if (!release) throw new Error("curriculum_semantic_release_not_found");
  if (release.status !== "draft") throw new Error("curriculum_semantic_release_not_draft");
  const catalog = await currentCatalog(db);
  if (!catalog || catalog.generation_id !== release.catalog_generation_id) {
    throw new Error("curriculum_semantic_catalog_generation_mismatch");
  }
  const entities = await db.query<{ total: number }>({
    sql: "SELECT COUNT(*) AS total FROM curriculum_semantic_entity_revisions WHERE release_id = ?",
    params: [releaseId],
  });
  if (!Number(entities.rows[0]?.total ?? 0)) throw new Error("curriculum_semantic_release_empty");
  await assertSingleRow(db, "SELECT COUNT(*) AS total FROM curriculum_semantic_relations WHERE release_id = ?", [releaseId], "curriculum_semantic_relation_unpublishable");
  await assertSingleRow(db, `SELECT COUNT(*) AS total FROM curriculum_semantic_entity_revisions revision
    WHERE revision.release_id = ? AND (revision.review_state <> 'approved' OR NOT EXISTS (
      SELECT 1 FROM curriculum_semantic_entity_sources link
      WHERE link.release_id = revision.release_id AND link.semantic_entity_id = revision.semantic_entity_id))`,
  [releaseId], "curriculum_semantic_entity_unpublishable");
  await assertSingleRow(db, `SELECT COUNT(*) AS total FROM curriculum_node_semantics mapping
    LEFT JOIN curriculum_nodes node ON node.catalog_release_id = ? AND node.textbook_id = mapping.textbook_id AND node.node_id = mapping.node_id
    WHERE mapping.release_id = ? AND (mapping.review_state <> 'approved' OR node.node_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM curriculum_semantic_entity_revisions revision
      WHERE revision.release_id = mapping.release_id AND revision.semantic_entity_id = mapping.semantic_entity_id
    ) OR NOT EXISTS (
      SELECT 1 FROM curriculum_node_semantic_sources link
      WHERE link.release_id = mapping.release_id AND link.node_semantic_id = mapping.id))`,
  [catalog.release_id, releaseId], "curriculum_node_semantic_unpublishable");
  await db.batch([
    {
      sql: "UPDATE curriculum_semantic_releases SET status = 'retired', retired_at = ? WHERE scope_key = ? AND status = 'published' AND id <> ?",
      params: [now, release.scope_key, releaseId],
    },
    {
      sql: "UPDATE curriculum_semantic_releases SET status = 'published', published_at = ?, retired_at = NULL WHERE id = ?",
      params: [now, releaseId],
    },
  ]);
}

/** Replaces any unpublished release with the same id, then loads the payload as a draft or published release. */
export async function importCurriculumKnowledgeRelease(
  db: SqlDatabase,
  payload: CurriculumKnowledgeImportPayload,
  args: { publish: boolean } & CurriculumImportOptions,
) {
  const now = args.now ?? new Date().toISOString();
  const { release } = payload;
  if (!release.id || !release.scopeKey || !release.catalogGenerationId) throw new Error("curriculum_knowledge_payload_invalid");
  if (!payload.entities.length) throw new Error("curriculum_semantic_release_empty");
  const catalog = await currentCatalog(db);
  if (catalog?.generation_id !== release.catalogGenerationId) throw new Error("curriculum_semantic_catalog_generation_mismatch");
  const existing = (await db.query<{ status: string }>({
    sql: "SELECT status FROM curriculum_semantic_releases WHERE id = ?",
    params: [release.id],
  })).rows[0];
  if (existing?.status === "published") return { releaseId: release.id, status: "already_published" as const };
  if (existing) await db.query({ sql: "DELETE FROM curriculum_semantic_releases WHERE id = ?", params: [release.id] });

  const reviewState = args.publish ? "approved" : "draft";
  await db.query({
    sql: `INSERT INTO curriculum_semantic_releases (id, scope_key, catalog_generation_id, subject, stage, edition, grade, volume,
      schema_version, status, source_manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 'draft', ?, ?)`,
    params: [release.id, release.scopeKey, release.catalogGenerationId, release.subject, release.stage,
      release.edition, release.grade, release.volume, json(release.sourceManifest), now],
  });
  const statements: SqlStatement[] = [
    ...insertRows("curriculum_semantic_entities", ["id", "subject", "stage", "kind", "canonical_key", "created_at"],
      payload.entities.map((entity) => [entity.id, release.subject, release.stage, "knowledge_point", entity.canonicalKey, now]),
      "ON CONFLICT(id) DO NOTHING"),
    ...insertRows("curriculum_semantic_entity_revisions",
      ["release_id", "semantic_entity_id", "canonical_name", "definition", "payload_json", "external_id", "search_text",
        "embedding_json", "embedding_model", "confidence", "review_state"],
      payload.entities.map((entity) => [release.id, entity.id, entity.name, entity.definition, json(entity.payload),
        entity.externalId, `${entity.name} ${entity.definition}`,
        entity.embedding ? embeddingJson(entity.embedding) : null, entity.embeddingModel ?? null, 1, reviewState]), ""),
    ...insertRows("curriculum_semantic_sources", ["id", "release_id", "source_ref_id", "title", "url", "authority", "locator", "created_at"],
      payload.entities.map(({ source }) => [source.id, release.id, source.refId, source.title, source.url ?? null,
        source.authority, source.locator ?? null, now]), ""),
    ...insertRows("curriculum_semantic_entity_sources", ["release_id", "semantic_entity_id", "source_id"],
      payload.entities.map((entity) => [release.id, entity.id, entity.source.id]), ""),
    ...insertRows("curriculum_node_semantics",
      ["id", "release_id", "textbook_id", "node_id", "semantic_entity_id", "instructional_role", "expected_depth", "priority",
        "confidence", "rationale", "review_state", "sequence_no", "printed_pages", "recommended_period", "payload_json"],
      payload.occurrences.map((item) => [item.id, release.id, item.textbookId, item.nodeId, item.entityId, "occurs_in", 0,
        item.priority, 1, "样本知识点与教材目录节点的直接映射。", reviewState, item.sequenceNo, item.printedPages,
        item.recommendedPeriod, json(item.payload)]), ""),
    ...insertRows("curriculum_node_semantic_sources", ["release_id", "node_semantic_id", "source_id"],
      payload.occurrences.map((item) => [release.id, item.id, item.sourceId]), ""),
    ...insertRows("curriculum_period_recommendations",
      ["id", "release_id", "textbook_id", "node_id", "period_no", "sequence_no", "title", "mapping_type", "is_official", "note", "review_state"],
      payload.periodRecommendations.map((item) => [item.id, release.id, item.textbookId, item.nodeId, item.periodNo,
        item.sequenceNo, item.title, item.mappingType, item.isOfficial ? 1 : 0, item.note, reviewState]), ""),
    ...insertRows("curriculum_period_recommendation_points", ["release_id", "period_recommendation_id", "semantic_entity_id", "sort_no"],
      payload.periodRecommendations.flatMap((item) => item.points.map((point) => [release.id, item.id, point.entityId, point.sortNo])), ""),
  ];
  await writeAll(db, statements, "knowledge release", args);
  if (args.publish) await publishCurriculumSemanticRelease(db, release.id, now);
  return {
    releaseId: release.id,
    status: args.publish ? "published" as const : "draft" as const,
    entities: payload.entities.length,
    occurrences: payload.occurrences.length,
    periodRecommendations: payload.periodRecommendations.length,
  };
}

// ---------------------------------------------------------------------------
// National curriculum standards
// ---------------------------------------------------------------------------

export type CurriculumStandardReleaseInput = {
  id: string;
  seriesKey: string;
  releaseKey: string;
  title: string;
  versionLabel: string;
  authority: string;
  issuedYear: number | null;
  expectedDocumentCount: number;
  metadata?: Record<string, unknown>;
};

export type CurriculumStandardDocumentInput = {
  filename: string;
  title: string;
  kind: "curriculum_standard" | "curriculum_plan";
  subject: string | null;
  stageScope: readonly string[];
  gradeScope: readonly string[];
  standardCode?: string;
  sourceUrl?: string;
  parsedSha256: string;
};

/** A normalized chunk; the parse ordinal is not stored. */
export type CurriculumStandardChunkInput = Omit<CurriculumStandardChunk, "ordinal">;
export type CurriculumStandardEmbedder = (texts: string[]) => Promise<number[][]>;
export type CurriculumStandardReleaseStatus = "draft" | "published" | "retired";

/** The standards label sections by learning stage; readers filter by school stage. */
const schoolStageByLearningStage: Record<string, string> = {
  "第一学段": "小学",
  "第二学段": "小学",
  "第三学段": "小学",
  "第四学段": "初中",
};

/**
 * Chunk scope columns are derived from the normalized heading path, so grade
 * and stage filtering can run before ranking without re-parsing or
 * re-embedding anything. `stage` uses the school-stage vocabulary that
 * notebooks and `searchCurriculumStandards` requests use ("小学"/"初中"), not
 * the document's own "第四学段" label: the reader compares the two directly, and
 * a raw learning-stage label would exclude every labelled chunk.
 */
export function curriculumStandardChunkScope(section: string) {
  const range = section.match(/([1-9])\s*[～~—–-]\s*([1-9])\s*年级/);
  const start = range ? Number(range[1]) : null;
  const end = range ? Number(range[2]) : null;
  const ordered = start !== null && end !== null && start <= end;
  const learningStage = section.match(/(第[一二三四五六七八九十]+学段)/)?.[1];
  return {
    stage: (learningStage && schoolStageByLearningStage[learningStage]) || null,
    domain: section.match(/【([^】]+)】/)?.[1] ?? null,
    gradeStart: ordered ? start : null,
    gradeEnd: ordered ? end : null,
  };
}

export async function ensureCurriculumStandardRelease(db: SqlDatabase, release: CurriculumStandardReleaseInput, now = new Date().toISOString()) {
  await db.query({
    sql: `INSERT INTO curriculum_standard_releases (id, series_key, release_key, title, version_label, authority, issued_year,
      expected_document_count, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      ON CONFLICT(release_key) DO NOTHING`,
    params: [release.id, release.seriesKey, release.releaseKey, release.title, release.versionLabel, release.authority,
      release.issuedYear, release.expectedDocumentCount, json(release.metadata), now, now],
  });
  const stored = (await db.query<{ id: string; status: CurriculumStandardReleaseStatus; expected_document_count: number }>({
    sql: "SELECT id, status, expected_document_count FROM curriculum_standard_releases WHERE release_key = ?",
    params: [release.releaseKey],
  })).rows[0];
  if (!stored || stored.id !== release.id) throw new Error("curriculum_standard_release_identity_conflict");
  if (stored.status === "draft" && Number(stored.expected_document_count) !== release.expectedDocumentCount) {
    await db.query({
      sql: "UPDATE curriculum_standard_releases SET expected_document_count = ?, updated_at = ? WHERE id = ?",
      params: [release.expectedDocumentCount, now, stored.id],
    });
  }
  return { id: stored.id, status: stored.status };
}

async function readStandardDocument(db: SqlDatabase, releaseId: string, filename: string) {
  const result = await db.query<{ id: string; file_sha256: string; index_version: string; chunk_count: number; embedded_count: number }>({
    sql: `SELECT d.id, d.file_sha256, d.index_version,
        (SELECT COUNT(*) FROM curriculum_standard_chunks c WHERE c.document_id = d.id) AS chunk_count,
        (SELECT COUNT(*) FROM curriculum_standard_chunks c WHERE c.document_id = d.id AND c.embedding_json IS NOT NULL) AS embedded_count
      FROM curriculum_standard_documents d WHERE d.release_id = ? AND d.filename = ?`,
    params: [releaseId, filename],
  });
  const row = result.rows[0];
  return row ? {
    id: row.id, fileSha256: row.file_sha256, indexVersion: row.index_version,
    chunkCount: Number(row.chunk_count), embeddedCount: Number(row.embedded_count),
  } : null;
}

const chunkColumns = [
  "id", "document_id", "stable_chunk_id", "page", "page_end", "passage", "section", "curriculum_stage",
  "grade_start", "grade_end", "curriculum_domain", "embedding_json", "metadata_json", "created_at",
] as const;

/**
 * Indexes one normalized document into a release.
 *
 * - Draft release: (re)writes the document and its chunks. Embeddings already
 *   stored for an identical passage are reused so an interrupted run resumes
 *   without paying for the whole document again.
 * - Published or retired release: passages are immutable. The document may only
 *   gain missing embeddings and derived scope columns, and every stored passage
 *   must equal the normalized one.
 *
 * A document only counts as ready once its `index_version` is final, which is
 * written last.
 */
export async function indexCurriculumStandardDocument(db: SqlDatabase, args: {
  release: { id: string; status: CurriculumStandardReleaseStatus };
  document: CurriculumStandardDocumentInput;
  chunks: readonly CurriculumStandardChunkInput[];
  indexVersion: string;
  embed: CurriculumStandardEmbedder;
  now?: string;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<"skipped" | "indexed" | "backfilled"> {
  const { release, document, chunks, indexVersion } = args;
  const now = args.now ?? new Date().toISOString();
  const batchSize = args.batchSize ?? 16;
  const state = await readStandardDocument(db, release.id, document.filename);
  if (state && state.fileSha256 !== document.parsedSha256 && release.status !== "draft") {
    throw new Error("curriculum_standard_published_filename_changed");
  }
  if (
    state
    && state.fileSha256 === document.parsedSha256
    && state.indexVersion === indexVersion
    && state.chunkCount === chunks.length
    && state.embeddedCount === chunks.length
  ) return "skipped";
  if (release.status !== "draft" && !state) throw new Error("curriculum_standard_release_immutable");

  const documentId = state?.id ?? deterministicUuid(release.id, `${document.filename}:${document.parsedSha256}`);
  const stored = state
    ? (await db.query<{
      id: string; stable_chunk_id: string; passage: string; section: string | null; embedding_json: string | null;
      curriculum_stage: string | null; grade_start: number | null; grade_end: number | null; curriculum_domain: string | null;
    }>({
      sql: `SELECT id, stable_chunk_id, passage, section, embedding_json, curriculum_stage, grade_start, grade_end, curriculum_domain
        FROM curriculum_standard_chunks WHERE document_id = ?`,
      params: [documentId],
    })).rows
    : [];
  const storedByStableId = new Map(stored.map((row) => [row.stable_chunk_id, row]));
  const reusable = (item: CurriculumStandardChunkInput) => {
    const row = storedByStableId.get(item.stableChunkId);
    return row && row.embedding_json && row.passage === item.passage && (row.section ?? "") === item.section
      ? row.embedding_json
      : null;
  };

  if (release.status !== "draft") {
    if (stored.length !== chunks.length || chunks.some((item) => {
      const row = storedByStableId.get(item.stableChunkId);
      return !row || row.passage !== item.passage || (row.section ?? "") !== item.section;
    })) throw new Error("curriculum_standard_published_content_changed");
  } else {
    await db.query({
      sql: `INSERT INTO curriculum_standard_documents (id, release_id, filename, title, subject, document_kind, stage_scope_json,
        grade_scope_json, standard_code, source_url, file_sha256, index_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(release_id, filename) DO UPDATE SET title = excluded.title, subject = excluded.subject,
          document_kind = excluded.document_kind, stage_scope_json = excluded.stage_scope_json,
          grade_scope_json = excluded.grade_scope_json, standard_code = excluded.standard_code,
          source_url = excluded.source_url, file_sha256 = excluded.file_sha256,
          index_version = excluded.index_version, updated_at = excluded.updated_at`,
      params: [documentId, release.id, document.filename, document.title, document.subject, document.kind,
        JSON.stringify(document.stageScope), JSON.stringify(document.gradeScope), document.standardCode || null,
        document.sourceUrl || null, document.parsedSha256, `indexing:${indexVersion}`, now, now],
    });
  }

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const missing = batch.filter((item) => !reusable(item));
    const vectors = missing.length ? await args.embed(missing.map((item) => item.embeddingText)) : [];
    if (vectors.length !== missing.length) throw new Error("embedding_shape_invalid");
    const vectorByStableId = new Map(missing.map((item, index) => [item.stableChunkId, embeddingJson(vectors[index]!)]));
    const rows = batch.map((item, offset) => {
      const scope = curriculumStandardChunkScope(item.section);
      const row = storedByStableId.get(item.stableChunkId);
      return {
        item,
        scope,
        id: row?.id ?? deterministicUuid(documentId, item.stableChunkId),
        embedding: reusable(item) ?? vectorByStableId.get(item.stableChunkId)!,
        createdAt: new Date(Date.parse(now) + start + offset).toISOString(),
      };
    });
    if (release.status === "draft") {
      await db.batch(insertRows("curriculum_standard_chunks", chunkColumns, rows.map(({ item, scope, id, embedding, createdAt }) => [
        id, documentId, item.stableChunkId, item.pageStart, item.pageEnd, item.passage, item.section, scope.stage,
        scope.gradeStart, scope.gradeEnd, scope.domain, embedding,
        json({
          headingPath: item.headingPath, blockRefs: item.blockRefs, labels: item.labels,
          averageConfidence: item.averageConfidence, contentSha256: item.contentSha256,
        }),
        createdAt,
      ]), `ON CONFLICT(document_id, stable_chunk_id) DO UPDATE SET ${upsertAssignments(chunkColumns.filter((column) => !["id", "document_id", "stable_chunk_id", "created_at"].includes(column)))}`));
    } else {
      const updates = rows.flatMap(({ item, scope, id, embedding }): SqlStatement[] => {
        const row = storedByStableId.get(item.stableChunkId)!;
        const scopeChanged = (row.curriculum_stage ?? null) !== scope.stage
          || (row.grade_start ?? null) !== scope.gradeStart
          || (row.grade_end ?? null) !== scope.gradeEnd
          || (row.curriculum_domain ?? null) !== scope.domain;
        if (row.embedding_json && !scopeChanged) return [];
        return [{
          sql: `UPDATE curriculum_standard_chunks SET embedding_json = COALESCE(embedding_json, ?), curriculum_stage = ?,
            grade_start = ?, grade_end = ?, curriculum_domain = ? WHERE id = ?`,
          params: [row.embedding_json ? null : embedding, scope.stage, scope.gradeStart, scope.gradeEnd, scope.domain, id],
        }];
      });
      if (updates.length) await db.batch(updates);
    }
    args.onProgress?.(Math.min(start + batch.length, chunks.length), chunks.length);
  }

  if (release.status === "draft") {
    const kept = new Set(chunks.map((item) => item.stableChunkId));
    const stale = stored.filter((row) => !kept.has(row.stable_chunk_id)).map((row) => row.id);
    for (const ids of chunk(stale, ID_LIST_SIZE)) {
      await db.query({
        sql: `DELETE FROM curriculum_standard_chunks WHERE id IN (${ids.map(() => "?").join(", ")})`,
        params: ids,
      });
    }
  }
  const verified = (await readStandardDocument(db, release.id, document.filename))!;
  if (verified.chunkCount !== chunks.length || verified.embeddedCount !== chunks.length) {
    throw new Error("curriculum_standard_index_incomplete");
  }
  await db.batch([
    { sql: "UPDATE curriculum_standard_documents SET index_version = ?, updated_at = ? WHERE id = ?", params: [indexVersion, now, documentId] },
    // The published fingerprint keys the search cache; refreshed embeddings must invalidate it.
    { sql: "UPDATE curriculum_standard_releases SET updated_at = ? WHERE id = ? AND status = 'published'", params: [now, release.id] },
  ]);
  return release.status === "draft" ? "indexed" : "backfilled";
}

export async function readCurriculumStandardReleaseStatus(db: SqlDatabase, releaseKey: string) {
  const release = (await db.query<{
    id: string; title: string; status: CurriculumStandardReleaseStatus; expected_document_count: number; published_at: string | null;
  }>({
    sql: "SELECT id, title, status, expected_document_count, published_at FROM curriculum_standard_releases WHERE release_key = ?",
    params: [releaseKey],
  })).rows[0];
  if (!release) return null;
  const documents = await db.query<{
    filename: string; title: string; subject: string | null; document_kind: string; index_version: string;
    chunk_count: number; embedded_count: number;
  }>({
    sql: `SELECT d.filename, d.title, d.subject, d.document_kind, d.index_version,
        (SELECT COUNT(*) FROM curriculum_standard_chunks c WHERE c.document_id = d.id) AS chunk_count,
        (SELECT COUNT(*) FROM curriculum_standard_chunks c WHERE c.document_id = d.id AND c.embedding_json IS NOT NULL) AS embedded_count
      FROM curriculum_standard_documents d WHERE d.release_id = ? ORDER BY d.title`,
    params: [release.id],
  });
  return {
    id: release.id,
    title: release.title,
    status: release.status,
    expectedDocumentCount: Number(release.expected_document_count),
    publishedAt: release.published_at,
    documents: documents.rows.map((row) => ({
      filename: row.filename,
      title: row.title,
      subject: row.subject,
      kind: row.document_kind,
      indexVersion: row.index_version,
      chunkCount: Number(row.chunk_count),
      embeddedCount: Number(row.embedded_count),
    })),
  };
}

/** Atomically (on real D1) makes a fully indexed draft the one published release of its series. */
export async function publishCurriculumStandardRelease(db: SqlDatabase, args: {
  releaseKey: string;
  expected: ReadonlyArray<{ filename: string; indexVersion: string; chunkCount: number }>;
  now?: string;
}) {
  const now = args.now ?? new Date().toISOString();
  const status = await readCurriculumStandardReleaseStatus(db, args.releaseKey);
  if (!status) throw new Error("curriculum_standard_release_not_found");
  if (status.status === "published") return "already_published" as const;
  if (status.status !== "draft") throw new Error("curriculum_standard_release_not_publishable");
  if (status.documents.length !== status.expectedDocumentCount) throw new Error("curriculum_standard_document_count_incomplete");
  const byFilename = new Map(status.documents.map((document) => [document.filename, document]));
  const ready = args.expected.length === status.expectedDocumentCount && args.expected.every((expected) => {
    const document = byFilename.get(expected.filename);
    return document
      && document.indexVersion === expected.indexVersion
      && document.chunkCount === expected.chunkCount
      && document.embeddedCount === expected.chunkCount;
  });
  if (!ready) throw new Error("curriculum_standard_index_incomplete");
  await db.batch([
    {
      sql: `UPDATE curriculum_standard_releases SET status = 'retired', updated_at = ?
        WHERE series_key = (SELECT series_key FROM curriculum_standard_releases WHERE id = ?) AND status = 'published' AND id <> ?`,
      params: [now, status.id, status.id],
    },
    {
      sql: "UPDATE curriculum_standard_releases SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?",
      params: [now, now, status.id],
    },
  ]);
  return "published" as const;
}
