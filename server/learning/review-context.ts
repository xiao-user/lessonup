import type { LearningEvidence, LearningInquiry, LearningReviewContext } from "./domain.js";

/** Project finalized teacher judgment; unfinished model recommendations stay out. */
export function learningReviewContext(inquiry: LearningInquiry, baseline: LearningEvidence, followup: LearningEvidence): LearningReviewContext {
  if (inquiry.state !== "reviewed" || !inquiry.review || !inquiry.implementedAt || inquiry.implementedDocumentVersion === undefined
    || baseline.ownerId !== inquiry.ownerId || followup.ownerId !== inquiry.ownerId
    || baseline.lessonFileId !== inquiry.lessonFileId || followup.lessonFileId !== inquiry.lessonFileId
    || baseline.id !== inquiry.baselineEvidenceId || followup.id !== inquiry.review.evidenceId || followup.inquiryId !== inquiry.id) {
    throw new Error("learning_evidence_scope_invalid");
  }
  return { inquiryId: inquiry.id, lessonFileId: inquiry.lessonFileId, hypothesis: inquiry.hypothesis,
    alternativeExplanation: inquiry.alternativeExplanation, intervention: inquiry.intervention,
    expectedSignal: inquiry.expectedSignal, checkPlan: inquiry.checkPlan,
    implementedAt: inquiry.implementedAt, implementedDocumentVersion: inquiry.implementedDocumentVersion,
    review: inquiry.review, baseline, followup };
}
