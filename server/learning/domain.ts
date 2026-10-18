import { z } from "zod";
import { isSyntheticObservation, OBSERVATION_METHODS } from "./observation-plan.js";

const text = (max = 2_000) => z.string().trim().min(1).max(max);
export const learningEvidenceInputSchema = z.object({
  documentVersion: z.number().int().nonnegative(),
  objective: text(500), task: text(), criterion: text(1_000),
  learnerGroup: text(300), observation: text(4_000),
  method: z.enum(OBSERVATION_METHODS),
  observedAt: z.iso.datetime(), sourceReference: text(1_000),
  conditions: z.string().trim().max(1_000).optional(),
  synthetic: z.boolean().optional(),
  decisionId: z.string().uuid().optional(),
  decisionVersion: z.number().int().nonnegative().optional(),
  sampleSize: z.number().int().min(1).max(10_000).optional(),
  meetingCriterion: z.number().int().nonnegative().optional(),
  inquiryId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.synthetic === false && isSyntheticObservation(value)) {
    context.addIssue({ code: "custom", path: ["synthetic"], message: "synthetic_observation_declaration_conflict" });
  }
  if (value.method === "document_check" && (value.sampleSize !== undefined || value.meetingCriterion !== undefined)) {
    context.addIssue({ code: "custom", path: ["sampleSize"], message: "document_check_has_no_student_counts" });
  }
  if (value.decisionId && (value.decisionVersion === undefined || value.synthetic === undefined)) {
    context.addIssue({ code: "custom", path: ["decisionId"], message: "decision_observation_context_required" });
  }
  if (!value.decisionId && value.decisionVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["decisionVersion"], message: "decision_observation_context_invalid" });
  }
  if (value.decisionId && value.inquiryId) {
    context.addIssue({ code: "custom", path: ["decisionId"], message: "learning_evidence_multiple_workflows" });
  }
  if (value.meetingCriterion !== undefined && (value.sampleSize === undefined || value.meetingCriterion > value.sampleSize)) {
    context.addIssue({ code: "custom", path: ["meetingCriterion"], message: "invalid_evidence_counts" });
  }
});
export type LearningEvidenceInput = z.infer<typeof learningEvidenceInputSchema>;
export type LearningEvidence = LearningEvidenceInput & {
  id: string; ownerId: string; notebookId: string; lessonFileId: string; createdAt: string;
  decisionVersion?: number;
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
export type LearningCommand = { idempotencyKey: string; fingerprint: string; documentVersion?: number; inquiryVersion?: number; decisionVersion?: number };
export const learningCursorSchema = z.object({ at: z.iso.datetime(), id: z.string().uuid() }).strict();
export type LearningCursor = z.infer<typeof learningCursorSchema>;
export const learningReadQuerySchema = z.object({
  evidenceBefore: learningCursorSchema.optional(), inquiriesBefore: learningCursorSchema.optional(), decisionId: z.string().uuid().optional(),
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
  listLearningEvidence(ownerId: string, lessonFileId: string, limit: number, before?: LearningCursor, decisionId?: string): Promise<LearningEvidence[]>;
  getLearningEvidence(ownerId: string, evidenceId: string): Promise<LearningEvidence | null>;
  listLearningInquiries(ownerId: string, lessonFileId: string, limit: number, before?: LearningCursor): Promise<LearningInquiry[]>;
  getLearningInquiry(ownerId: string, inquiryId: string): Promise<LearningInquiry | null>;
  getLearningCommandResult(ownerId: string, idempotencyKey: string): Promise<LearningRecord | null>;
  replayLearningCommand(ownerId: string, command: LearningCommand): Promise<LearningRecord | null>;
  saveLearningEvidence(record: LearningEvidence, command: LearningCommand): Promise<LearningEvidence>;
  saveLearningInquiry(record: LearningInquiry, expectedVersion: number | null, command: LearningCommand): Promise<LearningInquiry>;
}
