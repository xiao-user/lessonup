import { createHash } from "node:crypto";
import type { LessonRepository } from "../repository.js";
import {
  learningEvidenceInputSchema, learningInquiryActionSchema, learningInquiryInputSchema,
  learningReadQuerySchema,
  type LearningCommand, type LearningEvidence, type LearningInquiry, type LearningReview,
} from "./domain.js";

type Scope = { ownerId: string; lessonFileId: string };
type Origin = { runId: string; threadId: string; branchId: string };

/** Teacher decisions and evidence are facts; model recommendations remain proposals. */
export class LearningService {
  constructor(private readonly repository: LessonRepository, private readonly clock = () => new Date().toISOString()) {}

  private command(scope: Scope, operation: string, input: unknown, idempotencyKey: string): LearningCommand {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("learning_command_key_invalid");
    return { idempotencyKey, fingerprint: createHash("sha256").update(JSON.stringify({ scope, operation, input })).digest("hex") };
  }
  private async file(scope: Scope) {
    const file = await this.repository.getLessonFileContext(scope.ownerId, scope.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    return file;
  }
  private async origin(scope: Scope, origin?: Origin) {
    if (!origin) return;
    const [run, thread, branch] = await Promise.all([
      this.repository.getRun(scope.ownerId, origin.runId),
      this.repository.getThread(scope.ownerId, origin.threadId),
      this.repository.getBranch(scope.ownerId, origin.threadId, origin.branchId),
    ]);
    if (!run || !thread || !branch || thread.resourceType !== "lesson_file"
      || thread.lessonFileId !== scope.lessonFileId || run.threadId !== thread.id || run.branchId !== branch.id
      || run.status !== "running") throw new Error("learning_scope_invalid");
  }
  async read(scope: Scope, rawQuery: unknown = {}) {
    const query = learningReadQuerySchema.parse(rawQuery);
    const file = await this.file(scope);
    const [evidence, inquiries] = await Promise.all([
      this.repository.listLearningEvidence(scope.ownerId, file.id, 41, query.evidenceBefore),
      this.repository.listLearningInquiries(scope.ownerId, file.id, 25, query.inquiriesBefore),
    ]);
    const visibleInquiries = await Promise.all(inquiries.slice(0, 24).map(async (inquiry) => {
      if (!inquiry.proposedReview?.sourceRunId) return inquiry;
      const run = await this.repository.getRun(scope.ownerId, inquiry.proposedReview.sourceRunId);
      return run?.status === "completed" ? inquiry : { ...inquiry, proposedReview: undefined };
    }));
    return {
      evidence: evidence.slice(0, 40), inquiries: visibleInquiries,
      truncated: { evidence: evidence.length > 40, inquiries: inquiries.length > 24 },
      next: {
        evidence: evidence.length > 40 ? { at: evidence[39]!.observedAt, id: evidence[39]!.id } : null,
        inquiries: inquiries.length > 24 ? { at: inquiries[23]!.updatedAt, id: inquiries[23]!.id } : null,
      },
      boundary: "教师记录与复测只支持本班本次判断；采用方案不是实施，后测符合预期也不证明因果效果。",
    };
  }
  async readContext(scope: Scope, focus: { evidenceId?: string; inquiryId?: string }) {
    const file = await this.repository.getLessonFile(scope.ownerId, scope.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    let inquiry = focus.inquiryId ? await this.requireInquiry(scope, focus.inquiryId) : null;
    if (inquiry?.sourceRunId && (await this.repository.getRun(scope.ownerId, inquiry.sourceRunId))?.status !== "completed") throw new Error("learning_proposal_not_delivered");
    if (inquiry?.proposedReview?.sourceRunId && (await this.repository.getRun(scope.ownerId, inquiry.proposedReview.sourceRunId))?.status !== "completed") {
      inquiry = { ...inquiry, proposedReview: undefined };
    }
    const ids = [...new Set([focus.evidenceId, inquiry?.baselineEvidenceId, inquiry?.review?.evidenceId, inquiry?.proposedReview?.evidenceId].filter((id): id is string => Boolean(id)))];
    const evidence = await Promise.all(ids.map(async (id) => {
      const record = await this.repository.getLearningEvidence(scope.ownerId, id);
      if (!record || record.lessonFileId !== scope.lessonFileId) throw new Error("learning_evidence_scope_invalid");
      return record;
    }));
    return { inquiry, evidence, lesson: { documentVersion: file.documentVersion, topic: file.document.topic,
      objectives: file.document.objectives, process: file.document.process, assessment: file.document.assessment } };
  }
  async commandResult(scope: Scope, idempotencyKey: string) {
    await this.file(scope);
    const record = await this.repository.getLearningCommandResult(scope.ownerId, idempotencyKey);
    if (record && record.lessonFileId !== scope.lessonFileId) throw new Error("learning_scope_invalid");
    return record;
  }
  async recordEvidence(scope: Scope, raw: unknown, idempotencyKey: string): Promise<LearningEvidence> {
    const input = learningEvidenceInputSchema.parse(raw);
    const command = this.command(scope, "evidence", input, idempotencyKey);
    const file = await this.file(scope);
    const replay = await this.repository.replayLearningCommand(scope.ownerId, command);
    if (replay) return replay as LearningEvidence;
    if (file.documentVersion !== input.documentVersion) throw new Error("stale_document");
    if (Date.parse(input.observedAt) > Date.parse(this.clock()) + 60_000) throw new Error("learning_observation_in_future");
    if (input.inquiryId) {
      const inquiry = await this.requireInquiry(scope, input.inquiryId);
      if (inquiry.state !== "implemented") throw new Error("learning_inquiry_not_implemented");
      if (Date.parse(input.observedAt) < Date.parse(inquiry.implementedAt!)) throw new Error("learning_evidence_before_implementation");
      command.inquiryVersion = inquiry.version;
    }
    return this.repository.saveLearningEvidence({ ...input, observedAt: new Date(input.observedAt).toISOString(), id: crypto.randomUUID(), ownerId: scope.ownerId,
      notebookId: file.notebookId, lessonFileId: file.id, createdAt: this.clock() }, { ...command, documentVersion: file.documentVersion });
  }
  async propose(scope: Scope, raw: unknown, idempotencyKey: string, origin?: Origin): Promise<LearningInquiry> {
    const input = learningInquiryInputSchema.parse(raw);
    const command = this.command(scope, "inquiry", { input, origin }, idempotencyKey);
    const file = await this.file(scope);
    const replay = await this.repository.replayLearningCommand(scope.ownerId, command);
    if (replay) return replay as LearningInquiry;
    await this.origin(scope, origin);
    if (file.documentVersion !== input.documentVersion) throw new Error("stale_document");
    const baseline = await this.repository.getLearningEvidence(scope.ownerId, input.baselineEvidenceId);
    if (!baseline || baseline.lessonFileId !== file.id || baseline.notebookId !== file.notebookId) {
      throw new Error("learning_evidence_scope_invalid");
    }
    const now = this.clock();
    return this.repository.saveLearningInquiry({ ...input, id: crypto.randomUUID(), ownerId: scope.ownerId,
      notebookId: file.notebookId, lessonFileId: file.id, state: "proposed", version: 0,
      sourceRunId: origin?.runId, createdAt: now, updatedAt: now }, null, { ...command, documentVersion: file.documentVersion });
  }
  private async requireInquiry(scope: Scope, id: string) {
    const inquiry = await this.repository.getLearningInquiry(scope.ownerId, id);
    if (!inquiry || inquiry.lessonFileId !== scope.lessonFileId) throw new Error("learning_inquiry_not_found");
    return inquiry;
  }
  private async validateReview(scope: Scope, inquiry: LearningInquiry, review: LearningReview) {
    const [baseline, followup] = await Promise.all([
      this.repository.getLearningEvidence(scope.ownerId, inquiry.baselineEvidenceId),
      this.repository.getLearningEvidence(scope.ownerId, review.evidenceId),
    ]);
    if (!baseline || !followup || followup.lessonFileId !== scope.lessonFileId || followup.inquiryId !== inquiry.id
      || followup.id === baseline.id || Date.parse(followup.observedAt) < Date.parse(inquiry.implementedAt!)) {
      throw new Error("learning_evidence_scope_invalid");
    }
    const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");
    const comparable = ["objective", "criterion", "learnerGroup"].every((key) => (
      normalize(baseline[key as "objective" | "criterion" | "learnerGroup"]) === normalize(followup[key as "objective" | "criterion" | "learnerGroup"])
    ));
    if (!comparable && review.outcome !== "inconclusive") throw new Error("learning_evidence_not_comparable");
  }
  async act(scope: Scope, inquiryId: string, raw: unknown, idempotencyKey: string, origin?: Origin): Promise<LearningInquiry> {
    const input = learningInquiryActionSchema.parse(raw);
    if (origin && input.action !== "propose_review") throw new Error("learning_teacher_decision_required");
    const command = this.command(scope, "action", { inquiryId, input, origin }, idempotencyKey);
    const file = await this.file(scope);
    const replay = await this.repository.replayLearningCommand(scope.ownerId, command);
    if (replay) return replay as LearningInquiry;
    await this.origin(scope, origin);
    const current = await this.requireInquiry(scope, inquiryId);
    if (current.version !== input.expectedVersion) throw new Error("stale_learning_inquiry");
    const next = { ...current, version: current.version + 1, updatedAt: this.clock() };
    if (input.action === "adopt") {
      if (current.sourceRunId && (await this.repository.getRun(scope.ownerId, current.sourceRunId))?.status !== "completed") throw new Error("learning_proposal_not_delivered");
      if (current.state !== "proposed") throw new Error("learning_transition_invalid");
      if (file.documentVersion !== current.documentVersion) throw new Error("stale_document");
      next.state = "adopted"; next.adoptedAt = next.updatedAt;
      command.documentVersion = file.documentVersion;
    } else if (input.action === "implement") {
      if (current.state !== "adopted") throw new Error("learning_transition_invalid");
      const implementedAt = input.implementedAt ? new Date(input.implementedAt).toISOString() : next.updatedAt;
      const baseline = await this.repository.getLearningEvidence(scope.ownerId, current.baselineEvidenceId);
      if (!baseline || Date.parse(implementedAt) < Date.parse(baseline.observedAt)
        || Date.parse(implementedAt) > Date.parse(next.updatedAt) + 60_000) throw new Error("learning_implementation_time_invalid");
      next.state = "implemented"; next.implementedAt = implementedAt; next.implementedDocumentVersion = file.documentVersion;
    } else if (input.action === "dismiss") {
      if (!["proposed", "adopted"].includes(current.state)) throw new Error("learning_transition_invalid");
      next.state = "dismissed";
    } else {
      if (current.state !== "implemented") throw new Error("learning_transition_invalid");
      if (!("review" in input)) throw new Error("learning_transition_invalid");
      await this.validateReview(scope, current, input.review);
      if (input.action === "propose_review") next.proposedReview = { ...input.review, sourceRunId: origin?.runId };
      else { next.state = "reviewed"; next.review = input.review; next.reviewedAt = next.updatedAt; }
    }
    return this.repository.saveLearningInquiry(next, current.version, command);
  }
}
