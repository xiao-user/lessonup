import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../domain.js";
import type { CurriculumStandardChunk } from "../curriculum/standard-chunker.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { D1CurriculumCatalogRepository } from "./d1-curriculum-catalog-repository.js";
import { D1CurriculumKnowledgeReadRepository } from "./d1-curriculum-knowledge-repository.js";
import { D1CurriculumStandardReadRepository } from "./d1-curriculum-standard-repository.js";
import {
  curriculumStandardChunkScope,
  ensureCurriculumStandardRelease,
  importCurriculumCatalog,
  importCurriculumKnowledgeRelease,
  indexCurriculumStandardDocument,
  publishCurriculumStandardRelease,
  readCurriculumStandardReleaseStatus,
  type CurriculumKnowledgeImportPayload,
  type CurriculumStandardDocumentInput,
  type CurriculumStandardReleaseInput,
} from "./d1-curriculum-import.js";

/** The real D1 migrations on an in-memory SQLite, with foreign keys enforced like D1. */
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../../d1/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  const execute = (statement: SqlStatement) => {
    const prepared = db.prepare(statement.sql);
    const params = (statement.params ?? []) as Array<string | number | null>;
    if (prepared.columns().length) return { rows: prepared.all(...params) as Record<string, unknown>[], rowsAffected: 0 };
    return { rows: [], rowsAffected: Number(prepared.run(...params).changes) };
  };
  const hooks: Array<(statements: SqlStatement[]) => void> = [];
  const port = {
    query: async (statement: SqlStatement) => execute(statement),
    batch: async (statements: SqlStatement[]) => {
      for (const hook of hooks) hook(statements);
      db.exec("BEGIN");
      try {
        const results = statements.map(execute);
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SqlDatabase;
  return { db, port, beforeBatch: (hook: (statements: SqlStatement[]) => void) => hooks.push(hook) };
}

const now = "2026-09-29T00:00:00.000Z";

const book = (id: string, title: string, nodeCount: number): CurriculumTextbookRecord => ({
  id, title, stage: "初中", subject: "语文", edition: "统编版", grade: "七年级", volume: "上册", publisherId: "pub",
  ebookId: null, detailUrl: null, treeUrl: null, sourcePdfUrl: null, sourceListUrl: null, nodeCount, sourceUpdatedAt: null,
});
const node = (
  textbookId: string, nodeId: string, parentId: string | null, level: number, sortNo: number, title: string,
): CurriculumNodeRecord => ({ textbookId, nodeId, parentId, level, sortNo, title, pageNumber: null });

const generationA = {
  generationId: "gen-a",
  manifest: { textbooks: 2, nodes: 4 },
  textbooks: [book("b1", "七年级上册语文", 3), book("b2", "七年级上册数学", 1)],
  nodes: [
    node("b1", "u1", null, 1, 0, "第一单元"), node("b1", "c1", "u1", 2, 0, "春"), node("b1", "c2", "u1", 2, 1, "济南的冬天"),
    node("b2", "m1", null, 1, 0, "有理数"),
  ],
};

describe("importCurriculumCatalog", () => {
  it("loads a snapshot, makes it current and is a no-op when repeated", async () => {
    const { port } = database();
    const repository = new D1CurriculumCatalogRepository(port);
    await expect(importCurriculumCatalog(port, generationA, { now })).resolves.toMatchObject({ status: "published", textbooks: 2, nodes: 4 });
    const release = await repository.getCurrentCurriculumCatalogRelease();
    expect(release).toMatchObject({ generationId: "gen-a", status: "published", snapshotComplete: true, textbookCount: 2, nodeCount: 4 });
    expect((await repository.searchCurriculumTextbooks({})).map((item) => item.id).sort()).toEqual(["b1", "b2"]);
    expect(await repository.listCurriculumNodes({ textbookId: "b1", maxLevel: 3 })).toHaveLength(3);
    await expect(importCurriculumCatalog(port, generationA, { now })).resolves.toMatchObject({ status: "already_current" });
    expect((await port.query({ sql: "SELECT COUNT(*) AS n FROM curriculum_nodes" })).rows[0]).toEqual({ n: 4 });
  });

  it("switches generations, retiring the previous release and moving shared textbooks with it", async () => {
    const { port } = database();
    const repository = new D1CurriculumCatalogRepository(port);
    await importCurriculumCatalog(port, generationA, { now });
    await importCurriculumCatalog(port, {
      generationId: "gen-b",
      manifest: { textbooks: 2, nodes: 4 },
      textbooks: [book("b1", "七年级上册语文（修订）", 2), book("b3", "八年级上册语文", 2)],
      nodes: [
        node("b1", "u1", null, 1, 0, "第一单元"), node("b1", "c1", "u1", 2, 0, "春"),
        node("b3", "x1", null, 1, 0, "第一单元"), node("b3", "x2", "x1", 2, 0, "藤野先生"),
      ],
    }, { now: "2026-09-30T00:00:00.000Z" });
    expect(await repository.getCurrentCurriculumCatalogRelease()).toMatchObject({ generationId: "gen-b" });
    expect((await repository.searchCurriculumTextbooks({})).map((item) => item.title).sort())
      .toEqual(["七年级上册语文（修订）", "八年级上册语文"].sort());
    expect((await port.query({ sql: "SELECT status FROM curriculum_catalog_releases WHERE generation_id = 'gen-a'" })).rows[0])
      .toEqual({ status: "retired" });
  });

  it("refuses a remote replacement or a catalog referenced by a semester framework before staging", async () => {
    const { db, port } = database();
    await importCurriculumCatalog(port, generationA, { now });
    const replacement = { ...generationA, generationId: "gen-b" };
    await expect(importCurriculumCatalog(port, replacement, { now, allowCatalogReplacement: false }))
      .rejects.toThrow("curriculum_catalog_remote_replacement_requires_migration");

    const current = db.prepare("SELECT catalog_release_id FROM curriculum_catalog_current").get() as { catalog_release_id: string };
    db.prepare("INSERT INTO users (id, login_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("user-1", "teacher", "hash", now, now);
    db.prepare(`INSERT INTO notebooks
      (id, owner_id, title, class_name, year, subject, tone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("notebook-1", "user-1", "课程", "一班", "2026", "语文", "teal", now, now);
    db.prepare(`INSERT INTO semester_frameworks
      (id, owner_id, notebook_id, textbook_id, catalog_release_id, title, term, total_weeks, weekly_periods,
       create_idempotency_key, create_request_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "framework-1", "user-1", "notebook-1", "b1", current.catalog_release_id, "学期框架", "上学期", 18, 4,
      "request-1", "hash-1", now, now,
    );
    await expect(importCurriculumCatalog(port, replacement, { now }))
      .rejects.toThrow("curriculum_catalog_release_in_use");
    expect((await port.query({ sql: "SELECT COUNT(*) AS n FROM curriculum_catalog_releases" })).rows[0]).toEqual({ n: 1 });
  });

  it("keeps the current catalog untouched until the final publish batch commits", async () => {
    const { port, beforeBatch } = database();
    const repository = new D1CurriculumCatalogRepository(port);
    await importCurriculumCatalog(port, generationA, { now });
    beforeBatch((statements) => {
      if (statements.some((statement) => statement.sql.includes("curriculum_catalog_current"))) throw new Error("publish_interrupted");
    });
    await expect(importCurriculumCatalog(port, {
      generationId: "gen-b",
      manifest: {},
      textbooks: [book("b1", "改名", 3), book("b2", "七年级上册数学", 1)],
      nodes: generationA.nodes,
    }, { now })).rejects.toThrow("publish_interrupted");
    expect(await repository.getCurrentCurriculumCatalogRelease()).toMatchObject({ generationId: "gen-a" });
    expect(await repository.searchCurriculumTextbooks({})).toHaveLength(2);
    expect(await repository.listCurriculumNodes({ textbookId: "b1", maxLevel: 3 })).toHaveLength(3);
  });

  it("rejects inconsistent input before writing anything", async () => {
    const { port } = database();
    const orphan = { ...generationA, nodes: [...generationA.nodes.slice(0, 3), node("b2", "m1", "missing", 2, 0, "孤儿")] };
    await expect(importCurriculumCatalog(port, orphan, { now })).rejects.toThrow("curriculum_catalog_orphan_node");
    await expect(importCurriculumCatalog(port, { ...generationA, textbooks: [book("b1", "x", 9), generationA.textbooks[1]!] }, { now }))
      .rejects.toThrow("curriculum_catalog_book_count_mismatch");
    await expect(importCurriculumCatalog(port, { ...generationA, nodes: [...generationA.nodes, generationA.nodes[0]!] }, { now }))
      .rejects.toThrow("curriculum_catalog_duplicate_node");
    expect((await port.query({ sql: "SELECT COUNT(*) AS n FROM curriculum_catalog_releases" })).rows[0]).toEqual({ n: 0 });
  });
});

/** Entity ids are shared across releases; source, mapping and period ids belong to one release. */
function knowledgePayload(overrides: Partial<CurriculumKnowledgeImportPayload["release"]> = {}, suffix = ""): CurriculumKnowledgeImportPayload {
  return {
    release: {
      id: "kr-1", scopeKey: "textbook:b1:knowledge-network", catalogGenerationId: "gen-a", subject: "语文", stage: "初中",
      edition: "统编版", grade: "七年级", volume: "上册", sourceManifest: { importedAs: "test" }, ...overrides,
    },
    entities: [
      {
        id: "e1", externalId: "kp-1", canonicalKey: "b1:kp-1", name: "比喻", definition: "用相似事物打比方",
        payload: { evidenceLevel: "A" }, embedding: [0.1234567891, -0.5, 0.25], embeddingModel: "test-model",
        source: { id: `s1${suffix}`, refId: "ref-1", title: "教材", url: null, authority: "人教社", locator: "第3页" },
      },
      {
        id: "e2", externalId: "kp-2", canonicalKey: "b1:kp-2", name: "拟人", definition: "把物当作人来写",
        payload: {}, source: { id: `s2${suffix}`, refId: "ref-2", title: "教材", authority: "人教社" },
      },
    ],
    occurrences: [
      { id: `o1${suffix}`, entityId: "e1", sourceId: `s1${suffix}`, textbookId: "b1", nodeId: "c1", sequenceNo: 1, priority: 1, printedPages: "3", recommendedPeriod: 2, payload: {} },
      { id: `o2${suffix}`, entityId: "e2", sourceId: `s2${suffix}`, textbookId: "b1", nodeId: "c1", sequenceNo: 1, priority: 2, printedPages: "4", recommendedPeriod: null, payload: {} },
    ],
    periodRecommendations: [{
      id: `p1${suffix}`, textbookId: "b1", nodeId: "c1", periodNo: 1, sequenceNo: 1, title: "第1课时", mappingType: "single",
      isOfficial: true, note: "", points: [{ entityId: "e1", sortNo: 1 }, { entityId: "e2", sortNo: 2 }],
    }],
  };
}

describe("importCurriculumKnowledgeRelease", () => {
  async function withCatalog() {
    const context = database();
    await importCurriculumCatalog(context.port, generationA, { now });
    return context;
  }

  it("publishes a release that the read repository serves, replacing an older one of the same scope", async () => {
    const { port } = await withCatalog();
    const reader = new D1CurriculumKnowledgeReadRepository(port);
    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload(), { publish: true, now }))
      .resolves.toMatchObject({ status: "published", entities: 2, occurrences: 2, periodRecommendations: 1 });
    const result = await reader.readCurriculumNodeKnowledgePoints({ textbookId: "b1", nodeId: "c1" });
    expect(result.release).toMatchObject({ id: "kr-1" });
    expect(result.points.map((item) => item.point.canonicalName)).toEqual(["比喻", "拟人"]);
    expect(result.periodRecommendations).toHaveLength(1);
    expect((await port.query({ sql: "SELECT embedding_json FROM curriculum_semantic_entity_revisions WHERE external_id = 'kp-1'" })).rows[0])
      .toEqual({ embedding_json: "[0.1234568,-0.5,0.25]" });

    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload(), { publish: true, now })).resolves.toMatchObject({ status: "already_published" });
    await importCurriculumKnowledgeRelease(port, knowledgePayload({ id: "kr-2" }, "-2"), { publish: true, now: "2026-09-30T00:00:00.000Z" });
    expect((await port.query({ sql: "SELECT id, status FROM curriculum_semantic_releases ORDER BY id" })).rows)
      .toEqual([{ id: "kr-1", status: "retired" }, { id: "kr-2", status: "published" }]);
  });

  it("keeps a draft invisible and lets it be re-imported", async () => {
    const { port } = await withCatalog();
    const reader = new D1CurriculumKnowledgeReadRepository(port);
    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload(), { publish: false, now })).resolves.toMatchObject({ status: "draft" });
    expect((await reader.readCurriculumNodeKnowledgePoints({ textbookId: "b1", nodeId: "c1" })).points).toEqual([]);
    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload(), { publish: false, now })).resolves.toMatchObject({ status: "draft" });
    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload(), { publish: true, now })).resolves.toMatchObject({ status: "published" });
    expect((await reader.readCurriculumNodeKnowledgePoints({ textbookId: "b1", nodeId: "c1" })).points).toHaveLength(2);
  });

  it("refuses a payload for another catalog generation or for nodes missing from the catalog", async () => {
    const { port } = await withCatalog();
    await expect(importCurriculumKnowledgeRelease(port, knowledgePayload({ catalogGenerationId: "gen-old" }), { publish: true, now }))
      .rejects.toThrow("curriculum_semantic_catalog_generation_mismatch");
    const missingNode = knowledgePayload();
    missingNode.occurrences[0]!.nodeId = "nope";
    await expect(importCurriculumKnowledgeRelease(port, missingNode, { publish: true, now }))
      .rejects.toThrow("curriculum_node_semantic_unpublishable");
    expect((await port.query({ sql: "SELECT status FROM curriculum_semantic_releases" })).rows).toEqual([{ status: "draft" }]);
    await expect(importCurriculumKnowledgeRelease(port, { ...knowledgePayload(), entities: [] }, { publish: true, now }))
      .rejects.toThrow("curriculum_semantic_release_empty");
  });
});

