import { createHash } from "node:crypto";
import { OfficeConverter, type OfficeChunk, type SupportedFileType } from "officeparser";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasSupabase } from "../config.js";
import { BgeM3EmbeddingProvider } from "../providers/embeddings.js";

type KnowledgeSourceRow = {
  id: string;
  owner_id: string | null;
  notebook_id: string | null;
  lesson_file_id: string | null;
  scope: "public" | "user" | "notebook" | "file";
  title: string;
  media_type: string;
  storage_key: string | null;
  source_version: number;
  metadata: Record<string, unknown> | null;
  worker_id: string;
};

type IndexedChunk = {
  passage: string;
  section?: string;
  page?: number;
};

const mediaTypeToOfficeType: Record<string, SupportedFileType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "md",
};

const normalizeText = (text: string) => text
  .replace(/\r\n?/g, "\n")
  .replace(/[\t\u00a0]+/g, " ")
  .replace(/ *\n */g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export function chunkPlainText(text: string, chunkSize = 1_500, overlap = 160): IndexedChunk[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const chunks: IndexedChunk[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + chunkSize);
    if (end < normalized.length) {
      const candidate = Math.max(
        normalized.lastIndexOf("\n\n", end),
        normalized.lastIndexOf("\n", end),
        normalized.lastIndexOf("。", end),
      );
      if (candidate > cursor + Math.floor(chunkSize * 0.55)) end = candidate + 1;
    }
    const passage = normalizeText(normalized.slice(cursor, end));
    if (passage) chunks.push({ passage });
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks;
}

export async function parseKnowledgeBytes(
  mediaType: string,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
) {
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return { chunks: chunkPlainText(new TextDecoder().decode(bytes)), warnings: [] as string[] };
  }
  const fileType = mediaTypeToOfficeType[mediaType];
  if (!fileType) throw new Error("unsupported_knowledge_file");
  const warnings: string[] = [];
  const converted = await OfficeConverter.convert(Buffer.from(bytes), "chunks", {
    parseConfig: {
      fileType,
      abortSignal: signal,
      decompressionLimits: {
        maxUncompressedBytes: 80 * 1024 * 1024,
        maxZipEntries: 2_500,
      },
    },
    generatorConfig: {
      chunksConfig: {
        strategy: "document-structure",
        splitBy: fileType === "pdf" ? "page" : fileType === "pptx" ? "slide" : "heading",
        maxChunkSize: 1_500,
        tableSplitStrategy: "row",
        addStartIndex: true,
        includeMetadata: true,
        sentenceBoundaryRegex: /[。！？!?]/,
      },
    },
    onWarning: (issue) => warnings.push(`${issue.code}:${issue.message}`.slice(0, 300)),
  });
  const chunks = (converted.value as OfficeChunk[])
    .map((chunk) => ({
      passage: normalizeText(chunk.text),
      section: chunk.metadata.closestHeading || chunk.metadata.sheetName || undefined,
      page: chunk.metadata.pageNumber ?? chunk.metadata.slideNumber,
    }))
    .filter((chunk) => chunk.passage.length > 0);
  return { chunks, warnings: warnings.slice(0, 20) };
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const parseTimeoutMs = 90_000;
const maxChunksPerSource = 2_000;
const parserVersion = "officeparser-document-structure-v1";

export async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(), milliseconds);
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("knowledge_parse_timeout");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class KnowledgeIndexWorker {
  private readonly client: SupabaseClient | null;
  private readonly embeddings = new BgeM3EmbeddingProvider();
  private readonly workerId = crypto.randomUUID();
  private active = false;
  private stopped = false;

  constructor() {
    this.client = hasSupabase && config.BGE_M3_BASE_URL
      ? createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
  }

  get configured() {
    return Boolean(this.client);
  }

  start() {
    if (!this.client) return () => undefined;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped || this.active) return;
      this.active = true;
      try {
        await this.processNext();
      } catch (error) {
        console.error("Knowledge indexing worker failed", error instanceof Error ? error.message : "unknown_error");
      } finally {
        this.active = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), config.KNOWLEDGE_WORKER_INTERVAL_MS);
    return () => {
      this.stopped = true;
      clearInterval(timer);
    };
  }

  async processNext() {
    if (!this.client) return false;
    const claimed = await this.client.rpc("claim_knowledge_source", {
      p_worker_id: this.workerId,
    });
    if (claimed.error) throw new Error(claimed.error.message);
    const source = (Array.isArray(claimed.data) ? claimed.data[0] : claimed.data) as KnowledgeSourceRow | undefined;
    if (!source?.id) return false;
    try {
      await this.index(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : "knowledge_index_failed";
      await this.fail(source, message);
    }
    return true;
  }

  private async index(source: KnowledgeSourceRow) {
    if (!this.client || !source.storage_key) throw new Error("knowledge_source_file_missing");
    const download = await this.client.storage.from("knowledge-private").download(source.storage_key);
    if (download.error) throw new Error(`knowledge_download_failed:${download.error.message}`);
    const bytes = await download.data.arrayBuffer();
    const parsed = await withAbortTimeout(
      (signal) => parseKnowledgeBytes(source.media_type, bytes, signal),
      parseTimeoutMs,
    );
    if (parsed.chunks.length === 0) throw new Error("knowledge_source_empty");
    if (parsed.chunks.length > maxChunksPerSource) throw new Error("knowledge_source_too_many_chunks");

    const indexVersion = `bge-m3:${config.BGE_M3_MODEL}:v1:${parserVersion}:source-${source.source_version}`;
    for (let index = 0; index < parsed.chunks.length; index += 16) {
      await this.heartbeat(source.id);
      const batch = parsed.chunks.slice(index, index + 16);
      const vectors = await this.embedWithRetry(batch.map((chunk) => chunk.passage));
      const rows = batch.map((chunk, batchIndex) => {
        const absoluteIndex = index + batchIndex;
        return {
          stable_chunk_id: this.stableChunkId(source, chunk, absoluteIndex),
          section: chunk.section,
          page: chunk.page,
          passage: chunk.passage,
          adjacent_before: parsed.chunks[absoluteIndex - 1]?.passage.slice(-400),
          adjacent_after: parsed.chunks[absoluteIndex + 1]?.passage.slice(0, 400),
          embedding: vectors[batchIndex],
        };
      });
      const staged = await this.client.rpc("stage_knowledge_chunk_batch", {
        p_source_id: source.id,
        p_worker_id: this.workerId,
        p_index_version: indexVersion,
        p_chunks: rows,
      });
      if (staged.error) throw new Error(staged.error.message);
    }

    await this.heartbeat(source.id);
    const published = await this.client.rpc("publish_staged_knowledge_index", {
      p_source_id: source.id,
      p_worker_id: this.workerId,
      p_index_version: indexVersion,
      p_expected_count: parsed.chunks.length,
      p_metadata: {
        ...(source.metadata ?? {}),
        chunkCount: parsed.chunks.length,
        parserVersion,
        parserWarnings: parsed.warnings,
        indexedAt: new Date().toISOString(),
      },
    });
    if (published.error) throw new Error(published.error.message);
  }

  private async heartbeat(sourceId: string) {
    if (!this.client) return;
    const result = await this.client.rpc("heartbeat_knowledge_source", {
      p_source_id: sourceId,
      p_worker_id: this.workerId,
    });
    if (result.error) throw new Error(result.error.message);
  }

  private async embedWithRetry(passages: string[]) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.embeddings.embed(passages);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await pause(500 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private stableChunkId(source: KnowledgeSourceRow, chunk: IndexedChunk, index: number) {
    const digest = createHash("sha256")
      .update(`${source.id}\0${source.source_version}\0${chunk.page ?? ""}\0${chunk.section ?? ""}\0${chunk.passage}`)
      .digest("hex")
      .slice(0, 32);
    return `${source.id}:${source.source_version}:${index}:${digest}`;
  }

  private async fail(source: KnowledgeSourceRow, error: string) {
    if (!this.client) return;
    const message = error.slice(0, 500);
    const result = await this.client.rpc("fail_knowledge_source", {
      p_source_id: source.id,
      p_worker_id: this.workerId,
      p_error: message,
    });
    if (result.error) throw new Error(result.error.message);
  }
}
