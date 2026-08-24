import type { LessonRepository } from "../repository.js";
import {
  approvedPresentationGoalRequestSchema,
  type ClassroomPresentationGeneration,
  type DirectClassroomPresentationRecord,
} from "./domain.js";
import { NativeDashiPptSkill, type NativeDashiDeck } from "./native-dashi-skill.js";
import { PresentationArtifactStorage } from "./storage.js";
import type { DashiGoal } from "./dashi-goal.js";

export class PresentationService {
  private readonly artifacts: PresentationArtifactStorage;
  private readonly previewUrls = new Map<string, string>();
  constructor(
    private readonly repository: LessonRepository,
    private readonly nativeDashi: Pick<NativeDashiPptSkill, "open" | "remove" | "hasDeck" | "exportBundle" | "importBundle"> = new NativeDashiPptSkill(),
    artifacts = new PresentationArtifactStorage(),
  ) { this.artifacts = artifacts; }

  /**
   * Persist the approved, preflighted Dashi goal before deterministic rendering.
   * No model pass occurs after this boundary.
   */
  async beginApprovedGoalGeneration(
    ownerId: string,
    lessonFileId: string,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<
    | { presentation: DirectClassroomPresentationRecord }
    | { generation: ClassroomPresentationGeneration; presentationId: string }
  > {
    const input = approvedPresentationGoalRequestSchema.parse(rawInput);
    const file = await this.repository.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    if (file.documentVersion !== input.expectedDocumentVersion) throw new Error("stale_document");
    const existing = await this.repository.findClassroomPresentationByRequest(ownerId, idempotencyKey);
    if (existing) return { presentation: existing };
    const notebook = await this.repository.getNotebook(ownerId, file.notebookId);
    if (!notebook) throw new Error("presentation_source_scope_invalid");
    const started = await this.repository.beginClassroomPresentationGeneration(
      this.createGeneration({ ownerId, file, notebook, input }),
    );
    if (!started.created) throw new Error("presentation_generation_in_progress");
    return { generation: started.generation, presentationId: crypto.randomUUID() };
  }

  async completeApprovedGoalGeneration(args: {
    generation: ClassroomPresentationGeneration;
    presentationId: string;
    idempotencyKey: string;
    goal: DashiGoal;
    deck: NativeDashiDeck;
  }) {
    const { generation, presentationId, idempotencyKey, goal, deck } = args;
    const timestamp = new Date().toISOString();
    const bundle = await this.nativeDashi.exportBundle(presentationId)
      .catch((error) => { throw stagedPresentationError("presentation_bundle_export_failed", error); });
    const stored = this.artifacts.configured
      ? await this.artifacts.save(generation.ownerId, presentationId, bundle)
        .catch((error) => { throw stagedPresentationError("presentation_storage_upload_failed", error); })
      : { storageKey: `native-dashi/${deck.deckKey}`, byteSize: bundle.byteSize };
    const presentation: DirectClassroomPresentationRecord = {
      id: presentationId,
      ownerId: generation.ownerId,
      notebookId: generation.notebookId,
      lessonFileId: generation.lessonFileId,
      title: goal.title,
      theme: goal.themePack,
      sourceDocumentVersion: generation.sourceDocumentVersion,
      sourceDocument: structuredClone(generation.sourceDocument),
      dashiGoal: goal,
      delivery: "native-dashi",
      storageKey: stored.storageKey,
      mediaType: "text/html; charset=utf-8",
      byteSize: stored.byteSize,
      checksum: deck.checksum,
      idempotencyKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await this.repository.saveClassroomPresentation(presentation)
      .catch((error) => { throw stagedPresentationError("presentation_metadata_save_failed", error); });
    const previous = await this.repository.listClassroomPresentations(
      generation.ownerId,
      generation.lessonFileId,
    );
    await Promise.all(previous
      .filter((item) => item.id !== saved.id)
      .map(async (item) => {
        if (this.artifacts.configured) {
          await this.artifacts.remove(generation.ownerId, item.id, item.storageKey).catch(() => undefined);
        }
        await this.repository.deleteClassroomPresentation(generation.ownerId, item.id).catch(() => undefined);
        this.previewUrls.delete(item.id);
        await this.nativeDashi.remove(item.id).catch(() => undefined);
      }));
    await this.repository.completeClassroomPresentationGeneration({
      ownerId: generation.ownerId,
      generationId: generation.id,
      presentationId: saved.id,
      completedAt: timestamp,
      durationMs: this.generationDuration(generation.startedAt, timestamp),
    });
    return saved;
  }

  async failApprovedGoalGeneration(
    generation: ClassroomPresentationGeneration,
    error: unknown,
  ) {
    const completedAt = new Date().toISOString();
    await this.repository.failClassroomPresentationGeneration({
      ownerId: generation.ownerId,
      generationId: generation.id,
      errorCode: this.generationErrorCode(error),
      completedAt,
      durationMs: this.generationDuration(generation.startedAt, completedAt),
    });
  }

  async getGeneration(ownerId: string, lessonFileId: string) {
    return this.repository.getLatestClassroomPresentationGeneration(ownerId, lessonFileId);
  }

  /** Called before the API begins accepting work after a process restart. */
  async recoverInterruptedGenerations(completedAt = new Date().toISOString()) {
    return this.repository.recoverInterruptedClassroomPresentationGenerations(completedAt);
  }

  private createGeneration({
    ownerId,
    file,
    notebook,
    input,
  }: {
    ownerId: string;
    file: NonNullable<Awaited<ReturnType<LessonRepository["getLessonFile"]>>>;
    notebook: NonNullable<Awaited<ReturnType<LessonRepository["getNotebook"]>>>;
    input: ReturnType<typeof approvedPresentationGoalRequestSchema.parse>;
  }): ClassroomPresentationGeneration {
    return {
      id: crypto.randomUUID(),
      ownerId,
      notebookId: notebook.id,
      lessonFileId: file.id,
      sourceDocumentVersion: file.documentVersion,
      sourceDocument: structuredClone(file.document),
      lessonTitle: file.document.topic || file.title,
      subject: notebook.subject,
      gradeLevel: file.contextProfile.gradeLevel ?? "",
      learnerProfile: file.contextProfile.learnerProfile ?? "",
      lessonDurationMinutes: file.contextProfile.lessonDurationMinutes ?? 40,
      goal: structuredClone(input.goal),
      status: "generating",
      presentationId: null,
      errorCode: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
    };
  }

  private generationDuration(startedAt: string, completedAt: string) {
    return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  }

  private generationErrorCode(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    return [
      "stale_document",
      "presentation_source_scope_invalid",
      "presentation_generation_in_progress",
      "presentation_cancelled",
      "presentation_bundle_export_failed",
      "presentation_storage_upload_failed",
      "presentation_metadata_save_failed",
    ]
      .includes(message)
      ? message
      : "presentation_generation_failed";
  }

  async list(ownerId: string, lessonFileId: string) {
    const presentations = await this.repository.listClassroomPresentations(ownerId, lessonFileId);
    return presentations.filter((presentation) => (
      presentation.delivery === "native-dashi" && presentation.dashiGoal !== null
    ));
  }

  async listForOwner(ownerId: string) {
    const presentations = await this.repository.listClassroomPresentationsForOwner(ownerId);
    return presentations.filter((presentation) => presentation.delivery === "native-dashi" && presentation.dashiGoal !== null);
  }

  async get(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) return null;
    const file = await this.repository.getLessonFile(ownerId, presentation.lessonFileId);
    if (!file || file.notebookId !== presentation.notebookId) return null;
    return {
      presentation,
      source: {
        generatedFromDocumentVersion: presentation.sourceDocumentVersion,
        currentDocumentVersion: file.documentVersion,
        stale: presentation.sourceDocumentVersion !== file.documentVersion,
      },
    };
  }

  async createAccess(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    if (presentation.delivery !== "native-dashi" || !presentation.dashiGoal) {
      throw new Error("presentation_native_deck_missing");
    }
    const url = await this.previewUrlFor(presentation);
    return {
      url,
      expiresInSeconds: 0,
      mediaType: presentation.mediaType,
      filename: "index.html",
    };
  }

  async remove(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    // Storage deletion is part of the deletion contract. Do it before the row
    // is removed so a failed object-store operation never becomes a fake UI-only
    // delete. The local Dashi checkout is merely a cache and is cleaned last.
    if (this.artifacts.configured) await this.artifacts.remove(ownerId, presentation.id, presentation.storageKey);
    await this.repository.deleteClassroomPresentation(ownerId, presentationId);
    this.previewUrls.delete(presentation.id);
    await this.nativeDashi.remove(presentation.id).catch(() => undefined);
  }

  /** Proxy callers use this stable native URL; it is never exposed to browsers. */
  async previewUrlFor(presentation: DirectClassroomPresentationRecord) {
    const active = this.previewUrls.get(presentation.id);
    if (active) return active;
    if (!await this.nativeDashi.hasDeck(presentation.id)) {
      if (!this.artifacts.configured) throw new Error("presentation_native_deck_missing");
      await this.nativeDashi.importBundle(
        presentation.id,
        await this.artifacts.load(presentation.ownerId, presentation.id, presentation.storageKey),
      );
    }
    const url = await this.nativeDashi.open(presentation.id);
    this.previewUrls.set(presentation.id, url);
    return url;
  }

  /** Called only after Dashi's native save endpoint has accepted an edit. */
  async syncNativeEdits(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    if (!this.artifacts.configured) return;
    const bundle = await this.nativeDashi.exportBundle(presentation.id);
    const stored = await this.artifacts.save(ownerId, presentation.id, bundle);
    await this.repository.updateClassroomPresentationArtifact({
      ownerId,
      presentationId: presentation.id,
      storageKey: stored.storageKey,
      byteSize: stored.byteSize,
      updatedAt: new Date().toISOString(),
    });
  }
}

/** Keep the browser-facing reason stable while retaining the real cause on the server. */
function stagedPresentationError(code: string, cause: unknown) {
  return new Error(code, { cause });
}