describe("curriculumStandardChunkScope", () => {
  it("derives school stage, domain and grade range from the heading path", () => {
    expect(curriculumStandardChunkScope("义务教育 语文 课程标准（2022年版） > 第四学段（7～9年级） > 【阅读与鉴赏】"))
      .toEqual({ stage: "初中", domain: "阅读与鉴赏", gradeStart: 7, gradeEnd: 9 });
    expect(curriculumStandardChunkScope("第二学段（3～4年级） > 表达与交流")).toMatchObject({ stage: "小学", gradeStart: 3, gradeEnd: 4 });
    expect(curriculumStandardChunkScope("第五学段 > 选修")).toMatchObject({ stage: null });
    expect(curriculumStandardChunkScope("四、课程内容 > 1-2 年级")).toMatchObject({ gradeStart: 1, gradeEnd: 2, stage: null });
    expect(curriculumStandardChunkScope("三、课程目标")).toEqual({ stage: null, domain: null, gradeStart: null, gradeEnd: null });
    expect(curriculumStandardChunkScope("9～7年级")).toMatchObject({ gradeStart: null, gradeEnd: null });
  });
});

const release: CurriculumStandardReleaseInput = {
  id: "sr-1", seriesKey: "national", releaseKey: "national-v1", title: "国家课程标准", versionLabel: "2022年版",
  authority: "教育部", issuedYear: 2022, expectedDocumentCount: 2, metadata: { normalizerVersion: "test" },
};
const chineseDocument: CurriculumStandardDocumentInput = {
  filename: "语文.pdf", title: "义务教育语文课程标准", kind: "curriculum_standard", subject: "语文",
  stageScope: ["初中"], gradeScope: ["七年级"], parsedSha256: "a".repeat(64),
};
const planDocument: CurriculumStandardDocumentInput = {
  filename: "方案.pdf", title: "义务教育课程方案", kind: "curriculum_plan", subject: null,
  stageScope: ["小学", "初中"], gradeScope: ["七年级"], parsedSha256: "b".repeat(64),
};
const chunk = (id: string, section: string, passage: string): CurriculumStandardChunk => ({
  stableChunkId: id, ordinal: 0, passage, embeddingText: `${section}\n${passage}`, section, headingPath: section.split(" > "),
  pageStart: 3, pageEnd: 4, blockRefs: [{ page: 3, blockId: 1 }], labels: ["text"], contentSha256: "c".repeat(64),
});
const chineseChunks = [
  chunk("c1", "语文课程标准 > 第四学段（7～9年级） > 【阅读与鉴赏】", "阅读中理解比喻、拟人等修辞手法的表达效果"),
  chunk("c2", "语文课程标准 > 三、课程目标 > 核心素养内涵", "文化自信、语言运用、思维能力、审美创造"),
  chunk("c3", "语文课程标准 > 附录 > 学业要求", "能够复述故事梗概"),
];
const planChunks = [chunk("p1", "课程方案 > 三、课程设置", "国家课程、地方课程和校本课程")];
/** Deterministic 4-d vectors; the calls array shows what was actually sent to the provider. */
const embedder = () => {
  const calls: string[][] = [];
  const embed = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((text) => [text.length % 7, text.length % 5, text.length % 3, 1]);
  };
  return { calls, embed };
};

