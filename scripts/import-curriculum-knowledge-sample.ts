/**
 * Validates a knowledge-point sample against the textbook catalog and loads it into D1 as a
 * semantic release. Without --apply-draft or --publish it only prints a dry-run report.
 *
 *   npm run curriculum:knowledge:import -- --source <file> [--apply-draft | --publish] [--embed] [--remote]
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../server/domain.js";
import {
  deterministicUuid,
  splitKnowledgePointIds,
  validateCurriculumKnowledgeSample,
} from "../server/curriculum/knowledge-sample.js";
import { importCurriculumKnowledgeRelease } from "../server/repositories/d1-curriculum-import.js";
import { d1TargetFromArguments, describeD1Target, openD1 } from "./lib/wrangler-d1.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data", "curriculum");
const defaultTextbookId = "8b9c7052-add4-4744-ab04-69d6c180d5d9";
const args = process.argv.slice(2);

function option(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const sourcePath = option("--source");
const textbookId = option("--textbook-id") ?? defaultTextbookId;
const publish = args.includes("--publish");
const applyDraft = args.includes("--apply-draft");
const embed = args.includes("--embed");
if (!sourcePath) throw new Error("curriculum_knowledge_source_required");
if (publish && applyDraft) throw new Error("curriculum_knowledge_import_mode_conflict");

async function readJsonlGz<T>(filePath: string): Promise<T[]> {
  await access(filePath);
  const stream = createReadStream(filePath).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const rows: T[] = [];
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as T);
  }
  return rows;
}

async function sha256File(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function createEmbeddings(texts: string[]) {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!baseUrl || !model) throw new Error("embedding_not_configured");
  const result: number[][] = [];
  for (let index = 0; index < texts.length; index += 32) {
    const input = texts.slice(index, index + 32);
    const response = await fetch(new URL("embeddings", `${baseUrl.replace(/\/?$/, "/")}`), {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "content-type": "application/json",
        ...(process.env.EMBEDDING_API_KEY
          ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ model, input }),
    });
    if (!response.ok) throw new Error(`embedding_failed:${response.status}`);
    const body = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
    const batch = body.data.sort((left, right) => left.index - right.index).map((item) => item.embedding);
    if (batch.length !== input.length || batch.some((vector) => vector.length !== 1024)) {
      throw new Error("embedding_shape_invalid");
    }
    result.push(...batch);
    process.stdout.write(`\rembeddings: ${Math.min(index + input.length, texts.length)}/${texts.length}`);
  }
  if (texts.length) process.stdout.write("\n");
  return { model, vectors: result };
}

const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8")) as {
  schema_version: number;
  files: { textbooks: { path: string; sha256: string }; nodes: { path: string; sha256: string } };
};
if (manifest.schema_version !== 2) throw new Error("curriculum_manifest_schema_unsupported");
const booksPath = path.join(dataDir, manifest.files.textbooks.path);
const nodesPath = path.join(dataDir, manifest.files.nodes.path);
const [booksHash, nodesHash] = await Promise.all([sha256File(booksPath), sha256File(nodesPath)]);
if (booksHash !== manifest.files.textbooks.sha256 || nodesHash !== manifest.files.nodes.sha256) {
  throw new Error("curriculum_manifest_hash_mismatch");
}
const catalogGenerationId = createHash("sha256").update(`${booksHash}:${nodesHash}`).digest("hex");
const [rawTextbooks, rawNodes, rawSample, sourceHash] = await Promise.all([
  readJsonlGz<Record<string, unknown>>(booksPath),
  readJsonlGz<Record<string, unknown>>(nodesPath),
  readFile(path.resolve(sourcePath), "utf8").then((value) => JSON.parse(value) as unknown),
  sha256File(path.resolve(sourcePath)),
]);
const textbookRow = rawTextbooks.find((row) => row.id === textbookId);
if (!textbookRow) throw new Error("curriculum_textbook_not_found");
const textbook: CurriculumTextbookRecord = {
  id: String(textbookRow.id),
  title: String(textbookRow.title),
  stage: String(textbookRow.stage),
  subject: String(textbookRow.subject),
  edition: String(textbookRow.edition),
  grade: String(textbookRow.grade),
  volume: String(textbookRow.volume ?? ""),
  publisherId: String(textbookRow.publisher_id ?? ""),
  ebookId: textbookRow.ebook_id == null ? null : String(textbookRow.ebook_id),
  detailUrl: textbookRow.detail_url == null ? null : String(textbookRow.detail_url),
  treeUrl: textbookRow.tree_url == null ? null : String(textbookRow.tree_url),
  sourcePdfUrl: textbookRow.source_pdf_url == null ? null : String(textbookRow.source_pdf_url),
  sourceListUrl: textbookRow.source_list_url == null ? null : String(textbookRow.source_list_url),
  nodeCount: Number(textbookRow.node_count ?? 0),
  sourceUpdatedAt: textbookRow.source_updated_at == null ? null : String(textbookRow.source_updated_at),
};
const nodes: CurriculumNodeRecord[] = rawNodes
  .filter((row) => row.textbook_id === textbookId)
  .map((row) => ({
    textbookId: String(row.textbook_id),
    nodeId: String(row.node_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    level: Number(row.level),
    sortNo: Number(row.sort_no),
    title: String(row.title),
    pageNumber: row.page_number == null ? null : Number(row.page_number),
  }));
const validation = validateCurriculumKnowledgeSample({ value: rawSample, textbook, nodes });
const sample = validation.sample;
if (publish && sample.knowledge_points.some((point) => point["核验状态"] !== "已核验")) {
  throw new Error("curriculum_knowledge_publish_requires_verified_points");
}
const namespace = `lessonup:curriculum-knowledge:${textbookId}`;
const releaseId = deterministicUuid(namespace, `${catalogGenerationId}:${sourceHash}`);
const scopeKey = `textbook:${textbookId}:knowledge-network`;
const moduleByKey = new Map(validation.matchedModules.map((matched) => [[
  matched.module.unit, matched.module.module, matched.module.no, matched.module.title,
].join("\u0000"), matched]));
const pointModule = new Map(sample.knowledge_points.map((point) => {
  const key = [point["单元"], point["板块"], point["课号"], point["课文/活动"]].join("\u0000");
  const matched = moduleByKey.get(key);
  if (!matched) throw new Error(`curriculum_knowledge_point_module_missing:${point["知识点ID"]}`);
  return [point["知识点ID"], matched] as const;
}));

const embeddingInput = sample.knowledge_points.map((point) => (
  `${point["标准知识点名称"]}\n${point["具体掌握内容"]}`
));
const embedded = embed ? await createEmbeddings(embeddingInput) : null;
const entityIdByExternalId = new Map<string, string>();
const sourceIdByExternalId = new Map<string, string>();
const entityIdFor = (externalId: string) => {
  const entityId = entityIdByExternalId.get(externalId);
  if (!entityId) throw new Error(`curriculum_knowledge_point_unknown:${externalId}`);
  return entityId;
};
const entities = sample.knowledge_points.map((point, index) => {
  const externalId = point["知识点ID"];
  const entityId = deterministicUuid(namespace, `entity:${externalId}`);
  const sourceId = deterministicUuid(releaseId, `source:${externalId}`);
  entityIdByExternalId.set(externalId, entityId);
  sourceIdByExternalId.set(externalId, sourceId);
  return {
    id: entityId,
    externalId,
    canonicalKey: `${textbookId}:${externalId}`,
    name: point["标准知识点名称"],
    definition: point["具体掌握内容"],
    payload: {
      evidenceAnchor: point["教材证据定位"],
      evidenceLevel: point["证据等级"],
      verificationStatus: point["核验状态"],
      officialPeriod: point["官方课时"] === "是",
      note: point["备注"] || undefined,
    },
    embedding: embedded?.vectors[index],
    embeddingModel: embedded?.model,
    source: {
      id: sourceId,
      refId: `curriculum-knowledge:${textbookId}:${externalId}`,
      title: `${textbook.title}：${point["标准知识点名称"]}`,
      url: textbook.sourcePdfUrl ?? sample.book.official_ebook_entry,
      authority: sample.book.publisher,
      locator: `教材印刷页 ${point["教材页码"]}；${point["教材证据定位"]}`,
    },
  };
});

const occurrencePriority = new Map<string, number>();
const occurrences = sample.knowledge_points.map((point) => {
  const matched = pointModule.get(point["知识点ID"])!;
  const priority = (occurrencePriority.get(matched.node.nodeId) ?? 0) + 1;
  occurrencePriority.set(matched.node.nodeId, priority);
  return {
    id: deterministicUuid(releaseId, `occurrence:${point["知识点ID"]}:${matched.node.nodeId}`),
    entityId: entityIdFor(point["知识点ID"]),
    sourceId: sourceIdByExternalId.get(point["知识点ID"])!,
    textbookId,
    nodeId: matched.node.nodeId,
    sequenceNo: matched.moduleIndex + 1,
    priority,
    printedPages: point["教材页码"],
    recommendedPeriod: point["建议课时"],
    payload: {
      unit: point["单元"],
      module: point["板块"],
      lessonNo: point["课号"],
      lessonTitle: point["课文/活动"],
      author: point["作者/出处"],
      evidenceAnchor: point["教材证据定位"],
      evidenceLevel: point["证据等级"],
    },
  };
});

const periodRecommendations = sample.period_mapping.map((period) => {
  const key = [period["单元"], period["板块"], period["课号"], period["课文/活动"]].join("\u0000");
  const matched = moduleByKey.get(key);
  if (!matched) throw new Error(`curriculum_period_module_missing:${period["序号"]}`);
  const periodNo = Number(period["课时"].match(/\d+/)?.[0]);
  if (!Number.isInteger(periodNo) || periodNo < 1) throw new Error(`curriculum_period_number_invalid:${period["序号"]}`);
  return {
    id: deterministicUuid(releaseId, `period:${matched.node.nodeId}:${periodNo}`),
    textbookId,
    nodeId: matched.node.nodeId,
    periodNo,
    sequenceNo: matched.moduleIndex + 1,
    title: period["课时"],
    mappingType: period["映射类型"],
    isOfficial: period["官方课时"] === "是",
    note: period["说明"],
    points: splitKnowledgePointIds(period["知识点ID"]).map((externalId, index) => ({
      entityId: entityIdFor(externalId),
      sortNo: index + 1,
    })),
  };
});

const payload = {
  release: {
    id: releaseId,
    scopeKey,
    catalogGenerationId,
    subject: textbook.subject,
    stage: textbook.stage,
    edition: textbook.edition,
    grade: textbook.grade,
    volume: textbook.volume,
    sourceManifest: {
      datasetName: sample.dataset_name,
      sourceSha256: sourceHash,
      generatedAt: sample.generated_at,
      publisher: sample.book.publisher,
      revisionYear: sample.book.revision_year,
      importedAs: "uniform_knowledge_points",
      genericFieldsDiscarded: {
        studentAction: validation.genericFields.studentAction,
        achievementCriterion: validation.genericFields.achievementCriterion,
      },
      officialPeriodCount: periodRecommendations.filter((period) => period.isOfficial).length,
    },
  },
  entities,
  occurrences,
  periodRecommendations,
};

const report = {
  mode: publish ? "publish" : applyDraft ? "draft" : "dry-run",
  releaseId,
  textbook: { id: textbook.id, title: textbook.title },
  matchedModules: validation.matchedModules.length,
  knowledgePoints: validation.pointCount,
  occurrences: occurrences.length,
  periodRecommendations: validation.periodCount,
  embeddings: embedded ? { model: embedded.model, count: embedded.vectors.length } : null,
  discardedGenericFields: payload.release.sourceManifest.genericFieldsDiscarded,
};

if (!publish && !applyDraft) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const target = d1TargetFromArguments(args);
console.log(`Importing knowledge release ${releaseId} into ${describeD1Target(target)} (${publish ? "publish" : "draft"}).`);
const { db, close } = await openD1(target);
try {
  const result = await importCurriculumKnowledgeRelease(db, payload, {
    publish,
    onProgress: (message) => console.log(message),
  });
  console.log(JSON.stringify({ ...report, result }, null, 2));
} finally {
  await close();
}
