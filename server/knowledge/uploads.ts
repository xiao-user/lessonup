import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasSupabase } from "../config.js";
import type { LessonRepository } from "../repository.js";

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
  private readonly client: SupabaseClient | null;

  constructor(private readonly repository: LessonRepository) {
    this.client = hasSupabase
      ? createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
  }

  get configured() {
    return Boolean(this.client && config.BGE_M3_BASE_URL);
  }

  async enqueue(ownerId: string, input: {
    file: File;
    notebookId?: string;
    lessonFileId?: string;
    title?: string;
    idempotencyKey: string;
  }) {
    if (!this.client || !config.BGE_M3_BASE_URL) throw new Error("knowledge_indexing_not_configured");
    const mediaType = resolveKnowledgeMediaType(input.file);
    if (!mediaType) throw new Error("unsupported_knowledge_file");
    if (input.file.size > maxUploadBytes) throw new Error("knowledge_file_too_large");
    if (!await hasMeaningfulKnowledgeContent(input.file, mediaType)) throw new Error("knowledge_source_empty");
    if (!await hasExpectedSignature(input.file, mediaType)) throw new Error("unsupported_knowledge_file");

    const existing = await this.client.from("knowledge_sources").select("*")
      .eq("owner_id", ownerId)
      .eq("upload_idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return existing.data;

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
    const upload = await this.client.storage.from("knowledge-private")
      .upload(storageKey, input.file, { contentType: mediaType, upsert: false });
    if (upload.error) throw new Error(upload.error.message);

    const source = await this.client.rpc("enqueue_knowledge_source", {
      p_owner_id: ownerId,
      p_source_id: sourceId,
      p_notebook_id: input.notebookId ?? null,
      p_lesson_file_id: input.lessonFileId ?? null,
      p_scope: scope,
      p_title: input.title?.trim() || input.file.name,
      p_media_type: mediaType,
      p_storage_key: storageKey,
      p_metadata: { bytes: input.file.size, originalFilename: input.file.name },
      p_idempotency_key: input.idempotencyKey,
    });
    if (source.error) {
      await this.client.storage.from("knowledge-private").remove([storageKey]);
      throw new Error(source.error.message);
    }
    return source.data;
  }

  async list(ownerId: string, scope: { notebookId?: string; lessonFileId?: string }) {
    if (!this.client) throw new Error("knowledge_storage_not_configured");
    let query = this.client.from("knowledge_sources")
      .select("id,title,scope,status,media_type,notebook_id,lesson_file_id,index_version,metadata,attempt_count,max_attempts,last_error,created_at,updated_at")
      .eq("owner_id", ownerId)
      .neq("status", "deleted")
      .is("attached_message_id", null)
      .order("updated_at", { ascending: false });
    if (scope.lessonFileId) query = query.eq("lesson_file_id", scope.lessonFileId);
    else if (scope.notebookId) query = query.eq("notebook_id", scope.notebookId);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  }

  async get(ownerId: string, sourceId: string) {
    if (!this.client) throw new Error("knowledge_storage_not_configured");
    const source = await this.client.from("knowledge_sources")
      .select("id,title,scope,status,media_type,notebook_id,lesson_file_id,index_version,metadata,attempt_count,max_attempts,last_error,created_at,updated_at")
      .eq("owner_id", ownerId).eq("id", sourceId).maybeSingle();
    if (source.error) throw new Error(source.error.message);
    if (!source.data) throw new Error("knowledge_source_not_found");
    return source.data;
  }

  async retry(ownerId: string, sourceId: string) {
    if (!this.client || !config.BGE_M3_BASE_URL) throw new Error("knowledge_indexing_not_configured");
    const source = await this.client.from("knowledge_sources").update({
      status: "queued",
      attempt_count: 0,
      available_at: new Date().toISOString(),
      worker_id: null,
      lease_expires_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("owner_id", ownerId).eq("id", sourceId).eq("status", "failed")
      .select("*").maybeSingle();
    if (source.error) throw new Error(source.error.message);
    if (!source.data) throw new Error("knowledge_source_not_retryable");
    await this.audit(ownerId, sourceId, "index.retry_requested", {});
    return source.data;
  }

  async delete(ownerId: string, sourceId: string) {
    if (!this.client) throw new Error("knowledge_storage_not_configured");
    const source = await this.client.from("knowledge_sources")
      .select("id,storage_key").eq("owner_id", ownerId).eq("id", sourceId).maybeSingle();
    if (source.error) throw new Error(source.error.message);
    if (!source.data) throw new Error("knowledge_source_not_found");

    const marked = await this.client.from("knowledge_sources").update({
      status: "deleted",
      worker_id: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq("owner_id", ownerId).eq("id", sourceId);
    if (marked.error) throw new Error(marked.error.message);
    await this.audit(ownerId, sourceId, "source.deleted", {});

    if (source.data.storage_key) {
      const removed = await this.client.storage.from("knowledge-private").remove([source.data.storage_key]);
      if (removed.error) throw new Error("knowledge_storage_delete_failed");
    }
    const deleted = await this.client.from("knowledge_sources").delete()
      .eq("owner_id", ownerId).eq("id", sourceId);
    if (deleted.error) throw new Error(deleted.error.message);
  }

  private async audit(ownerId: string, sourceId: string, action: string, details: unknown) {
    if (!this.client) return;
    const result = await this.client.from("knowledge_audit_events").insert({
      owner_id: ownerId, source_id: sourceId, action, details,
    });
    if (result.error) throw new Error(result.error.message);
  }
}
