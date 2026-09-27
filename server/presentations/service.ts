import type { LessonRepository } from "../repository.js";
import {
  approvedPresentationGoalRequestSchema,
  type ClassroomPresentationGeneration,
  type DirectClassroomPresentationRecord,
} from "./domain.js";
import { PresentationArtifactStorage } from "./storage.js";
import { createHash } from "node:crypto";
import { dashiGoalSchema, type DashiGoal } from "./dashi-goal.js";
import type { DashiDeckWorkspace, NativeDashiDeck } from "./dashi-skill-port.js";
import type { ObjectStorage } from "../platform/object-storage.js";
import { browserDeckToGoal, goalToBrowserDeck, type BrowserDeck } from "../../src/lib/dashi-browser/goal-to-deck.js";

export class PresentationService {
  private readonly artifacts: PresentationArtifactStorage;
  private readonly previewUrls = new Map<string, string>();
  constructor(
    private readonly repository: LessonRepository,
    private readonly nativeDashi: DashiDeckWorkspace,
    storage: ObjectStorage | null = null,
  ) { this.artifacts = new PresentationArtifactStorage(storage); }

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
    // An idempotent retry acknowledges the artifact already committed by the
    // original approval. It must not be invalidated by later document edits.
    const existing = await this.repository.findClassroomPresentationByRequest(ownerId, idempotencyKey);
    if (existing) {
      if (existing.lessonFileId !== lessonFileId) throw new Error("presentation_source_scope_invalid");
      return { presentation: existing };
    }
    const file = await this.repository.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    if (file.documentVersion !== input.expectedDocumentVersion) throw new Error("stale_document");
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
      .catch(async (error) => {
        if (this.artifacts.configured) {
          await this.artifacts.remove(generation.ownerId, presentationId, stored.storageKey).catch(() => undefined);
        }
        await this.nativeDashi.remove(presentationId).catch(() => undefined);
        throw stagedPresentationError("presentation_metadata_save_failed", error);
      });
    // Saving the artifact and settling its generation are the delivery path.
    // Pruning superseded decks is housekeeping and must not turn a successful
    // library commit into a teacher-visible failure.
    await this.repository.completeClassroomPresentationGeneration({
      ownerId: generation.ownerId,
      generationId: generation.id,
      presentationId: saved.id,
      completedAt: timestamp,
      durationMs: this.generationDuration(generation.startedAt, timestamp),
    });
    await this.pruneSupersededPresentations(saved).catch(() => undefined);
    return saved;
  }

  private async pruneSupersededPresentations(saved: DirectClassroomPresentationRecord) {
    const previous = await this.repository.listClassroomPresentations(saved.ownerId, saved.lessonFileId);
    await Promise.all(previous
      .filter((item) => item.id !== saved.id)
      .map(async (item) => {
        if (this.artifacts.configured) {
          await this.artifacts.remove(saved.ownerId, item.id, item.storageKey).catch(() => undefined);
        }
        await this.repository.deleteClassroomPresentation(saved.ownerId, item.id).catch(() => undefined);
        this.previewUrls.delete(item.id);
        await this.nativeDashi.remove(item.id).catch(() => undefined);
      }));
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

  /**
   * Persist browser edits back into the D1-canonical Dashi goal. The checksum is
   * an optimistic concurrency boundary: two tabs can never silently overwrite
   * one another, and the browser is not allowed to change the approved theme,
   * layout sequence, or slide count through this state endpoint.
   */
  async saveBrowserDeck(
    ownerId: string,
    presentationId: string,
    input: { expectedChecksum: string; deck: unknown },
  ) {
    const current = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!current?.dashiGoal || current.delivery !== "native-dashi") {
      throw new Error(current ? "presentation_native_deck_missing" : "presentation_not_found");
    }
    if (current.checksum !== input.expectedChecksum) throw new Error("presentation_edit_conflict");
    await this.ensureNativeWorkspace(current);
    const goal = dashiGoalSchema.parse(browserDeckToGoal(
      input.deck as Parameters<typeof browserDeckToGoal>[0],
      current.dashiGoal,
    ));
    const checksum = createHash("sha256").update(JSON.stringify({ goal, deck: input.deck })).digest("hex");
    if (checksum === current.checksum) return current;
    let stored: { storageKey: string; byteSize: number } | null = null;
    if (this.artifacts.configured) {
      stored = await this.artifacts.saveRevision(
        ownerId,
        presentationId,
        await this.nativeDashi.exportBundle(presentationId, { goal, deck: input.deck as BrowserDeck }),
      );
    }
    const saved = await this.repository.updateClassroomPresentationGoal({
      ownerId,
      presentationId,
      expectedChecksum: input.expectedChecksum,
      goal,
      checksum,
      updatedAt: new Date().toISOString(),
      artifact: stored ?? undefined,
    });
    // Do not delete staged objects on an uncertain database response: the CAS
    // may already have committed. Unreferenced revisions can be collected later.
    return saved;
  }

  async getBrowserDeck(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation?.dashiGoal || presentation.delivery !== "native-dashi") {
      throw new Error(presentation ? "presentation_native_deck_missing" : "presentation_not_found");
    }
    await this.ensureNativeWorkspace(presentation, true);
    const deck = await this.nativeDashi.getBrowserDeck?.(presentationId);
    return deck ?? goalToBrowserDeck(presentation.dashiGoal, { id: presentationId, title: presentation.title });
  }

  private async ensureNativeWorkspace(presentation: DirectClassroomPresentationRecord, refresh = false) {
    if ((!refresh || !this.artifacts.configured) && await this.nativeDashi.hasDeck(presentation.id)) return;
    if (!this.artifacts.configured) throw new Error("presentation_native_deck_missing");
    await this.nativeDashi.importBundle(
      presentation.id,
      await this.artifacts.load(presentation.ownerId, presentation.id, presentation.storageKey),
    );
  }

  async createAccess(ownerId: string, presentationId: string) {
    const presentation = await this.repository.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    if (presentation.delivery !== "native-dashi" || !presentation.dashiGoal) {
      throw new Error("presentation_native_deck_missing");
    }
    return {
      url: `/classroom-presentations/${presentation.id}`,
      expiresInSeconds: 0,
      mediaType: "text/html; charset=utf-8",
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
    await this.ensureNativeWorkspace(presentation);
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
