import type { AgentApprovalRecord } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { publicAgentError } from "../agent/public-error.js";

/** Shared public projection for snapshot and approval-list reads. */
export async function publicApproval(repository: LessonRepository, approval: AgentApprovalRecord) {
  const patch = approval.patch;
  const isPresentation = "kind" in patch && patch.kind === "presentation_storyboard";
  const presentation = approval.state === "approved" && isPresentation
    ? await repository.findClassroomPresentationByRequest(approval.ownerId, `approval:${approval.id}`)
    : null;
  const delivered = presentation && isPresentation && presentation.lessonFileId === patch.fileId;
  return {
    id: approval.id,
    runId: approval.runId,
    assistantMessageId: approval.assistantMessageId,
    toolCallId: approval.toolCallId,
    state: approval.state,
    continuationStatus: approval.continuationStatus,
    continuationError: approval.continuationError
      ? publicAgentError(approval.continuationError, "approval_resume_failed") : undefined,
    continuationMessageId: approval.continuationMessageId,
    delivery: delivered ? { status: "ready" as const, presentationId: presentation.id } : undefined,
    patch: approval.patch,
    expiresAt: approval.expiresAt,
    createdAt: approval.createdAt,
  };
}
