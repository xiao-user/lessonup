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

const safeFilename = (name: string) => name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-120);

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
    return Boolean(this.client);
  }

  async enqueue(ownerId: string, input: {
    file: File;
    notebookId?: string;
    lessonFileId?: string;
    title?: string;
  }) {
    if (!this.client) throw new Error("knowledge_storage_not_configured");
    if (!allowedMediaTypes.has(input.file.type)) throw new Error("unsupported_knowledge_file");
    if (input.file.size > 50 * 1024 * 1024) throw new Error("knowledge_file_too_large");

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
    const storageKey = `${ownerId}/${sourceId}/${safeFilename(input.file.name || "source")}`;
    const upload = await this.client.storage.from("knowledge-private")
      .upload(storageKey, input.file, { contentType: input.file.type, upsert: false });
    if (upload.error) throw new Error(upload.error.message);

    const source = await this.client.from("knowledge_sources").insert({
      id: sourceId,
      owner_id: ownerId,
      notebook_id: input.notebookId,
      lesson_file_id: input.lessonFileId,
      scope,
      title: input.title?.trim() || input.file.name,
      media_type: input.file.type,
      storage_key: storageKey,
      status: "queued",
      metadata: { bytes: input.file.size, originalFilename: input.file.name },
    }).select("*").single();
    if (source.error) {
      await this.client.storage.from("knowledge-private").remove([storageKey]);
      throw new Error(source.error.message);
    }
    await this.audit(ownerId, sourceId, "upload.queued", { scope, storageKey });
    return source.data;
  }

  async get(ownerId: string, sourceId: string) {
    if (!this.client) throw new Error("knowledge_storage_not_configured");
    const source = await this.client.from("knowledge_sources")
      .select("id,title,scope,status,media_type,notebook_id,lesson_file_id,index_version,metadata,created_at,updated_at")
      .eq("owner_id", ownerId).eq("id", sourceId).maybeSingle();
    if (source.error) throw new Error(source.error.message);
    if (!source.data) throw new Error("knowledge_source_not_found");
    return source.data;
  }

  private async audit(ownerId: string, sourceId: string, action: string, details: unknown) {
    if (!this.client) return;
    const result = await this.client.from("knowledge_audit_events").insert({
      owner_id: ownerId, source_id: sourceId, action, details,
    });
    if (result.error) throw new Error(result.error.message);
  }
}
