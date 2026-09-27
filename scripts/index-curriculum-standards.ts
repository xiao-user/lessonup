import "dotenv/config";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { deterministicUuid } from "../server/curriculum/knowledge-sample.js";
import { ConfiguredEmbeddingProvider } from "../server/providers/embeddings.js";
import { config, hasEmbeddingProvider } from "../server/config.js";

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

function serviceClient() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("curriculum_standard_supabase_not_configured");
  }
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

async function indexDocument(
  client: SupabaseClient,
  provider: ConfiguredEmbeddingProvider,
  release: ReturnType<typeof releaseFor>,
  normalized: NormalizedDocument,
  position: number,
  total: number,
) {
  const scope = documentScope(normalized);
  const sourceId = deterministicUuid(release.id, `${normalized.document.sourceFilename}:${normalized.document.parsedSha256}`);
  const workerId = crypto.randomUUID();
  const indexVersion = `embedding:${config.EMBEDDING_MODEL}:${normalizerVersion}:${normalized.document.parsedSha256.slice(0, 16)}`;
  const document = {
    filename: normalized.document.sourceFilename,
    title: normalized.document.title,
    kind: normalized.document.kind,
    subject: normalized.document.subject,
    ...scope,
    standardCode: "",
    sourceUrl: "",
  };
  const begun = await client.rpc("upsert_parsed_curriculum_standard_document", {
    p_release: release,
    p_document: document,
    p_source_id: sourceId,
    p_parsed_sha256: normalized.document.parsedSha256,
    p_worker_id: workerId,
    p_index_version: indexVersion,
  });
  if (begun.error) throw new Error(`curriculum_standard_begin_failed:${normalized.document.title}:${begun.error.message}`);
  const source = (Array.isArray(begun.data) ? begun.data[0] : begun.data) as {
    status?: string; index_version?: string; metadata?: Record<string, unknown>;
  } | null;
  if (source?.status === "ready" && source.index_version === indexVersion) {
    console.log(`[${position}/${total}] 已是最新索引 ${normalized.document.title}`);
    return;
  }

  try {
    for (let index = 0; index < normalized.chunks.length; index += batchSize) {
      const batch = normalized.chunks.slice(index, index + batchSize);
      const heartbeat = await client.rpc("heartbeat_knowledge_source", {
        p_source_id: sourceId,
        p_worker_id: workerId,
      });
      if (heartbeat.error) throw new Error(heartbeat.error.message);
      const vectors = await embedWithRetry(provider, batch.map((chunk) => chunk.embeddingText));
      const rows = batch.map((chunk, batchIndex) => {
        const absoluteIndex = index + batchIndex;
        return {
          stable_chunk_id: chunk.stableChunkId,
          section: chunk.section,
          page: chunk.pageStart,
          page_end: chunk.pageEnd,
          passage: chunk.passage,
          adjacent_before: normalized.chunks[absoluteIndex - 1]?.passage.slice(-400),
          adjacent_after: normalized.chunks[absoluteIndex + 1]?.passage.slice(0, 400),
          embedding: vectors[batchIndex],
          metadata: {
            headingPath: chunk.headingPath,
            blockRefs: chunk.blockRefs,
            labels: chunk.labels,
            averageConfidence: chunk.averageConfidence,
            contentSha256: chunk.contentSha256,
          },
        };
      });
      const staged = await client.rpc("stage_knowledge_chunk_batch", {
        p_source_id: sourceId,
        p_worker_id: workerId,
        p_index_version: indexVersion,
        p_chunks: rows,
      });
      if (staged.error) throw new Error(staged.error.message);
      process.stdout.write(`\r[${position}/${total}] ${normalized.document.title} ${Math.min(index + batch.length, normalized.chunks.length)}/${normalized.chunks.length}`);
    }
    process.stdout.write("\n");
    const published = await client.rpc("publish_staged_knowledge_index", {
      p_source_id: sourceId,
      p_worker_id: workerId,
      p_index_version: indexVersion,
      p_expected_count: normalized.chunks.length,
      p_metadata: {
        ...(source?.metadata ?? {}),
        chunkCount: normalized.chunks.length,
        pageCount: normalized.document.pageCount,
        parserVersion: normalized.parser.engine,
        normalizerVersion,
        parserWarnings: normalized.quality.warnings,
        quality: normalized.quality,
        indexedAt: new Date().toISOString(),
        rawArtifactStored: false,
      },
    });
    if (published.error) throw new Error(published.error.message);
  } catch (error) {
    await client.rpc("fail_knowledge_source", {
      p_source_id: sourceId,
      p_worker_id: workerId,
      p_error: (error instanceof Error ? error.message : "curriculum_standard_index_failed").slice(0, 500),
    });
    throw error;
  }
}

