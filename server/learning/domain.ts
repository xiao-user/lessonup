import { z } from "zod";

const text = (max = 2_000) => z.string().trim().min(1).max(max);
export const learningEvidenceInputSchema = z.object({
  documentVersion: z.number().int().nonnegative(),
  objective: text(500), task: text(), criterion: text(1_000),
  learnerGroup: text(300), observation: text(4_000),
  method: z.enum(["student_work", "assessment", "teacher_observation"]),
  observedAt: z.iso.datetime(), sourceReference: text(1_000),
  sampleSize: z.number().int().min(1).max(10_000).optional(),
  meetingCriterion: z.number().int().nonnegative().optional(),
  inquiryId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.meetingCriterion !== undefined && (value.sampleSize === undefined || value.meetingCriterion > value.sampleSize)) {
    context.addIssue({ code: "custom", path: ["meetingCriterion"], message: "invalid_evidence_counts" });
  }
});
export type LearningEvidenceInput = z.infer<typeof learningEvidenceInputSchema>;
export type LearningEvidence = LearningEvidenceInput & {
  id: string; ownerId: string; notebookId: string; lessonFileId: string; createdAt: string;
};

export const learningInquiryInputSchema = z.object({
  documentVersion: z.number().int().nonnegative(), baselineEvidenceId: z.string().uuid(),
  hypothesis: text(), alternativeExplanation: text(), intervention: text(4_000),
  expectedSignal: text(), checkPlan: text(),
}).strict();
export type LearningInquiryInput = z.infer<typeof learningInquiryInputSchema>;
export const learningReviewSchema = z.object({
  evidenceId: z.string().uuid(), outcome: z.enum(["supported", "not_supported", "inconclusive"]),
  rationale: text(4_000), limitations: text(),
}).strict();
export type LearningReview = z.infer<typeof learningReviewSchema>;
export type LearningInquiry = LearningInquiryInput & {
  id: string; ownerId: string; notebookId: string; lessonFileId: string;
  state: "proposed" | "adopted" | "implemented" | "reviewed" | "dismissed";
  version: number; sourceRunId?: string;
  proposedReview?: LearningReview & { sourceRunId?: string };
  review?: LearningReview;
  adoptedAt?: string; implementedAt?: string; implementedDocumentVersion?: number; reviewedAt?: string;
  createdAt: string; updatedAt: string;
};
export const learningInquiryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["adopt", "dismiss"]), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("implement"), expectedVersion: z.number().int().nonnegative(), implementedAt: z.iso.datetime().optional() }).strict(),
  z.object({ action: z.enum(["review", "propose_review"]), expectedVersion: z.number().int().nonnegative(), review: learningReviewSchema }).strict(),
]);
export type LearningInquiryAction = z.infer<typeof learningInquiryActionSchema>;
export type LearningRecord = LearningEvidence | LearningInquiry;
export type LearningCommand = { idempotencyKey: string; fingerprint: string; documentVersion?: number; inquiryVersion?: number };
export const learningCursorSchema = z.object({ at: z.iso.datetime(), id: z.string().uuid() }).strict();
export type LearningCursor = z.infer<typeof learningCursorSchema>;
export const learningReadQuerySchema = z.object({
  evidenceBefore: learningCursorSchema.optional(), inquiriesBefore: learningCursorSchema.optional(),
}).strict();
export type LearningReviewContext = {
  inquiryId: string; lessonFileId: string; hypothesis: string; alternativeExplanation: string;
  intervention: string; expectedSignal: string; checkPlan: string;
  implementedAt: string; implementedDocumentVersion: number;
  review: LearningReview; baseline: LearningEvidence; followup: LearningEvidence;
};

/** Durable commands and read models, with no platform binding in business code. */
export interface LearningRepository {
  listLearningReviews(ownerId: string, scope: { lessonFileId?: string; lessonBlueprintId?: string; limit: number }): Promise<LearningReviewContext[]>;
  listLearningEvidence(ownerId: string, lessonFileId: string, limit: number, before?: LearningCursor): Promise<LearningEvidence[]>;
  getLearningEvidence(ownerId: string, evidenceId: string): Promise<LearningEvidence | null>;
  listLearningInquiries(ownerId: string, lessonFileId: string, limit: number, before?: LearningCursor): Promise<LearningInquiry[]>;
  getLearningInquiry(ownerId: string, inquiryId: string): Promise<LearningInquiry | null>;
  getLearningCommandResult(ownerId: string, idempotencyKey: string): Promise<LearningRecord | null>;
  replayLearningCommand(ownerId: string, command: LearningCommand): Promise<LearningRecord | null>;
  saveLearningEvidence(record: LearningEvidence, command: LearningCommand): Promise<LearningEvidence>;
  saveLearningInquiry(record: LearningInquiry, expectedVersion: number | null, command: LearningCommand): Promise<LearningInquiry>;
}
