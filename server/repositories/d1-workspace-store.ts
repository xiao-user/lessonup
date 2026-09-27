import { createHash } from "node:crypto";
import type { LessonContextProfile, LessonFileRecord, LessonGenerationIntentRecord, LessonPlan, NotebookGraphRecord, NotebookRecord } from "../domain.js";
import { DocumentPatchError } from "../document-patch.js";
import type { ImportedNotebook, LessonFileContextRecord, LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement, SqlValue } from "../platform/sql-database.js";
import { createLessonPlanPreview } from "../../src/lib/lesson-preview.js";

type NotebookRow = {
  id: string; owner_id: string; title: string; class_name: string; year: string; subject: string;
  stage: string; grade: string; edition: string; tone: NotebookRecord["tone"]; updated_at: string;
};
type FileRow = {
  id: string; owner_id: string; notebook_id: string; lesson_blueprint_id: string | null; title: string;
  type: string; image: string | null; document_json: string; context_profile_json: string;
  document_version: number; page_count: number; updated_at: string;
};

type BlueprintContextRow = {
  framework_id: string;
  semester_unit_id: string;
  lesson_blueprint_id: string;
  catalog_release_id: string;
  textbook_id: string;
  curriculum_node_id: string;
  semantic_release_id: string | null;
  framework_version: number;
  blueprint_version: number;
};

type OutcomeSelectionRow = {
  semantic_entity_id: string;
  canonical_name: string | null;
  adjustment_reason: string;
  teacher_confirmed: number;
};

type InitialDesignBasis = {
  id: string;
  statements: SqlStatement[];
};

type GenerationIntentRow = {
  id: string;
  owner_id: string;
  lesson_file_id: string;
  prompt: string;
  state: "pending" | "claimed";
  run_id: string | null;
  created_at: string;
  claimed_at: string | null;
};

/**
 * The notebook/document slice of LessonRepository. Other resource families
 * retain their own adapters while this vertical slice is migrated and tested.
 */
export type LessonWorkspaceStore = Pick<LessonRepository,
  "importNotebookGraph" | "listNotebooks" | "createNotebook" | "updateNotebook" | "deleteNotebook" |
  "getNotebook" | "createLessonFile" | "updateLessonFile" | "deleteLessonFile" | "getLessonFile" | "getLessonFileContext" |
  "getPendingLessonGenerationIntent" | "enqueueLessonGenerationIntent" | "claimLessonGenerationIntent" |
  "saveLessonDocument" | "updateLessonPageCount">;

