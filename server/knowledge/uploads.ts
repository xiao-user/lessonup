import { config, hasEmbeddingProvider } from "../config.js";
import type { LessonRepository } from "../repository.js";
import type { ObjectStorage } from "../platform/object-storage.js";
import { D1KnowledgeSourceStore, type KnowledgeSourceStore } from "./source-store.js";

const allowedMediaTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
]);

const mediaTypeByExtension = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
]);

export function resolveKnowledgeMediaType(file: Pick<File, "name" | "type">) {
  if (allowedMediaTypes.has(file.type)) return file.type;
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  return extension ? mediaTypeByExtension.get(extension) : undefined;
}

export async function hasMeaningfulKnowledgeContent(file: File, mediaType: string) {
  if (mediaType !== "text/plain" && mediaType !== "text/markdown") return file.size > 0;
  if (file.size === 0) return false;
  const text = new TextDecoder().decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
  return text.trim().length > 0;
}

export function safeKnowledgeStorageFilename(name: string) {
  const normalized = name.normalize("NFKC");
  const extension = normalized.toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0] ?? "";
  const stem = normalized
    .slice(0, extension ? -extension.length : undefined)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 96);
  return `${stem || "source"}${extension}`;
}
const maxUploadBytes = 10 * 1024 * 1024;

async function hasExpectedSignature(file: File, mediaType: string) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (mediaType === "application/pdf") {
    return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  }
  if (
    mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mediaType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return !bytes.includes(0);
  }
  return false;
}

export class KnowledgeUploadService {
  private readonly storage: ObjectStorage | null;
  private readonly sourceStore: KnowledgeSourceStore | null;

  constructor(
    private readonly repository: LessonRepository,
    objectStorage?: ObjectStorage | null,
    sourceStore?: KnowledgeSourceStore | null,
  ) {
    this.sourceStore = sourceStore ?? null;
    this.storage = objectStorage ?? null;
  }

  get configured() {
    return Boolean(this.sourceStore && this.storage && hasEmbeddingProvider);
  }

  get storageConfigured() {
    return Boolean(this.sourceStore && this.storage);
  }

  async enqueue(ownerId: string, input: {
    file: File;
    notebookId?: string;
    lessonFileId?: string;
    title?: string;
    idempotencyKey: string;
  }) {
    if (!this.sourceStore || !this.storage || !hasEmbeddingProvider) throw new Error("knowledge_indexing_not_configured");
    const mediaType = resolveKnowledgeMediaType(input.file);
    if (!mediaType) throw new Error("unsupported_knowledge_file");
    if (input.file.size > maxUploadBytes) throw new Error("knowledge_file_too_large");
    if (!await hasMeaningfulKnowledgeContent(input.file, mediaType)) throw new Error("knowledge_source_empty");
    if (!await hasExpectedSignature(input.file, mediaType)) throw new Error("unsupported_knowledge_file");

    await this.deleteExpiredDrafts(ownerId);

    const existing = await this.sourceStore.findByUploadIdempotency(ownerId, input.idempotencyKey);
    if (existing) return existing;

    let scope: "user" | "notebook" | "file" = "user";
    if (input.lessonFileId) {
      const lessonFile = await this.repository.getLessonFile(ownerId, input.lessonFileId);
      if (!lessonFile || (input.notebookId && lessonFile.notebookId !== input.notebookId)) {
        throw new Error("lesson_scope_invalid");
      }
      input.notebookId = lessonFile.notebookId;
      scope = "file";
    } else if (input.notebookId) {
      if (!await this.repository.getNotebook(ownerId, input.notebookId)) throw new Error("notebook_scope_invalid");
      scope = "notebook";
    }

    const sourceId = crypto.randomUUID();
    const storageKey = `${ownerId}/${sourceId}/${safeKnowledgeStorageFilename(input.file.name || "source")}`;
    await this.storage.put(storageKey, input.file, {
      contentType: mediaType,
      customMetadata: { originalFilename: input.file.name },
    });

    try {
      const now = new Date().toISOString();
      return await this.sourceStore.enqueue({
        id: sourceId, owner_id: ownerId, notebook_id: input.notebookId ?? null,
        lesson_file_id: input.lessonFileId ?? null, scope, title: input.title?.trim() || input.file.name,
        media_type: mediaType, storage_key: storageKey, source_version: 1, status: "queued",
        index_version: null, metadata: { bytes: input.file.size, originalFilename: input.file.name },
        upload_idempotency_key: input.idempotencyKey, attached_message_id: null, attempt_count: 0,
        max_attempts: 3, available_at: now, lease_expires_at: null, worker_id: null, last_error: null,
        created_at: now, updated_at: now,
      });
    } catch (error) {
      await this.storage.remove([storageKey]);
      throw error;
    }
  }

  async list(ownerId: string, scope: {
    notebookId?: string;
    lessonFileId?: string;
    includeAttached?: boolean;
  }) {
    if (!this.sourceStore) throw new Error("knowledge_storage_not_configured");
    return this.sourceStore.list(ownerId, scope);
  }

  async get(ownerId: string, sourceId: string) {
    if (!this.sourceStore) throw new Error("knowledge_storage_not_configured");
    const source = await this.sourceStore.get(ownerId, sourceId);
    if (!source) throw new Error("knowledge_source_not_found");
    return source;
  }

  async retry(ownerId: string, sourceId: string) {
    if (!this.sourceStore || !hasEmbeddingProvider) throw new Error("knowledge_indexing_not_configured");
    const source = await this.sourceStore.retry(ownerId, sourceId, new Date().toISOString());
    if (!source) throw new Error("knowledge_source_not_retryable");
    await this.audit(ownerId, sourceId, "index.retry_requested", {});
    return source;
  }

  async delete(ownerId: string, sourceId: string) {
    if (!this.sourceStore) throw new Error("knowledge_storage_not_configured");
    const source = await this.sourceStore.get(ownerId, sourceId);
    if (!source) throw new Error("knowledge_source_not_found");
    await this.audit(ownerId, sourceId, "source.deleted", {});
    if (source.storage_key) await this.storage?.remove([source.storage_key]);
    await this.sourceStore.delete(ownerId, sourceId);
  }

  async deleteForLessonFile(ownerId: string, lessonFileId: string) {
    if (!this.sourceStore) return;
    for (const sourceId of await this.sourceStore.listIds(ownerId, "lessonFile", lessonFileId)) await this.delete(ownerId, sourceId);
  }

  async deleteForNotebook(ownerId: string, notebookId: string) {
    if (!this.sourceStore) return;
    for (const sourceId of await this.sourceStore.listIds(ownerId, "notebook", notebookId)) await this.delete(ownerId, sourceId);
  }

  private async audit(ownerId: string, sourceId: string, action: string, details: unknown) {
    await this.sourceStore?.audit(ownerId, sourceId, action, details, new Date().toISOString());
  }

  private async deleteExpiredDrafts(ownerId: string) {
    if (!this.sourceStore) return;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    await Promise.allSettled((await this.sourceStore.listExpiredDraftIds(ownerId, cutoff, 32))
      .map((sourceId) => this.delete(ownerId, sourceId)));
  }
}
