import type { LessonRepository } from "../repository.js";
import type { DirectClassroomPresentationRecord } from "./domain.js";

/**
 * Read-only presentation boundary used by the Worker until Dashi is moved to
 * its own renderer. It never starts a native process and never pretends an
 * editable deck can be served without that renderer.
 */
export class UnavailablePresentationService {
  constructor(private readonly repository: LessonRepository) {}

  async getGeneration(ownerId: string, lessonFileId: string) {
    return this.repository.getLatestClassroomPresentationGeneration(ownerId, lessonFileId);
  }

  async list(ownerId: string, lessonFileId: string) {
    return (await this.repository.listClassroomPresentations(ownerId, lessonFileId))
      .filter(isNativeDashiPresentation);
  }

  async listForOwner(ownerId: string) {
    return (await this.repository.listClassroomPresentationsForOwner(ownerId))
      .filter(isNativeDashiPresentation);
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

  async createAccess(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
  async remove(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
  async previewUrlFor(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
  async syncNativeEdits(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
  async saveBrowserDeck(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
  async getBrowserDeck(): Promise<never> { throw new Error("presentation_renderer_unavailable"); }
}

function isNativeDashiPresentation(presentation: DirectClassroomPresentationRecord) {
  return presentation.delivery === "native-dashi" && presentation.dashiGoal !== null;
}