async function status(client: SupabaseClient, release: ReturnType<typeof releaseFor>) {
  const releaseResult = await client.from("curriculum_standard_releases")
    .select("id,title,status,expected_document_count,published_at")
    .eq("release_key", release.releaseKey)
    .maybeSingle();
  if (releaseResult.error) throw new Error(releaseResult.error.message);
  if (!releaseResult.data) throw new Error("curriculum_standard_release_not_imported");
  const documentsResult = await client.from("curriculum_standard_documents")
    .select("title,subject,document_kind,knowledge_source_id")
    .eq("release_id", releaseResult.data.id)
    .order("title");
  if (documentsResult.error) throw new Error(documentsResult.error.message);
  const sourceIds = (documentsResult.data ?? []).map((document) => document.knowledge_source_id);
  const sourcesResult = sourceIds.length
    ? await client.from("knowledge_sources").select("id,status,index_version,last_error,metadata").in("id", sourceIds)
    : { data: [], error: null };
  if (sourcesResult.error) throw new Error(sourcesResult.error.message);
  const sourceById = new Map((sourcesResult.data ?? []).map((source) => [source.id, source]));
  console.log(`${releaseResult.data.title} · ${releaseResult.data.status} · ${(documentsResult.data ?? []).length}/${releaseResult.data.expected_document_count}`);
  for (const document of documentsResult.data ?? []) {
    const source = sourceById.get(document.knowledge_source_id);
    console.log(`${source?.status ?? "missing"}\t${document.subject ?? "共用课程方案"}\t${document.title}${source?.last_error ? `\t${source.last_error}` : ""}`);
  }
}

async function publish(client: SupabaseClient, release: ReturnType<typeof releaseFor>) {
  const result = await client.rpc("publish_curriculum_standard_release", { p_release_key: release.releaseKey });
  if (result.error) throw new Error(`curriculum_standard_publish_failed:${result.error.message}`);
  console.log(`已原子发布：${release.title}`);
}

const allDocuments = await loadDocuments();
const release = releaseFor(allDocuments);
if (action === "validate") {
  const chunks = allDocuments.reduce((sum, document) => sum + document.chunks.length, 0);
  console.log(`校验通过：${allDocuments.length} 份文档，${chunks} 个切片，发布键 ${release.releaseKey}`);
} else {
  const client = serviceClient();
  if (action === "status") {
    await status(client, release);
  } else if (action === "publish") {
    await publish(client, release);
  } else {
    if (!hasEmbeddingProvider) throw new Error("embedding_not_configured");
    const selected = only
      ? allDocuments.filter((document) => document.document.subject === only || document.document.kind === only)
      : allDocuments;
    if (!selected.length) throw new Error(`curriculum_standard_only_not_found:${only}`);
    const provider = new ConfiguredEmbeddingProvider();
    for (const [index, document] of selected.entries()) {
      await indexDocument(client, provider, release, document, index + 1, selected.length);
    }
    if (shouldPublish) await publish(client, release);
    else console.log("索引已写入草稿版本；全部文档就绪后运行 curriculum:standards:publish 原子发布。");
  }
}