export class D1LessonWorkspaceStore implements LessonWorkspaceStore {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}

  async importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]) {
    const timestamp = this.clock();
    // A scope collision deliberately violates NOT NULL, rolling back the
    // entire import batch rather than silently accepting a partial import.
    const statements = notebooks.flatMap((notebook) => [
      {
        sql: `INSERT INTO notebooks (id, owner_id, title, class_name, year, subject, stage, grade, edition, tone, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET owner_id = CASE WHEN notebooks.owner_id = excluded.owner_id THEN notebooks.owner_id ELSE NULL END,
              title = excluded.title, class_name = excluded.class_name, year = excluded.year,
              subject = excluded.subject, stage = excluded.stage, grade = excluded.grade, edition = excluded.edition,
              tone = excluded.tone, updated_at = excluded.updated_at`,
        params: [notebook.id, ownerId, notebook.title, notebook.className, notebook.year, notebook.subject,
          notebook.stage ?? "", notebook.grade ?? "", notebook.edition ?? "", notebook.tone ?? "teal", timestamp, timestamp],
      },
      ...notebook.files.map((file) => ({
        sql: `INSERT INTO lesson_files (id, owner_id, notebook_id, lesson_blueprint_id, title, type, image, document_json, context_profile_json, document_version, page_count, created_at, updated_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET owner_id = CASE WHEN lesson_files.owner_id = excluded.owner_id AND lesson_files.notebook_id = excluded.notebook_id THEN lesson_files.owner_id ELSE NULL END,
              title = excluded.title, type = excluded.type, image = excluded.image,
              document_json = excluded.document_json, document_version = excluded.document_version,
              page_count = excluded.page_count, updated_at = excluded.updated_at`,
        params: [file.id, ownerId, notebook.id, file.title, file.type ?? "教案", file.image ?? null,
          JSON.stringify(file.lessonPlan), file.documentVersion ?? 0, file.pages ?? 1, timestamp, timestamp],
      })),
      ...notebook.files.flatMap((file) => initialFileInvariantStatements({
        ownerId,
        fileId: file.id,
        notebookId: notebook.id,
        document: file.lessonPlan,
        documentVersion: file.documentVersion ?? 0,
        pageCount: file.pages ?? 1,
        contextProfile: {},
        createdAt: timestamp,
        basisId: `basis:${file.id}`,
      })),
    ]);
    if (statements.length) await this.database.batch(statements);
    return { imported: notebooks.reduce((total, notebook) => total + notebook.files.length, 0) };
  }

  async listNotebooks(ownerId: string): Promise<NotebookGraphRecord[]> {
    const [notebooks, files] = await this.database.batch<NotebookRow | FileRow>([
      { sql: `${selectNotebook} WHERE owner_id = ? ORDER BY updated_at DESC`, params: [ownerId] },
      { sql: `${selectFile} WHERE owner_id = ? ORDER BY updated_at DESC`, params: [ownerId] },
    ]);
    const byNotebook = new Map<string, ReturnType<typeof fileSummary>[]>();
    for (const row of files.rows as FileRow[]) {
      const summaries = byNotebook.get(row.notebook_id) ?? [];
      summaries.push(fileSummary(row));
      byNotebook.set(row.notebook_id, summaries);
    }
    return (notebooks.rows as NotebookRow[]).map((row) => ({ ...notebook(row), files: byNotebook.get(row.id) ?? [] }));
  }

  async createNotebook(ownerId: string, input: Parameters<LessonRepository["createNotebook"]>[1]) {
    const timestamp = this.clock();
    const record: NotebookRecord = { id: crypto.randomUUID(), ownerId, title: input.title, className: input.className,
      year: input.year, subject: input.subject, stage: input.stage ?? "", grade: input.grade ?? "", edition: input.edition ?? "", tone: input.tone, updatedAt: timestamp };
    await this.database.query({ sql: `INSERT INTO notebooks (id, owner_id, title, class_name, year, subject, stage, grade, edition, tone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [record.id, ownerId, record.title, record.className, record.year, record.subject, record.stage, record.grade, record.edition, record.tone, timestamp, timestamp] });
    return record;
  }

  async updateNotebook(ownerId: string, notebookId: string, patch: Parameters<LessonRepository["updateNotebook"]>[2]) {
    const columns: Record<string, string> = { title: "title", className: "class_name", year: "year", subject: "subject", stage: "stage", grade: "grade", edition: "edition", tone: "tone" };
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) if (value !== undefined && columns[key]) { assignments.push(`${columns[key]} = ?`); params.push(value as string); }
    const updatedAt = this.clock();
    assignments.push("updated_at = ?"); params.push(updatedAt, ownerId, notebookId);
    const result = await this.database.query({ sql: `UPDATE notebooks SET ${assignments.join(", ")} WHERE owner_id = ? AND id = ?`, params });
    if (!result.rowsAffected) throw new Error("notebook_not_found");
    return (await this.getNotebook(ownerId, notebookId))!;
  }

  async deleteNotebook(ownerId: string, notebookId: string) {
    const result = await this.database.query({ sql: "DELETE FROM notebooks WHERE owner_id = ? AND id = ?", params: [ownerId, notebookId] });
    if (!result.rowsAffected) throw new Error("notebook_not_found");
  }

  async getNotebook(ownerId: string, notebookId: string) {
    const result = await this.database.query<NotebookRow>({ sql: `${selectNotebook} WHERE owner_id = ? AND id = ?`, params: [ownerId, notebookId] });
    return result.rows[0] ? notebook(result.rows[0]) : null;
  }

  async createLessonFile(ownerId: string, input: Parameters<LessonRepository["createLessonFile"]>[1], idempotencyKey = crypto.randomUUID()) {
    const fingerprint = fingerprintOf(input);
    const replay = await this.replay<LessonFileRecord>(ownerId, "create_lesson_file", idempotencyKey, fingerprint);
    if (replay) return replay;
    if (!await this.getNotebook(ownerId, input.notebookId)) throw new Error("notebook_not_found");
    const timestamp = this.clock();
    const file: LessonFileRecord = { id: crypto.randomUUID(), ownerId, notebookId: input.notebookId, lessonBlueprintId: input.lessonBlueprintId,
      title: input.title, type: input.type, image: input.image, document: structuredClone(input.document), contextProfile: structuredClone(input.contextProfile ?? {}), documentVersion: 0, pageCount: input.pageCount, updatedAt: timestamp };
    const designBasis = await this.prepareInitialDesignBasis(ownerId, file);
    const initialPrompt = input.initialAgentPrompt?.trim();
    const generationIntent = initialPrompt ? {
      id: crypto.randomUUID(), ownerId, lessonFileId: file.id, prompt: initialPrompt,
      state: "pending" as const, createdAt: timestamp,
    } satisfies LessonGenerationIntentRecord : null;
    await this.database.batch([
      { sql: `INSERT INTO lesson_files (id, owner_id, notebook_id, lesson_blueprint_id, title, type, image, document_json, context_profile_json, document_version, page_count, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: fileParams(file, timestamp) },
      ...initialFileInvariantStatements({
        ownerId,
        fileId: file.id,
        notebookId: file.notebookId,
        document: file.document,
        documentVersion: file.documentVersion,
        pageCount: file.pageCount,
        contextProfile: file.contextProfile,
        createdAt: timestamp,
        basisId: designBasis.id,
        designBasis: designBasis.statements,
      }),
      ...(generationIntent ? [generationIntentInsert(generationIntent)] : []),
      { sql: "UPDATE notebooks SET updated_at = ? WHERE owner_id = ? AND id = ?", params: [timestamp, ownerId, file.notebookId] },
      ...this.storeReplay(ownerId, "create_lesson_file", idempotencyKey, fingerprint, file, timestamp),
    ]);
    return file;
  }

  async updateLessonFile(ownerId: string, fileId: string, patch: Parameters<LessonRepository["updateLessonFile"]>[2]) {
    const columns: Record<string, string> = { title: "title", type: "type", image: "image", contextProfile: "context_profile_json" };
    const assignments: string[] = []; const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) if (value !== undefined && columns[key]) { assignments.push(`${columns[key]} = ?`); params.push(key === "contextProfile" ? JSON.stringify(value) : value as string); }
    const timestamp = this.clock(); assignments.push("updated_at = ?"); params.push(timestamp, ownerId, fileId);
    const result = await this.database.query({ sql: `UPDATE lesson_files SET ${assignments.join(", ")} WHERE owner_id = ? AND id = ?`, params });
    if (!result.rowsAffected) throw new Error("lesson_file_not_found");
    const file = (await this.getLessonFile(ownerId, fileId))!;
    await this.database.query({ sql: "UPDATE notebooks SET updated_at = ? WHERE owner_id = ? AND id = ?", params: [timestamp, ownerId, file.notebookId] });
    return file;
  }

  async deleteLessonFile(ownerId: string, fileId: string) {
    const file = await this.getLessonFile(ownerId, fileId); if (!file) throw new Error("lesson_file_not_found");
    await this.database.batch([{ sql: "DELETE FROM lesson_files WHERE owner_id = ? AND id = ?", params: [ownerId, fileId] }, { sql: "UPDATE notebooks SET updated_at = ? WHERE owner_id = ? AND id = ?", params: [this.clock(), ownerId, file.notebookId] }]);
  }

  async getLessonFile(ownerId: string, fileId: string) {
    const result = await this.database.query<FileRow>({ sql: `${selectFile} WHERE owner_id = ? AND id = ?`, params: [ownerId, fileId] });
    return result.rows[0] ? file(result.rows[0]) : null;
  }

  async getLessonFileContext(ownerId: string, fileId: string): Promise<LessonFileContextRecord | null> {
    const result = await this.database.query<Pick<FileRow,
      "id" | "owner_id" | "notebook_id" | "document_version" | "context_profile_json"
    >>({
      sql: "SELECT id, owner_id, notebook_id, document_version, context_profile_json FROM lesson_files WHERE owner_id = ? AND id = ?",
      params: [ownerId, fileId],
    });
    const row = result.rows[0];
    return row ? {
      id: row.id,
      ownerId: row.owner_id,
      notebookId: row.notebook_id,
      documentVersion: Number(row.document_version),
      contextProfile: JSON.parse(row.context_profile_json) as LessonContextProfile,
    } : null;
  }

  async getPendingLessonGenerationIntent(ownerId: string, lessonFileId: string) {
    const result = await this.database.query<GenerationIntentRow>({
      sql: `${generationIntentSelect} WHERE owner_id = ? AND lesson_file_id = ? AND state = 'pending' LIMIT 1`,
      params: [ownerId, lessonFileId],
    });
    return result.rows[0] ? generationIntent(result.rows[0]) : null;
  }

  async enqueueLessonGenerationIntent(input: Parameters<LessonRepository["enqueueLessonGenerationIntent"]>[0]) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("generation_intent_prompt_empty");
    const fingerprint = fingerprintOf({ lessonFileId: input.lessonFileId, prompt });
    const replay = await this.replay<LessonGenerationIntentRecord>(
      input.ownerId,
      "enqueue_lesson_generation_intent",
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    if (!await this.getLessonFile(input.ownerId, input.lessonFileId)) throw new Error("lesson_file_not_found");
    const timestamp = this.clock();
    const intent: LessonGenerationIntentRecord = {
      id: crypto.randomUUID(), ownerId: input.ownerId, lessonFileId: input.lessonFileId,
      prompt, state: "pending", createdAt: timestamp,
    };
    await this.database.batch([
      {
        sql: `INSERT INTO lesson_generation_intents (id, owner_id, lesson_file_id, prompt, state, run_id, created_at, claimed_at)
          VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
          ON CONFLICT(owner_id, lesson_file_id) DO UPDATE SET
            id = excluded.id, prompt = excluded.prompt, state = 'pending', run_id = NULL,
            created_at = excluded.created_at, claimed_at = NULL`,
        params: [intent.id, intent.ownerId, intent.lessonFileId, intent.prompt, intent.createdAt],
      },
      ...this.storeReplay(
        input.ownerId,
        "enqueue_lesson_generation_intent",
        input.idempotencyKey,
        fingerprint,
        intent,
        timestamp,
      ),
    ]);
    return intent;
  }

  async claimLessonGenerationIntent(input: Parameters<LessonRepository["claimLessonGenerationIntent"]>[0]) {
    const pending = await this.database.query<GenerationIntentRow>({
      sql: `${generationIntentSelect} WHERE owner_id = ? AND lesson_file_id = ? AND id = ? AND state = 'pending' LIMIT 1`,
      params: [input.ownerId, input.lessonFileId, input.intentId],
    });
    const intent = pending.rows[0];
    if (!intent) throw new Error("lesson_generation_intent_unavailable");
    const claimedAt = this.clock();
    const claimed = await this.database.query({
      sql: `UPDATE lesson_generation_intents SET state = 'claimed', run_id = ?, claimed_at = ?
        WHERE owner_id = ? AND lesson_file_id = ? AND id = ? AND state = 'pending'`,
      params: [input.runId, claimedAt, input.ownerId, input.lessonFileId, input.intentId],
    });
    if (!claimed.rowsAffected) throw new Error("lesson_generation_intent_unavailable");
    return {
      ...generationIntent(intent),
      state: "claimed" as const,
      runId: input.runId,
      claimedAt,
    };
  }

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const fingerprint = fingerprintOf({ fileId: args.fileId, baseVersion: args.baseVersion, document: args.document, pageCount: args.pageCount, source: args.source, runId: args.runId ?? null });
    const replay = await this.replay<LessonFileRecord>(args.ownerId, "save_lesson_document", args.idempotencyKey, fingerprint); if (replay) return replay;
    const timestamp = this.clock();
    const [changed] = await this.database.batch<FileRow>([
      { sql: `UPDATE lesson_files SET document_json = ?, document_version = document_version + 1, page_count = ?, updated_at = ?
        WHERE owner_id = ? AND id = ? AND document_version = ? RETURNING *`, params: [JSON.stringify(args.document), args.pageCount, timestamp, args.ownerId, args.fileId, args.baseVersion] },
      { sql: `INSERT INTO lesson_file_versions (id, owner_id, lesson_file_id, document_version, document_json, page_count, actor, run_id, idempotency_key, created_at)
        SELECT ?, owner_id, id, document_version, document_json, page_count, ?, ?, ?, ? FROM lesson_files
        WHERE owner_id = ? AND id = ? AND changes() = 1`,
        params: [crypto.randomUUID(), args.source, args.runId ?? null, args.idempotencyKey, timestamp, args.ownerId, args.fileId] },
      { sql: `INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at)
        SELECT owner_id, 'save_lesson_document', ?, ?, json_patch(json_object(
          'id', id, 'ownerId', owner_id, 'notebookId', notebook_id, 'lessonBlueprintId', lesson_blueprint_id,
          'title', title, 'type', type, 'image', image, 'document', json(document_json),
          'contextProfile', json(context_profile_json), 'documentVersion', document_version, 'pageCount', page_count, 'updatedAt', updated_at),
          json_object('lessonBlueprintId', lesson_blueprint_id, 'image', image)), ?
        FROM lesson_files WHERE owner_id = ? AND id = ? AND changes() = 1`,
        params: [args.idempotencyKey, fingerprint, timestamp, args.ownerId, args.fileId] },
    ]);
    if (!changed.rowsAffected) {
      const concurrentReplay = await this.replay<LessonFileRecord>(args.ownerId, "save_lesson_document", args.idempotencyKey, fingerprint);
      if (concurrentReplay) return concurrentReplay;
      if (!await this.getLessonFile(args.ownerId, args.fileId)) throw new Error("lesson_file_not_found");
      throw new DocumentPatchError("stale_document", "教案已被继续编辑，请基于最新版本重试");
    }
    return file(changed.rows[0]!);
  }

  async updateLessonPageCount(args: Parameters<LessonRepository["updateLessonPageCount"]>[0]) {
    const timestamp = this.clock();
    const updated = await this.database.query({ sql: "UPDATE lesson_files SET page_count = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND document_version = ?", params: [args.pageCount, timestamp, args.ownerId, args.fileId, args.documentVersion] });
    if (!updated.rowsAffected) {
      if (!await this.getLessonFile(args.ownerId, args.fileId)) throw new Error("lesson_file_not_found");
      throw new DocumentPatchError("stale_document", "教案版本已经变化");
    }
    return (await this.getLessonFile(args.ownerId, args.fileId))!;
  }

  private async replay<T>(ownerId: string, operation: string, idempotencyKey: string, expected: string) {
    const result = await this.database.query<{ request_fingerprint: string; response_json: string }>({ sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = ? AND idempotency_key = ?", params: [ownerId, operation, idempotencyKey] });
    const record = result.rows[0]; if (!record) return null;
    if (record.request_fingerprint !== expected) throw new Error("idempotency_conflict");
    return JSON.parse(record.response_json) as T;
  }

  private storeReplay(ownerId: string, operation: string, idempotencyKey: string, requestFingerprint: string, response: unknown, timestamp: string) {
    return [{ sql: "INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", params: [ownerId, operation, idempotencyKey, requestFingerprint, JSON.stringify(response), timestamp] }];
  }

  /**
   * A lesson file is not independently runnable: the immutable version-zero
   * snapshot and its design basis are part of the same aggregate. Resolve all
   * optional framework context before the write, then persist the aggregate in
   * one database batch so Pi never observes a half-created lesson.
   */
  private async prepareInitialDesignBasis(ownerId: string, file: LessonFileRecord): Promise<InitialDesignBasis> {
    const basisId = crypto.randomUUID();
    if (!file.lessonBlueprintId) return { id: basisId, statements: [] };

    const context = await this.database.query<BlueprintContextRow>({
      sql: `SELECT framework.id AS framework_id, blueprint.semester_unit_id, blueprint.id AS lesson_blueprint_id,
        framework.catalog_release_id, framework.textbook_id, blueprint.curriculum_node_id,
        framework.semantic_release_id, framework.version AS framework_version, blueprint.version AS blueprint_version
        FROM lesson_blueprints blueprint
        JOIN semester_frameworks framework ON framework.owner_id = blueprint.owner_id AND framework.id = blueprint.framework_id
        WHERE blueprint.owner_id = ? AND blueprint.id = ? AND framework.notebook_id = ?
        LIMIT 1`,
      params: [ownerId, file.lessonBlueprintId, file.notebookId],
    });
    const blueprint = context.rows[0];
    if (!blueprint) throw new Error("lesson_blueprint_scope_invalid");

    const selections = await this.database.query<OutcomeSelectionRow>({
      sql: `SELECT selection.semantic_entity_id, entity.canonical_name, selection.adjustment_reason, selection.teacher_confirmed
        FROM framework_outcome_selections selection
        LEFT JOIN curriculum_semantic_entity_revisions entity
          ON entity.release_id = selection.semantic_release_id AND entity.semantic_entity_id = selection.semantic_entity_id
        WHERE selection.owner_id = ? AND selection.framework_id = ? AND selection.lesson_blueprint_id = ?
        ORDER BY selection.priority, selection.created_at, selection.id`,
      params: [ownerId, blueprint.framework_id, blueprint.lesson_blueprint_id],
    });

    const basisStatement: SqlStatement = {
      sql: `INSERT INTO lesson_design_bases (id, owner_id, notebook_id, lesson_file_id, framework_id, semester_unit_id,
        lesson_blueprint_id, catalog_release_id, textbook_id, curriculum_node_id, semantic_release_id,
        source_framework_version, source_blueprint_version, learner_context_json, teacher_notes, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'draft', 0, ?, ?)`,
      params: [basisId, ownerId, file.notebookId, file.id, blueprint.framework_id, blueprint.semester_unit_id,
        blueprint.lesson_blueprint_id, blueprint.catalog_release_id, blueprint.textbook_id, blueprint.curriculum_node_id,
        blueprint.semantic_release_id, blueprint.framework_version, blueprint.blueprint_version,
        JSON.stringify(file.contextProfile), file.updatedAt, file.updatedAt],
    };
    const entryStatements = selections.rows.map((selection, index): SqlStatement => ({
      sql: `INSERT INTO lesson_design_basis_entries (id, owner_id, basis_id, kind, semantic_entity_id, semantic_entity_name,
        related_semantic_entity_id, related_semantic_entity_name, related_curriculum_node_id, related_curriculum_node_title,
        statement, rationale, evidence_json, decision, teacher_confirmed, origin, sort_no, version, created_at, updated_at)
        VALUES (?, ?, ?, 'knowledge_point', ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', 'accepted', ?, 'platform', ?, 0, ?, ?)`,
      params: [crypto.randomUUID(), ownerId, basisId, selection.semantic_entity_id, selection.canonical_name,
        selection.canonical_name
          ? `将“${selection.canonical_name}”作为本课需要落实的学习内容。`
          : "落实课时蓝图中已选择的学习内容。",
        selection.adjustment_reason, selection.teacher_confirmed ? 1 : 0, index + 1, file.updatedAt, file.updatedAt],
    }));
    return { id: basisId, statements: [basisStatement, ...entryStatements] };
  }
}

const selectNotebook = "SELECT id, owner_id, title, class_name, year, subject, stage, grade, edition, tone, updated_at FROM notebooks";
const selectFile = "SELECT id, owner_id, notebook_id, lesson_blueprint_id, title, type, image, document_json, context_profile_json, document_version, page_count, updated_at FROM lesson_files";
const generationIntentSelect = "SELECT id, owner_id, lesson_file_id, prompt, state, run_id, created_at, claimed_at FROM lesson_generation_intents";
const notebook = (row: NotebookRow): NotebookRecord => ({ id: row.id, ownerId: row.owner_id, title: row.title, className: row.class_name, year: row.year, subject: row.subject, stage: row.stage, grade: row.grade, edition: row.edition, tone: row.tone, updatedAt: row.updated_at });
const file = (row: FileRow): LessonFileRecord => ({ id: row.id, ownerId: row.owner_id, notebookId: row.notebook_id, lessonBlueprintId: row.lesson_blueprint_id ?? undefined, title: row.title, type: row.type, image: row.image ?? undefined, document: JSON.parse(row.document_json) as LessonPlan, contextProfile: JSON.parse(row.context_profile_json) as LessonContextProfile, documentVersion: row.document_version, pageCount: row.page_count, updatedAt: row.updated_at });
const generationIntent = (row: GenerationIntentRow): LessonGenerationIntentRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  lessonFileId: row.lesson_file_id,
  prompt: row.prompt,
  state: row.state,
  runId: row.run_id ?? undefined,
  createdAt: row.created_at,
  claimedAt: row.claimed_at ?? undefined,
});
const generationIntentInsert = (intent: LessonGenerationIntentRecord): SqlStatement => ({
  sql: `INSERT INTO lesson_generation_intents (id, owner_id, lesson_file_id, prompt, state, run_id, created_at, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [intent.id, intent.ownerId, intent.lessonFileId, intent.prompt, intent.state,
    intent.runId ?? null, intent.createdAt, intent.claimedAt ?? null],
});
const fileSummary = (row: FileRow) => { const value = file(row); const { document, contextProfile: _contextProfile, ...summary } = value; return { ...summary, preview: createLessonPlanPreview(document) }; };
const fileParams = (value: LessonFileRecord, createdAt: string) => [value.id, value.ownerId, value.notebookId, value.lessonBlueprintId ?? null, value.title, value.type, value.image ?? null, JSON.stringify(value.document), JSON.stringify(value.contextProfile), value.documentVersion, value.pageCount, createdAt, value.updatedAt];
const initialFileInvariantStatements = (args: {
  ownerId: string;
  fileId: string;
  notebookId: string;
  document: LessonPlan;
  documentVersion: number;
  pageCount: number;
  contextProfile: LessonContextProfile;
  createdAt: string;
  basisId: string;
  designBasis?: SqlStatement[];
}): SqlStatement[] => [
  {
    sql: `INSERT INTO lesson_file_versions (id, owner_id, lesson_file_id, document_version, document_json, page_count, actor, run_id, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'import', NULL, ?, ?)
      ON CONFLICT(owner_id, lesson_file_id, document_version) DO NOTHING`,
    params: [crypto.randomUUID(), args.ownerId, args.fileId, args.documentVersion, JSON.stringify(args.document), args.pageCount, `initial-file:${args.fileId}`, args.createdAt],
  },
  ...(args.designBasis?.length
    ? args.designBasis
    : [{
      sql: `INSERT INTO lesson_design_bases (id, owner_id, notebook_id, lesson_file_id, framework_id, semester_unit_id,
        lesson_blueprint_id, catalog_release_id, textbook_id, curriculum_node_id, semantic_release_id,
        source_framework_version, source_blueprint_version, learner_context_json, teacher_notes, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, '', 'draft', 0, ?, ?)
        ON CONFLICT(owner_id, lesson_file_id) DO NOTHING`,
      params: [args.basisId, args.ownerId, args.notebookId, args.fileId, JSON.stringify(args.contextProfile), args.createdAt, args.createdAt],
    }]),
];
const fingerprintOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