describe("curriculum standards import", () => {
  const indexVersion = "embedding:test:v1";

  async function indexAll(port: SqlDatabase, embed: ReturnType<typeof embedder>["embed"]) {
    const stored = await ensureCurriculumStandardRelease(port, release, now);
    await indexCurriculumStandardDocument(port, { release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed, now });
    await indexCurriculumStandardDocument(port, { release: stored, document: planDocument, chunks: planChunks, indexVersion, embed, now });
    return stored;
  }
  const expected = [
    { filename: chineseDocument.filename, indexVersion, chunkCount: chineseChunks.length },
    { filename: planDocument.filename, indexVersion, chunkCount: planChunks.length },
  ];

  it("indexes documents, publishes the release and serves it through the read repository", async () => {
    const { port } = database();
    const { embed } = embedder();
    await indexAll(port, embed);
    expect(await readCurriculumStandardReleaseStatus(port, release.releaseKey)).toMatchObject({
      status: "draft",
      documents: [
        { filename: "语文.pdf", indexVersion, chunkCount: 3, embeddedCount: 3 },
        { filename: "方案.pdf", indexVersion, chunkCount: 1, embeddedCount: 1 },
      ],
    });
    await expect(publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now })).resolves.toBe("published");
    await expect(publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now })).resolves.toBe("already_published");
    const results = await new D1CurriculumStandardReadRepository(port).searchCurriculumStandards({
      query: "比喻 拟人 修辞", subject: "语文", stage: "初中", grade: "七年级", limit: 4,
    });
    expect(results[0]).toMatchObject({ chunkId: "c1", title: "义务教育语文课程标准", kind: "public" });
    const row = (await port.query({ sql: "SELECT curriculum_stage, grade_start, grade_end, curriculum_domain FROM curriculum_standard_chunks WHERE stable_chunk_id = 'c1'" })).rows[0];
    expect(row).toEqual({ curriculum_stage: "初中", grade_start: 7, grade_end: 9, curriculum_domain: "阅读与鉴赏" });
  });

  it("refuses to publish until every expected document is fully indexed", async () => {
    const { port } = database();
    const { embed } = embedder();
    const stored = await ensureCurriculumStandardRelease(port, release, now);
    await indexCurriculumStandardDocument(port, { release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed, now });
    await expect(publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now }))
      .rejects.toThrow("curriculum_standard_document_count_incomplete");
    await indexCurriculumStandardDocument(port, { release: stored, document: planDocument, chunks: planChunks, indexVersion, embed, now });
    await port.query({ sql: "UPDATE curriculum_standard_chunks SET embedding_json = NULL WHERE stable_chunk_id = 'p1'" });
    await expect(publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now }))
      .rejects.toThrow("curriculum_standard_index_incomplete");
    await expect(publishCurriculumStandardRelease(port, { releaseKey: "missing", expected, now }))
      .rejects.toThrow("curriculum_standard_release_not_found");
  });

  it("skips finished documents and resumes an interrupted one without re-embedding stored chunks", async () => {
    const { port } = database();
    const first = embedder();
    const stored = await ensureCurriculumStandardRelease(port, release, now);
    let calls = 0;
    const flaky = async (texts: string[]) => {
      calls += 1;
      if (calls === 2) throw new Error("provider_down");
      return first.embed(texts);
    };
    await expect(indexCurriculumStandardDocument(port, {
      release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed: flaky, now, batchSize: 2,
    })).rejects.toThrow("provider_down");
    expect((await readCurriculumStandardReleaseStatus(port, release.releaseKey))!.documents[0])
      .toMatchObject({ indexVersion: `indexing:${indexVersion}`, chunkCount: 2, embeddedCount: 2 });

    const resumed = embedder();
    await expect(indexCurriculumStandardDocument(port, {
      release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed: resumed.embed, now, batchSize: 2,
    })).resolves.toBe("indexed");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0]).toHaveLength(1);
    await expect(indexCurriculumStandardDocument(port, {
      release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed: resumed.embed, now,
    })).resolves.toBe("skipped");
    expect(resumed.calls).toHaveLength(1);
  });

  it("removes chunks that disappeared from a re-normalized draft document", async () => {
    const { port } = database();
    const { embed } = embedder();
    const stored = await ensureCurriculumStandardRelease(port, release, now);
    await indexCurriculumStandardDocument(port, { release: stored, document: chineseDocument, chunks: chineseChunks, indexVersion, embed, now });
    await indexCurriculumStandardDocument(port, {
      release: stored, document: { ...chineseDocument, parsedSha256: "d".repeat(64) }, chunks: chineseChunks.slice(0, 2), indexVersion, embed, now,
    });
    expect((await readCurriculumStandardReleaseStatus(port, release.releaseKey))!.documents[0])
      .toMatchObject({ chunkCount: 2, embeddedCount: 2 });
  });

  it("backfills missing embeddings and scope on a published release without touching passages", async () => {
    const { port } = database();
    await indexAll(port, embedder().embed);
    await publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now });
    // The state left by the Supabase migration: passages present, vectors and grade scope dropped.
    await port.query({ sql: "UPDATE curriculum_standard_chunks SET embedding_json = NULL, grade_start = NULL, grade_end = NULL" });
    const before = (await port.query({ sql: "SELECT updated_at FROM curriculum_standard_releases WHERE id = 'sr-1'" })).rows[0]!.updated_at;

    const backfill = embedder();
    const published = { id: release.id, status: "published" as const };
    const later = "2026-10-01T00:00:00.000Z";
    await expect(indexCurriculumStandardDocument(port, {
      release: published, document: chineseDocument, chunks: chineseChunks, indexVersion, embed: backfill.embed, now: later,
    })).resolves.toBe("backfilled");
    expect(backfill.calls.flat()).toHaveLength(3);
    expect((await readCurriculumStandardReleaseStatus(port, release.releaseKey))!.documents.find((item) => item.filename === "语文.pdf"))
      .toMatchObject({ chunkCount: 3, embeddedCount: 3 });
    expect((await port.query({ sql: "SELECT grade_start, grade_end FROM curriculum_standard_chunks WHERE stable_chunk_id = 'c1'" })).rows[0])
      .toEqual({ grade_start: 7, grade_end: 9 });
    expect((await port.query({ sql: "SELECT updated_at FROM curriculum_standard_releases WHERE id = 'sr-1'" })).rows[0]!.updated_at)
      .not.toBe(before);
    await expect(indexCurriculumStandardDocument(port, {
      release: published, document: chineseDocument, chunks: chineseChunks, indexVersion, embed: backfill.embed, now: later,
    })).resolves.toBe("skipped");
  });

  it("keeps a published release immutable", async () => {
    const { port } = database();
    const { embed } = embedder();
    await indexAll(port, embed);
    await publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now });
    const published = { id: release.id, status: "published" as const };
    const changed = [{ ...chineseChunks[0]!, passage: "被改写的正文" }, ...chineseChunks.slice(1)];
    await expect(indexCurriculumStandardDocument(port, { release: published, document: chineseDocument, chunks: changed, indexVersion: "embedding:test:v2", embed, now }))
      .rejects.toThrow("curriculum_standard_published_content_changed");
    await expect(indexCurriculumStandardDocument(port, { release: published, document: { ...chineseDocument, parsedSha256: "e".repeat(64) }, chunks: chineseChunks, indexVersion, embed, now }))
      .rejects.toThrow("curriculum_standard_published_filename_changed");
    await expect(indexCurriculumStandardDocument(port, { release: published, document: { ...chineseDocument, filename: "新文件.pdf" }, chunks: chineseChunks, indexVersion, embed, now }))
      .rejects.toThrow("curriculum_standard_release_immutable");
    await expect(ensureCurriculumStandardRelease(port, { ...release, id: "other-id" }, now))
      .rejects.toThrow("curriculum_standard_release_identity_conflict");
  });

  it("retires the previous published release of the same series when a new one is published", async () => {
    const { port } = database();
    const { embed } = embedder();
    await indexAll(port, embed);
    await publishCurriculumStandardRelease(port, { releaseKey: release.releaseKey, expected, now });
    const next = await ensureCurriculumStandardRelease(port, { ...release, id: "sr-2", releaseKey: "national-v2" }, now);
    await indexCurriculumStandardDocument(port, { release: next, document: chineseDocument, chunks: chineseChunks, indexVersion, embed, now });
    await indexCurriculumStandardDocument(port, { release: next, document: planDocument, chunks: planChunks, indexVersion, embed, now });
    await publishCurriculumStandardRelease(port, { releaseKey: "national-v2", expected, now: "2026-10-02T00:00:00.000Z" });
    expect((await port.query({ sql: "SELECT release_key, status FROM curriculum_standard_releases ORDER BY release_key" })).rows)
      .toEqual([{ release_key: "national-v1", status: "retired" }, { release_key: "national-v2", status: "published" }]);
  });
});

describe("statement sizing", () => {
  it("keeps every generated statement inside D1's bound-parameter and size limits", async () => {
    const { port } = database();
    const seen: SqlStatement[] = [];
    const spy = { ...port, batch: vi.fn(async (statements: SqlStatement[]) => { seen.push(...statements); return port.batch(statements); }) } as unknown as SqlDatabase;
    const textbooks = Array.from({ length: 30 }, (_, index) => book(`book-${index}`, `教材${index}`, 12));
    const nodes = textbooks.flatMap((item) => Array.from({ length: 12 }, (_, index) => node(item.id, `n${index}`, index ? "n0" : null, index ? 2 : 1, index, `章节${index}`)));
    await importCurriculumCatalog(spy, { generationId: "big", manifest: {}, textbooks, nodes }, { now });
    expect(seen.length).toBeGreaterThan(20);
    for (const statement of seen) {
      expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
      expect(statement.sql.length + (statement.params ?? []).reduce<number>((total, value) => total + String(value).length, 0)).toBeLessThan(100_000);
    }
  });
});
