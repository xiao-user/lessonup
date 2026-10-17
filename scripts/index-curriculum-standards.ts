/**
 * Indexes the normalized national curriculum standards into D1.
 *
 *   npm run curriculum:standards:validate
 *   npm run curriculum:standards:import [-- --only 数学] [--publish] [--remote]
 *   npm run curriculum:standards:status [-- --remote]
 *   npm run curriculum:standards:publish [-- --remote]
 *
 * Targets the local Wrangler D1 unless --remote is given. `import` on a
 * release that is already published only backfills missing embeddings and
 * derived scope columns; published passages are never rewritten.
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { deterministicUuid } from "../server/curriculum/knowledge-sample.js";
import { ConfiguredEmbeddingProvider } from "../server/providers/embeddings.js";
import { config, hasEmbeddingProvider } from "../server/config.js";
import {
  ensureCurriculumStandardRelease,
  indexCurriculumStandardDocument,
  publishCurriculumStandardRelease,
  readCurriculumStandardReleaseStatus,
  type CurriculumStandardReleaseStatus,
} from "../server/repositories/d1-curriculum-import.js";
import type { SqlDatabase } from "../server/platform/sql-database.js";
import { d1TargetFromArguments, describeD1Target, openD1 } from "./lib/wrangler-d1.js";

const chunkSchema = z.object({
  stableChunkId: z.string().min(1),
  passage: z.string().min(1),
  embeddingText: z.string().min(1),
  section: z.string(),
  headingPath: z.array(z.string()),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  blockRefs: z.array(z.object({ page: z.number().int().positive(), blockId: z.number().int() })),
  labels: z.array(z.string()),
  averageConfidence: z.number().optional(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const normalizedSchema = z.object({
  schemaVersion: z.literal(1),
  parser: z.object({ engine: z.literal("PaddleOCR-VL-1.6"), modelSettings: z.record(z.string(), z.unknown()) }),
  document: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["curriculum_standard", "curriculum_plan"]),
    subject: z.string().min(1).nullable(),
    sourceFilename: z.string().min(1),
    parsedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageCount: z.number().int().positive(),
  }),
  quality: z.object({
    pageCount: z.number().int().positive(),
    blockCount: z.number().int().nonnegative(),
    contentCharacters: z.number().int().nonnegative(),
    emptyContentPages: z.array(z.number().int().positive()),
    labelCounts: z.record(z.string(), z.number().int().nonnegative()),
    lowConfidenceBlocks: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
  chunks: z.array(chunkSchema).min(1),
});

type NormalizedDocument = z.infer<typeof normalizedSchema>;
type Action = "validate" | "import" | "status" | "publish";

const valueAfter = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const action = (process.argv[2] ?? "validate") as Action;
if (!["validate", "import", "status", "publish"].includes(action)) {
  throw new Error(`curriculum_standard_action_invalid:${action}`);
}
const sourceDir = path.resolve(valueAfter("--source") ?? "data/curriculum/standards/normalized");
const shouldPublish = process.argv.includes("--publish");
const only = valueAfter("--only")?.trim();
const batchSize = 16;
const normalizerVersion = "paddle-vl-1.6-normalizer-v1";

async function loadDocuments() {
  const filenames = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".chunks.json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (!filenames.length) throw new Error(`curriculum_standard_normalized_json_missing:${sourceDir}`);
  const documents: NormalizedDocument[] = [];
  for (const filename of filenames) {
    const parsed = normalizedSchema.parse(JSON.parse(await readFile(path.join(sourceDir, filename), "utf8")));
    if (parsed.document.kind === "curriculum_standard" && !parsed.document.subject) {
      throw new Error(`curriculum_standard_subject_missing:${filename}`);
    }
    if (parsed.chunks.some((chunk) => chunk.pageEnd < chunk.pageStart)) {
      throw new Error(`curriculum_standard_page_range_invalid:${filename}`);
    }
    documents.push(parsed);
  }
  const documentIds = new Set(documents.map((document) => document.document.id));
  const sourceNames = new Set(documents.map((document) => document.document.sourceFilename));
  if (documentIds.size !== documents.length || sourceNames.size !== documents.length) {
    throw new Error("curriculum_standard_normalized_document_duplicate");
  }
  return documents;
}

function releaseFor(documents: NormalizedDocument[]) {
  const releaseKey = valueAfter("--release-key") ?? "national-curriculum-standards-2022-v1";
  return {
    id: deterministicUuid("lessonup:curriculum-standard-release", releaseKey),
    seriesKey: "national-curriculum-standards",
    releaseKey,
    title: "国家课程方案和课程标准（2022年版）",
    versionLabel: "2022年版",
    authority: "中华人民共和国教育部",
    issuedYear: 2022,
    expectedDocumentCount: documents.length,
    parser: "PaddleOCR-VL-1.6",
    normalizerVersion,
  };
}

const gradeNames = ["", "一年级", "二年级", "三年级", "四年级", "五年级", "六年级", "七年级", "八年级", "九年级"];

function documentScope(document: NormalizedDocument) {
  if (document.document.kind === "curriculum_plan") {
    return { stageScope: ["小学", "初中"], gradeScope: gradeNames.slice(1) };
  }
  const headings = document.chunks.flatMap((chunk) => chunk.headingPath).join("\n");
  const stages = new Set<string>();
  if (/第[一二三]学段/.test(headings)) stages.add("小学");
  if (/第四学段/.test(headings)) stages.add("初中");
  if (!stages.size) { stages.add("小学"); stages.add("初中"); }
  const grades = new Set<number>();
  for (const match of headings.matchAll(/([1-9])\s*[～~—－\-至]\s*([1-9])年级/g)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    for (let grade = Math.min(start, end); grade <= Math.max(start, end); grade += 1) grades.add(grade);
  }
  for (const match of headings.matchAll(/(?<![～~—－\-至])([1-9])年级/g)) grades.add(Number(match[1]));
  return {
    stageScope: [...stages],
    gradeScope: [...grades].sort((left, right) => left - right).map((grade) => gradeNames[grade]!),
  };
}

async function embedWithRetry(provider: ConfiguredEmbeddingProvider, texts: string[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await provider.embed(texts);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

const indexVersionFor = (document: NormalizedDocument) => (
  `embedding:${config.EMBEDDING_MODEL}:${normalizerVersion}:${document.document.parsedSha256.slice(0, 16)}`
);

async function indexDocument(
  db: SqlDatabase,
  provider: ConfiguredEmbeddingProvider,
  releaseState: { id: string; status: CurriculumStandardReleaseStatus },
  normalized: NormalizedDocument,
  position: number,
  total: number,
) {
  const outcome = await indexCurriculumStandardDocument(db, {
    release: releaseState,
    document: {
      filename: normalized.document.sourceFilename,
      title: normalized.document.title,
      kind: normalized.document.kind,
      subject: normalized.document.subject,
      ...documentScope(normalized),
      parsedSha256: normalized.document.parsedSha256,
    },
    chunks: normalized.chunks,
    indexVersion: indexVersionFor(normalized),
    embed: (texts) => embedWithRetry(provider, texts),
    batchSize,
    onProgress: (done, count) => {
      process.stdout.write(`\r[${position}/${total}] ${normalized.document.title} ${done}/${count}`);
    },
  });
  if (outcome === "skipped") console.log(`[${position}/${total}] 已是最新索引 ${normalized.document.title}`);
  else console.log(outcome === "backfilled" ? "  已补全向量与学段范围" : "");
}

function documentState(
  stored: { indexVersion: string; chunkCount: number; embeddedCount: number } | undefined,
  normalized: NormalizedDocument,
) {
  if (!stored) return "missing";
  if (stored.indexVersion.startsWith("indexing:")) return "indexing";
  if (stored.chunkCount !== normalized.chunks.length) return "incomplete";
  if (stored.embeddedCount < stored.chunkCount) return "no_embeddings";
  if (config.EMBEDDING_MODEL && stored.indexVersion !== indexVersionFor(normalized)) return "stale";
  return "ready";
}

async function status(db: SqlDatabase, release: ReturnType<typeof releaseFor>, documents: NormalizedDocument[]) {
  const stored = await readCurriculumStandardReleaseStatus(db, release.releaseKey);
  if (!stored) throw new Error("curriculum_standard_release_not_imported");
  console.log(`${stored.title} · ${stored.status} · ${stored.documents.length}/${stored.expectedDocumentCount}`);
  const byFilename = new Map(stored.documents.map((document) => [document.filename, document]));
  for (const normalized of documents) {
    console.log(`${documentState(byFilename.get(normalized.document.sourceFilename), normalized)}\t${normalized.document.subject ?? "共用课程方案"}\t${normalized.document.title}`);
  }
}

async function publish(db: SqlDatabase, release: ReturnType<typeof releaseFor>, documents: NormalizedDocument[]) {
  if (!config.EMBEDDING_MODEL) throw new Error("embedding_not_configured");
  const result = await publishCurriculumStandardRelease(db, {
    releaseKey: release.releaseKey,
    expected: documents.map((document) => ({
      filename: document.document.sourceFilename,
      indexVersion: indexVersionFor(document),
      chunkCount: document.chunks.length,
    })),
  });
  console.log(result === "already_published" ? `已是发布状态：${release.title}` : `已发布：${release.title}`);
}

const allDocuments = await loadDocuments();
const release = releaseFor(allDocuments);
if (action === "validate") {
  const chunks = allDocuments.reduce((sum, document) => sum + document.chunks.length, 0);
  console.log(`校验通过：${allDocuments.length} 份文档，${chunks} 个切片，发布键 ${release.releaseKey}`);
} else {
  const target = d1TargetFromArguments(process.argv.slice(3));
  console.log(`目标：${describeD1Target(target)}`);
  const { db, close } = await openD1(target);
  try {
    if (action === "status") {
      await status(db, release, allDocuments);
    } else if (action === "publish") {
      await publish(db, release, allDocuments);
    } else {
      if (!hasEmbeddingProvider) throw new Error("embedding_not_configured");
      const selected = only
        ? allDocuments.filter((document) => document.document.subject === only || document.document.kind === only)
        : allDocuments;
      if (!selected.length) throw new Error(`curriculum_standard_only_not_found:${only}`);
      const { id, seriesKey, releaseKey, title, versionLabel, authority, issuedYear, expectedDocumentCount, ...metadata } = release;
      const releaseState = await ensureCurriculumStandardRelease(db, {
        id, seriesKey, releaseKey, title, versionLabel, authority, issuedYear, expectedDocumentCount, metadata,
      });
      const provider = new ConfiguredEmbeddingProvider();
      for (const [index, document] of selected.entries()) {
        await indexDocument(db, provider, releaseState, document, index + 1, selected.length);
      }
      if (releaseState.status !== "draft") console.log(`发布 ${releaseKey} 已是 ${releaseState.status}：只补全了向量与学段范围。`);
      else if (shouldPublish) await publish(db, release, allDocuments);
      else console.log("索引已写入草稿版本；全部文档就绪后运行 curriculum:standards:publish 发布。");
    }
  } finally {
    await close();
  }
}
