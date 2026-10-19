import type { AgentPendingInteraction } from "../domain.js";
import type { LearningCommand, LearningCursor, LearningEvidence, LearningInquiry, LearningRecord } from "../learning/domain.js";
import type { DecisionCommand, DecisionCursor, DecisionEvent, DecisionRecord, EvidenceCard } from "../decisions/contracts.js";
import { learningReviewContext } from "../learning/review-context.js";
import type { AgentSessionItem as AgentInputItem } from "../repository.js";
import {
  applyDocumentPatch,
  DocumentPatchError,
  rebaseDocumentPatch,
} from "../document-patch.js";
import { assertDesignBasisProjectionCurrent } from "../design-basis-projection.js";
import { defaultClassFeedbackWritebackStatus } from "../curriculum/continuity-adoption.js";
import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentResourceRef,
  AgentRunEvidenceRecord,
  AgentThreadRecord,
  CurriculumCatalogReleaseRecord,
  CurriculumNodeRecord,
  CurriculumNodeSemanticsRecord,
  CurriculumSemanticEntityRecord,
  CurriculumSemanticPathStep,
  CurriculumTextbookRecord,
  CurriculumStandardSearchCacheRecord,
  CreateSemesterFrameworkInput,
  CreateLessonBlueprintInput,
  CreateLessonClassFeedbackInput,
  DeleteLessonBlueprintInput,
  FrameworkContinuityCandidateRecord,
  KnowledgeResult,
  LessonClassFeedbackRecord,
  LessonDesignBasisAggregate,
  LessonDesignBasisPatch,
  LessonGenerationIntentRecord,
  SemesterFrameworkWritebackIntentRecord,
  LessonFileRecord,
  NotebookRecord,
  SetFrameworkContinuityDecisionInput,
  SourceRef,
  NormalizedAgentEvent,
  SemesterFrameworkAggregate,
  SemesterFrameworkRecord,
  SemesterFrameworkPatch,
  UpdateLessonBlueprintInput,
} from "../domain.js";
import {
  isLessonDesignBasisPatch,
  isLessonDesignChangePatch,
  isPresentationGoalPatch,
  isSemesterFrameworkPatch,
} from "../domain.js";
import { runEvidenceIdentity, uniqueRunEvidenceSources } from "../run-evidence.js";
import {
  buildCurriculumFacets,
  buildCurriculumOutline,
  filterCurriculumTextbooks,
  searchCurriculumNodeRecords,
  type CurriculumTextbookFilter,
} from "../curriculum/catalog.js";
import { persistedActivitiesFromEvents, persistedTurnPhaseFromEvents, persistedTurnTextsFromEvents } from "../agent-activity-presentation.js";
import {
  curriculumFixtureNodes,
  curriculumFixtureKnowledgeContinuity,
  curriculumFixtureKnowledgeSearch,
  curriculumFixtureNodeKnowledge,
  curriculumFixtureNodeSemantics,
  curriculumFixtureSemanticEntities,
  curriculumFixtureSemanticPaths,
  curriculumFixtureTextbooks,
} from "../testing/curriculum-fixture.js";
import type {
  AgentRuntimeSessionSnapshot,
  CreateThreadInput,
  ImportedNotebook,
  LessonRepository,
  PresentationTaskOwnerInput,
} from "../repository.js";
import { createLessonPlanPreview } from "../../src/lib/lesson-preview.js";
import { applySemesterFrameworkPatch } from "../semester-framework-patch.js";
import {
  applyContinuityDecisions,
  continuityFingerprintFromCandidateId,
} from "../curriculum/continuity-adoption.js";
import {
  deriveFrameworkContinuity,
  type ReviewedProgressionRelation,
} from "../curriculum/framework-continuity.js";
import { applyLessonDesignBasisPatch } from "../lesson-design-basis-patch.js";
import { expiredRunRecovery } from "./expired-run-recovery.js";
import type {
  BeginClassroomPresentationGenerationResult,
  ClassroomPresentationGeneration,
  DirectClassroomPresentationRecord,
} from "../presentations/domain.js";

let lastTimestamp = 0;
const now = () => {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
};
const key = (...parts: string[]) => parts.join(":");

export class MemoryLessonRepository implements LessonRepository {
  private learningEvidence = new Map<string, LearningEvidence>();
  private learningInquiries = new Map<string, LearningInquiry>();
  private learningReceipts = new Map<string, { fingerprint: string; record: LearningRecord }>();
  private decisions = new Map<string, DecisionRecord>();
  private decisionVersions = new Map<string, DecisionRecord[]>();
  private decisionEvidenceCards = new Map<string, EvidenceCard>();
  private decisionReceipts = new Map<string, { fingerprint: string; record: DecisionRecord }>();
  private decisionEvents = new Map<string, DecisionEvent>();
  async listLearningReviews(ownerId: string, scope: { lessonFileId?: string; lessonBlueprintId?: string; limit: number }) {
    if ((!scope.lessonFileId && !scope.lessonBlueprintId) || !Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 100) throw new Error("learning_scope_invalid");
    return structuredClone([...this.learningInquiries.values()].filter((item) => {
      const file = this.files.get(key(ownerId, item.lessonFileId));
      return item.ownerId === ownerId && file && item.state === "reviewed" && item.review
        && (!scope.lessonFileId || item.lessonFileId === scope.lessonFileId)
        && (!scope.lessonBlueprintId || file.lessonBlueprintId === scope.lessonBlueprintId);
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, scope.limit)
      .map((item) => learningReviewContext(item, this.learningEvidence.get(key(ownerId, item.baselineEvidenceId))!, this.learningEvidence.get(key(ownerId, item.review!.evidenceId))!)));
  }

  private replayLearningNow(ownerId: string, command: LearningCommand) {
    const receipt = this.learningReceipts.get(key(ownerId, command.idempotencyKey));
    if (!receipt) return null;
    if (receipt.fingerprint !== command.fingerprint) throw new Error("idempotency_conflict");
    return structuredClone(receipt.record);
  }
  async getLearningCommandResult(ownerId: string, idempotencyKey: string) {
    return structuredClone(this.learningReceipts.get(key(ownerId, idempotencyKey))?.record ?? null);
  }
  async replayLearningCommand(ownerId: string, command: LearningCommand) { return this.replayLearningNow(ownerId, command); }
  async listLearningEvidence(ownerId: string, fileId: string, limit: number, before?: LearningCursor, decisionId?: string) {
    return structuredClone([...this.learningEvidence.values()].filter((item) => item.ownerId === ownerId && item.lessonFileId === fileId && this.files.has(key(ownerId, fileId)))
      .filter((item) => !decisionId || item.decisionId === decisionId)
      .filter((item) => !before || item.observedAt < before.at || (item.observedAt === before.at && item.id < before.id))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id)).slice(0, limit));
  }
  async getLearningEvidence(ownerId: string, id: string) {
    const value = this.learningEvidence.get(key(ownerId, id));
    return value && this.files.has(key(ownerId, value.lessonFileId)) ? structuredClone(value) : null;
  }
  async listLearningInquiries(ownerId: string, fileId: string, limit: number, before?: LearningCursor) {
    return structuredClone([...this.learningInquiries.values()].filter((item) => item.ownerId === ownerId && item.lessonFileId === fileId && this.files.has(key(ownerId, fileId)) && (!item.sourceRunId || this.runs.get(item.sourceRunId)?.status === "completed"))
      .filter((item) => !before || item.updatedAt < before.at || (item.updatedAt === before.at && item.id < before.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, limit));
  }
  async getLearningInquiry(ownerId: string, id: string) {
    const value = this.learningInquiries.get(key(ownerId, id));
    return value && this.files.has(key(ownerId, value.lessonFileId)) ? structuredClone(value) : null;
  }
  private assertLearningFile(record: LearningRecord, command: LearningCommand) {
    const file = this.files.get(key(record.ownerId, record.lessonFileId));
    if (!file || file.notebookId !== record.notebookId || (command.documentVersion !== undefined && file.documentVersion !== command.documentVersion)) {
      throw new Error("stale_learning_inquiry");
    }
  }
  async saveLearningEvidence(record: LearningEvidence, command: LearningCommand) {
    const replay = this.replayLearningNow(record.ownerId, command);
    if (replay) return replay as LearningEvidence;
    this.assertLearningFile(record, command);
    if (record.inquiryId) {
      const inquiry = this.learningInquiries.get(key(record.ownerId, record.inquiryId));
      if (!inquiry || inquiry.lessonFileId !== record.lessonFileId || inquiry.state !== "implemented" || inquiry.version !== command.inquiryVersion) throw new Error("stale_learning_inquiry");
    }
    if (record.decisionId) {
      const decision = this.decisions.get(key(record.ownerId, record.decisionId));
      if (!decision || decision.lessonFileId !== record.lessonFileId || decision.version !== command.decisionVersion) throw new Error("stale_decision");
    }
    if (this.learningEvidence.has(key(record.ownerId, record.id))) throw new Error("idempotency_conflict");
    this.learningEvidence.set(key(record.ownerId, record.id), structuredClone(record));
    this.learningReceipts.set(key(record.ownerId, command.idempotencyKey), { fingerprint: command.fingerprint, record: structuredClone(record) });
    return structuredClone(record);
  }
  async saveLearningInquiry(record: LearningInquiry, expectedVersion: number | null, command: LearningCommand) {
    const replay = this.replayLearningNow(record.ownerId, command);
    if (replay) return replay as LearningInquiry;
    this.assertLearningFile(record, command);
    const current = this.learningInquiries.get(key(record.ownerId, record.id));
    if (expectedVersion === null ? Boolean(current) : !current || current.version !== expectedVersion) throw new Error("stale_learning_inquiry");
    this.learningInquiries.set(key(record.ownerId, record.id), structuredClone(record));
    this.learningReceipts.set(key(record.ownerId, command.idempotencyKey), { fingerprint: command.fingerprint, record: structuredClone(record) });
    return structuredClone(record);
  }

  private replayDecisionNow(ownerId: string, command: DecisionCommand) {
    const receipt = this.decisionReceipts.get(key(ownerId, command.idempotencyKey));
    if (!receipt) return null;
    if (receipt.fingerprint !== command.fingerprint) throw new Error("idempotency_conflict");
    return structuredClone(receipt.record);
  }
  async getDecisionCommandResult(ownerId: string, idempotencyKey: string) {
    return structuredClone(this.decisionReceipts.get(key(ownerId, idempotencyKey))?.record ?? null);
  }
  async replayDecisionCommand(ownerId: string, command: DecisionCommand) { return this.replayDecisionNow(ownerId, command); }
  async listDecisions(ownerId: string, fileId: string, limit: number, before?: DecisionCursor) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("decision_limit_invalid");
    return structuredClone([...this.decisions.values()]
      .filter((item) => item.ownerId === ownerId && item.lessonFileId === fileId && this.files.has(key(ownerId, fileId)))
      .filter((item) => !before || item.updatedAt < before.at || (item.updatedAt === before.at && item.id < before.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, limit));
  }
  async getDecision(ownerId: string, id: string) {
    const value = this.decisions.get(key(ownerId, id));
    return value && this.files.has(key(ownerId, value.lessonFileId)) ? structuredClone(value) : null;
  }
  async listDecisionVersions(ownerId: string, decisionId: string) {
    return structuredClone(this.decisionVersions.get(key(ownerId, decisionId)) ?? []);
  }
  async listDecisionEvidenceCards(ownerId: string, fileId: string, evidenceIds?: string[]) {
    const wanted = evidenceIds ? new Set(evidenceIds) : null;
    return structuredClone([...this.decisionEvidenceCards.entries()]
      .filter(([cardKey, card]) => cardKey.startsWith(`${key(ownerId, fileId)}:`) && (!wanted || wanted.has(card.id)))
      .map(([, card]) => card));
  }
  async saveDecisionEvent(event: DecisionEvent) {
    if (!this.files.has(key(event.ownerId, event.lessonFileId))) throw new Error("lesson_file_not_found");
    this.decisionEvents.set(key(event.ownerId, event.lessonFileId, event.id), structuredClone(event));
    return structuredClone(event);
  }
  async listDecisionEvents(ownerId: string, lessonFileId: string, limit: number) {
    const wanted = `${key(ownerId, lessonFileId)}:`;
    return structuredClone([...this.decisionEvents.entries()]
      .filter(([eventKey]) => eventKey.startsWith(wanted))
      .map(([, event]) => event)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit));
  }
  async saveDecision(record: DecisionRecord, expectedVersion: number | null, command: DecisionCommand, evidenceCards: EvidenceCard[]) {
    const replay = this.replayDecisionNow(record.ownerId, command);
    if (replay) return replay;
    const file = this.files.get(key(record.ownerId, record.lessonFileId));
    if (!file || file.notebookId !== record.notebookId) throw new Error("stale_decision");
    if (command.documentVersion !== undefined && file.documentVersion !== command.documentVersion) throw new Error("stale_document");
    if (expectedVersion === null && (record.provenance.createdBy === "agent" || record.provenance.modelRunId !== null)) {
      const origin = command.agentRun;
      const run = origin && this.runs.get(origin.runId);
      const thread = origin && this.threads.get(origin.threadId);
      const branch = origin && this.branches.get(origin.branchId);
      if (!origin || origin.runId !== record.provenance.modelRunId || !run || !thread || !branch
        || run.ownerId !== record.ownerId || thread.ownerId !== record.ownerId || branch.ownerId !== record.ownerId
        || run.threadId !== thread.id || run.branchId !== branch.id || branch.threadId !== thread.id
        || thread.resourceType !== "lesson_file" || thread.lessonFileId !== record.lessonFileId
        || run.status !== "running" || run.cancelRequestedAt) throw new Error("decision_scope_invalid");
    }
    const current = this.decisions.get(key(record.ownerId, record.id));
    if (expectedVersion === null ? Boolean(current) : !current || current.version !== expectedVersion) {
      throw new Error("stale_decision");
    }
    for (const card of evidenceCards) {
      this.decisionEvidenceCards.set(key(record.ownerId, record.lessonFileId, card.id), structuredClone(card));
    }
    this.decisions.set(key(record.ownerId, record.id), structuredClone(record));
    const versions = this.decisionVersions.get(key(record.ownerId, record.id)) ?? [];
    versions.push(structuredClone(record));
    this.decisionVersions.set(key(record.ownerId, record.id), versions);
    this.decisionReceipts.set(key(record.ownerId, command.idempotencyKey), { fingerprint: command.fingerprint, record: structuredClone(record) });
    return structuredClone(record);
  }

  private notebooks = new Map<string, NotebookRecord>();
  private files = new Map<string, LessonFileRecord>();
  private lessonGenerationIntents = new Map<string, LessonGenerationIntentRecord>();
  private designBases = new Map<string, LessonDesignBasisAggregate>();
  private threads = new Map<string, AgentThreadRecord>();
  private branches = new Map<string, AgentBranchRecord>();
  private messages = new Map<string, AgentMessageRecord>();
  private runs = new Map<string, AgentRunRecord>();
  private approvals = new Map<string, AgentApprovalRecord>();
  private sessionItems = new Map<string, AgentInputItem[]>();
  private runtimeSessions = new Map<string, AgentRuntimeSessionSnapshot>();
  private threadMemories = new Map<string, { summary: string; cursor: number }>();
  private idempotency = new Map<string, {
    operation: "save_document" | "apply_approval";
    signature: string;
    file: LessonFileRecord;
  }>();
  private semesterApprovalIdempotency = new Map<string, {
    approvalId: string;
    aggregate: SemesterFrameworkAggregate;
  }>();
  private designBasisApprovalIdempotency = new Map<string, {
    approvalId: string;
    aggregate: LessonDesignBasisAggregate;
  }>();
  private designBasisManualRequests = new Map<string, {
    signature: string;
    aggregate: LessonDesignBasisAggregate;
  }>();
  private sessionAppendBatches = new Map<string, string>();
  private createLessonFileRequests = new Map<string, { signature: string; file: LessonFileRecord }>();
  private lessonGenerationIntentRequests = new Map<string, {
    signature: string;
    intent: LessonGenerationIntentRecord;
  }>();
  private createThreadRequests = new Map<string, {
    signature: string;
    thread: AgentThreadRecord;
    branch: AgentBranchRecord;
  }>();
  private semesterFrameworks = new Map<string, SemesterFrameworkAggregate>();
  private frameworkContinuity = new Map<
    string,
    Map<string, FrameworkContinuityCandidateRecord>
  >();
  private frameworkContinuityDecisions = new Map<
    string,
    Map<string, FrameworkContinuityCandidateRecord["decision"]>
  >();
  private lessonClassFeedback: LessonClassFeedbackRecord[] = [];
  private semesterFrameworkWritebackIntents = new Map<string, SemesterFrameworkWritebackIntentRecord>();
  private semesterFrameworkCreateRequests = new Map<string, {
    signature: string;
    frameworkId: string;
  }>();
  private semesterFrameworkManualRequests = new Map<string, {
    signature: string;
    aggregate: SemesterFrameworkAggregate;
  }>();
  private runEvents: Array<{ ownerId: string; runId: string; type: string; data: NormalizedAgentEvent }> = [];
  private runEvidence: AgentRunEvidenceRecord[] = [];
  private curriculumStandardSearchCache = new Map<string, CurriculumStandardSearchCacheRecord>();
  private curriculumTextbooks = curriculumFixtureTextbooks.map((book) => structuredClone(book));
  private curriculumNodes = curriculumFixtureNodes.map((node) => structuredClone(node));
  private curriculumSemanticEntities = curriculumFixtureSemanticEntities.map((entity) => structuredClone(entity));
  private curriculumNodeSemantics = curriculumFixtureNodeSemantics.map((record) => structuredClone(record));
  private curriculumSemanticPaths = curriculumFixtureSemanticPaths.map((step) => structuredClone(step));
  private curriculumNodeKnowledge = curriculumFixtureNodeKnowledge.map((record) => structuredClone(record));
  private curriculumKnowledgeSearch = curriculumFixtureKnowledgeSearch.map((record) => structuredClone(record));
  private classroomPresentations = new Map<string, DirectClassroomPresentationRecord>();
  private classroomPresentationGenerations = new Map<string, ClassroomPresentationGeneration>();
  private presentationCreateRequests = new Map<string, {
    presentationId: string;
  }>();
  private lastMessageTimestamp = 0;
  private readonly curriculumCatalogRelease: CurriculumCatalogReleaseRecord = {
    id: "00000000-0000-4000-8000-00000000c001",
    generationId: "test-generation",
    status: "published",
    snapshotComplete: true,
    manifest: { source: "memory-fixture" },
    textbookCount: curriculumFixtureTextbooks.length,
    nodeCount: curriculumFixtureNodes.length,
    createdAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    retiredAt: null,
  };

  private createInitialDesignBasis(
    ownerId: string,
    file: LessonFileRecord,
    lessonBlueprintId?: string,
  ) {
    const timestamp = file.updatedAt;
    const frameworkAggregate = lessonBlueprintId
      ? [...this.semesterFrameworks.values()].find((aggregate) => (
          aggregate.framework.ownerId === ownerId
          && aggregate.blueprints.some((blueprint) => blueprint.id === lessonBlueprintId)
        ))
      : undefined;
    const blueprint = frameworkAggregate?.blueprints.find((item) => item.id === lessonBlueprintId);
    const unit = blueprint
      ? frameworkAggregate?.units.find((item) => item.id === blueprint.semesterUnitId)
      : undefined;
    const textbookId = frameworkAggregate?.framework.textbookId
      ?? file.contextProfile.textbookId
      ?? null;
    const curriculumNodeId = blueprint?.curriculumNodeId
      ?? file.contextProfile.lessonNodeId
      ?? file.contextProfile.unitNodeId
      ?? null;
    const catalogReleaseId = textbookId && this.curriculumTextbooks.some((book) => book.id === textbookId)
      ? frameworkAggregate?.framework.catalogReleaseId ?? this.curriculumCatalogRelease.id
      : null;
    const semanticReleaseId = frameworkAggregate?.framework.semanticReleaseId
      ?? (textbookId
        ? this.curriculumNodeSemantics.find((record) => record.textbookId === textbookId)?.release?.id ?? null
        : null);
    const basisId = crypto.randomUUID();
    const selections = blueprint
      ? frameworkAggregate?.outcomeSelections.filter((selection) => (
          selection.lessonBlueprintId === blueprint.id
        )) ?? []
      : [];
    const aggregate: LessonDesignBasisAggregate = {
      basis: {
        id: basisId,
        ownerId,
        notebookId: file.notebookId,
        lessonFileId: file.id,
        frameworkId: frameworkAggregate?.framework.id ?? null,
        semesterUnitId: unit?.id ?? null,
        lessonBlueprintId: blueprint?.id ?? null,
        catalogReleaseId,
        textbookId,
        curriculumNodeId,
        semanticReleaseId,
        sourceFrameworkVersion: frameworkAggregate?.framework.version ?? null,
        sourceBlueprintVersion: blueprint?.version ?? null,
        learnerContext: structuredClone(file.contextProfile),
        teacherNotes: "",
        status: "draft",
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      entries: selections.map((selection, index) => {
        const entity = this.curriculumSemanticEntities.find((item) => (
          item.id === selection.semanticEntityId
        ));
        return {
          id: crypto.randomUUID(),
          basisId,
          kind: "knowledge_point" as const,
          semanticEntityId: selection.semanticEntityId,
          semanticEntityName: entity?.canonicalName ?? null,
          relatedSemanticEntityId: null,
          relatedSemanticEntityName: null,
          relatedCurriculumNodeId: null,
          relatedCurriculumNodeTitle: null,
          statement: entity
            ? `将“${entity.canonicalName}”作为本课需要落实的学习内容。`
            : "落实课时蓝图中已选择的学习内容。",
          rationale: selection.adjustmentReason,
          evidence: entity?.sources ?? [],
          decision: "accepted" as const,
          teacherConfirmed: selection.teacherConfirmed,
          origin: "platform" as const,
          sortNo: index + 1,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }),
    };
    this.designBases.set(key(ownerId, file.id), aggregate);
    return aggregate;
  }

  private hydrateDesignBasisNames(aggregate: LessonDesignBasisAggregate) {
    for (const entry of aggregate.entries) {
      entry.semanticEntityName = entry.semanticEntityId
        ? this.curriculumSemanticEntities.find((entity) => entity.id === entry.semanticEntityId)?.canonicalName ?? null
        : null;
      entry.relatedSemanticEntityName = entry.relatedSemanticEntityId
        ? this.curriculumSemanticEntities.find((entity) => entity.id === entry.relatedSemanticEntityId)?.canonicalName ?? null
        : null;
      entry.relatedCurriculumNodeTitle = entry.relatedCurriculumNodeId
        ? this.curriculumNodes.find((node) => (
            node.textbookId === aggregate.basis.textbookId
            && node.nodeId === entry.relatedCurriculumNodeId
          ))?.title ?? null
        : null;
    }
    return aggregate;
  }

  seedCurriculumCatalog(textbooks: CurriculumTextbookRecord[], nodes: CurriculumNodeRecord[]) {
    this.curriculumTextbooks = textbooks.map((book) => structuredClone(book));
    this.curriculumNodes = nodes.map((node) => structuredClone(node));
  }

  private nextMessageTimestamp() {
    this.lastMessageTimestamp = Math.max(Date.now(), this.lastMessageTimestamp + 1);
    return new Date(this.lastMessageTimestamp).toISOString();
  }

  async importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]) {
    let imported = 0;
    for (const notebook of notebooks) {
      this.notebooks.set(key(ownerId, notebook.id), {
        id: notebook.id,
        ownerId,
        title: notebook.title,
        className: notebook.className,
        year: notebook.year,
        subject: notebook.subject,
        stage: notebook.stage ?? "",
        grade: notebook.grade ?? "",
        edition: notebook.edition ?? "",
        tone: notebook.tone ?? "teal",
        updatedAt: now(),
      });
      for (const file of notebook.files) {
        const fileKey = key(ownerId, file.id);
        if (!this.files.has(fileKey)) imported += 1;
        const record: LessonFileRecord = {
          id: file.id,
          ownerId,
          notebookId: notebook.id,
          title: file.title,
          type: file.type ?? "教案",
          image: file.image,
          document: structuredClone(file.lessonPlan),
          contextProfile: {},
          documentVersion: this.files.get(fileKey)?.documentVersion ?? file.documentVersion ?? 0,
          pageCount: file.pages ?? 1,
          updatedAt: now(),
        };
        this.files.set(fileKey, record);
        if (!this.designBases.has(fileKey)) this.createInitialDesignBasis(ownerId, record);
      }
    }
    return { imported };
  }

  async listNotebooks(ownerId: string) {
    return [...this.notebooks.values()]
      .filter((notebook) => notebook.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((notebook) => ({
        ...structuredClone(notebook),
        files: [...this.files.values()]
          .filter((file) => file.ownerId === ownerId && file.notebookId === notebook.id)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map(({ document, contextProfile: _contextProfile, ...file }) => ({
            ...structuredClone(file),
            preview: createLessonPlanPreview(document),
          })),
      }));
  }

  async createNotebook(ownerId: string, input: Parameters<LessonRepository["createNotebook"]>[1]) {
    const timestamp = now();
    const notebook: NotebookRecord = {
      id: crypto.randomUUID(),
      ownerId,
      ...input,
      stage: input.stage ?? "",
      grade: input.grade ?? "",
      edition: input.edition ?? "",
      updatedAt: timestamp,
    };
    this.notebooks.set(key(ownerId, notebook.id), notebook);
    return structuredClone(notebook);
  }

  async updateNotebook(
    ownerId: string,
    notebookId: string,
    patch: Parameters<LessonRepository["updateNotebook"]>[2],
  ) {
    const current = await this.getNotebook(ownerId, notebookId);
    if (!current) throw new Error("notebook_not_found");
    const updated = { ...current, ...patch, id: notebookId, ownerId, updatedAt: now() };
    this.notebooks.set(key(ownerId, notebookId), updated);
    return structuredClone(updated);
  }

  async deleteNotebook(ownerId: string, notebookId: string) {
    const current = await this.getNotebook(ownerId, notebookId);
    if (!current) throw new Error("notebook_not_found");
    this.notebooks.delete(key(ownerId, notebookId));
    for (const file of [...this.files.values()]) {
      if (file.ownerId === ownerId && file.notebookId === notebookId) {
        this.files.delete(key(ownerId, file.id));
        this.designBases.delete(key(ownerId, file.id));
        this.lessonGenerationIntents.delete(key(ownerId, file.id));
      }
    }
  }

  async getNotebook(ownerId: string, notebookId: string) {
    return this.notebooks.get(key(ownerId, notebookId)) ?? null;
  }

  async createLessonFile(
    ownerId: string,
    input: Parameters<LessonRepository["createLessonFile"]>[1],
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify(input);
    const replay = this.createLessonFileRequests.get(requestKey);
    if (replay) {
      if (replay.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(replay.file);
    }
    const notebook = await this.getNotebook(ownerId, input.notebookId);
    if (!notebook) throw new Error("notebook_not_found");
    const timestamp = now();
    const file: LessonFileRecord = {
      id: crypto.randomUUID(),
      ownerId,
      notebookId: input.notebookId,
      lessonBlueprintId: input.lessonBlueprintId,
      title: input.title,
      type: input.type,
      image: input.image,
      document: structuredClone(input.document),
      contextProfile: structuredClone(input.contextProfile ?? {}),
      documentVersion: 0,
      pageCount: input.pageCount,
      updatedAt: timestamp,
    };
    this.files.set(key(ownerId, file.id), file);
    this.createInitialDesignBasis(ownerId, file, input.lessonBlueprintId);
    const prompt = input.initialAgentPrompt?.trim();
    if (prompt) {
      this.lessonGenerationIntents.set(key(ownerId, file.id), {
        id: crypto.randomUUID(), ownerId, lessonFileId: file.id, prompt,
        state: "pending", createdAt: timestamp,
      });
    }
    await this.updateNotebook(ownerId, input.notebookId, {});
    this.createLessonFileRequests.set(requestKey, { signature, file: structuredClone(file) });
    return structuredClone(file);
  }

  async updateLessonFile(
    ownerId: string,
    fileId: string,
    patch: Parameters<LessonRepository["updateLessonFile"]>[2],
  ) {
    const current = await this.getLessonFile(ownerId, fileId);
    if (!current) throw new Error("lesson_file_not_found");
    const updated = { ...current, ...patch, id: fileId, ownerId, updatedAt: now() };
    this.files.set(key(ownerId, fileId), updated);
    await this.updateNotebook(ownerId, current.notebookId, {});
    return structuredClone(updated);
  }

  async deleteLessonFile(ownerId: string, fileId: string) {
    const current = await this.getLessonFile(ownerId, fileId);
    if (!current) throw new Error("lesson_file_not_found");
    this.files.delete(key(ownerId, fileId));
    this.designBases.delete(key(ownerId, fileId));
    this.lessonGenerationIntents.delete(key(ownerId, fileId));
    await this.updateNotebook(ownerId, current.notebookId, {});
  }

  async getLessonFile(ownerId: string, fileId: string) {
    return this.files.get(key(ownerId, fileId)) ?? null;
  }

  async getLessonFileContext(ownerId: string, fileId: string) {
    const file = await this.getLessonFile(ownerId, fileId);
    return file ? {
      id: file.id,
      ownerId: file.ownerId,
      notebookId: file.notebookId,
      documentVersion: file.documentVersion,
      contextProfile: structuredClone(file.contextProfile),
    } : null;
  }

  async getPendingLessonGenerationIntent(ownerId: string, lessonFileId: string) {
    const intent = this.lessonGenerationIntents.get(key(ownerId, lessonFileId));
    return intent?.state === "pending" ? structuredClone(intent) : null;
  }

  async enqueueLessonGenerationIntent(input: Parameters<LessonRepository["enqueueLessonGenerationIntent"]>[0]) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("generation_intent_prompt_empty");
    const requestKey = key(input.ownerId, input.idempotencyKey);
    const signature = JSON.stringify({ lessonFileId: input.lessonFileId, prompt });
    const replay = this.lessonGenerationIntentRequests.get(requestKey);
    if (replay) {
      if (replay.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(replay.intent);
    }
    if (!await this.getLessonFile(input.ownerId, input.lessonFileId)) throw new Error("lesson_file_not_found");
    const intent: LessonGenerationIntentRecord = {
      id: crypto.randomUUID(), ownerId: input.ownerId, lessonFileId: input.lessonFileId,
      prompt, state: "pending", createdAt: now(),
    };
    this.lessonGenerationIntents.set(key(input.ownerId, input.lessonFileId), intent);
    this.lessonGenerationIntentRequests.set(requestKey, { signature, intent: structuredClone(intent) });
    return structuredClone(intent);
  }

  async claimLessonGenerationIntent(input: Parameters<LessonRepository["claimLessonGenerationIntent"]>[0]) {
    const current = await this.getPendingLessonGenerationIntent(input.ownerId, input.lessonFileId);
    if (!current || current.id !== input.intentId) throw new Error("lesson_generation_intent_unavailable");
    const claimed: LessonGenerationIntentRecord = {
      ...current, state: "claimed", runId: input.runId, claimedAt: now(),
    };
    this.lessonGenerationIntents.set(key(input.ownerId, input.lessonFileId), claimed);
    return structuredClone(claimed);
  }

  async getLessonDesignBasis(ownerId: string, lessonFileId: string) {
    const aggregate = this.designBases.get(key(ownerId, lessonFileId));
    return aggregate
      ? structuredClone(this.hydrateDesignBasisNames(structuredClone(aggregate)))
      : null;
  }

  async applyManualLessonDesignBasisPatch(
    ownerId: string,
    patch: LessonDesignBasisPatch,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify(patch);
    const replay = this.designBasisManualRequests.get(requestKey);
    if (replay) {
      if (replay.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(replay.aggregate);
    }
    const aggregate = await this.getLessonDesignBasis(ownerId, patch.fileId);
    if (!aggregate) throw new Error("lesson_design_basis_not_found");
    const updated = this.hydrateDesignBasisNames(
      applyLessonDesignBasisPatch(aggregate, patch, now()),
    );
    this.designBases.set(key(ownerId, patch.fileId), structuredClone(updated));
    this.designBasisManualRequests.set(requestKey, {
      signature,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async applyApprovedLessonDesignBasisPatch(args: {
    ownerId: string;
    approvalId: string;
    idempotencyKey: string;
  }) {
    const replay = this.designBasisApprovalIdempotency.get(key(args.ownerId, args.idempotencyKey));
    if (replay) {
      if (replay.approvalId !== args.approvalId) throw new Error("idempotency_conflict");
      return structuredClone(replay.aggregate);
    }
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (!isLessonDesignBasisPatch(approval.patch)) throw new Error("approval_resource_scope_invalid");
    if (approval.state !== "pending") throw new Error("approval_not_approvable");
    const updated = await this.applyManualLessonDesignBasisPatch(
      args.ownerId,
      approval.patch,
      `approved:${args.idempotencyKey}`,
    );
    await this.resolveApproval(args.ownerId, args.approvalId, "approved");
    this.designBasisApprovalIdempotency.set(key(args.ownerId, args.idempotencyKey), {
      approvalId: args.approvalId,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const idempotencyKey = key(args.ownerId, args.idempotencyKey);
    const signature = JSON.stringify({
      fileId: args.fileId,
      baseVersion: args.baseVersion,
      document: args.document,
      pageCount: args.pageCount,
      source: args.source,
      runId: args.runId ?? null,
    });
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.operation !== "save_document" || replay.signature !== signature) {
        throw new Error("idempotency_conflict");
      }
      return structuredClone(replay.file);
    }
    const current = await this.getLessonFile(args.ownerId, args.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    if (current.documentVersion !== args.baseVersion) {
      throw new DocumentPatchError("stale_document", "教案已被继续编辑，请基于最新版本重试");
    }
    const updated: LessonFileRecord = {
      ...current,
      document: structuredClone(args.document),
      documentVersion: current.documentVersion + 1,
      pageCount: args.pageCount,
      updatedAt: now(),
    };
    this.files.set(key(args.ownerId, args.fileId), updated);
    this.idempotency.set(idempotencyKey, {
      operation: "save_document",
      signature,
      file: structuredClone(updated),
    });
    return updated;
  }

  async updateLessonPageCount(args: Parameters<LessonRepository["updateLessonPageCount"]>[0]) {
    const current = await this.getLessonFile(args.ownerId, args.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    if (current.documentVersion !== args.documentVersion) {
      throw new DocumentPatchError("stale_document", "教案版本已经变化");
    }
    if (current.pageCount === args.pageCount) return structuredClone(current);
    const updated = {
      ...current,
      pageCount: args.pageCount,
      updatedAt: now(),
    };
    this.files.set(key(args.ownerId, args.fileId), updated);
    return structuredClone(updated);
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const idempotencyKey = key(args.ownerId, args.idempotencyKey);
    const signature = JSON.stringify({ approvalId: args.approvalId });
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.operation !== "apply_approval" || replay.signature !== signature) {
        throw new Error("idempotency_conflict");
      }
      return structuredClone(replay.file);
    }
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== "approved") throw new Error("approval_not_approvable");
    if (
      isSemesterFrameworkPatch(approval.patch)
      || isLessonDesignBasisPatch(approval.patch)
      || isPresentationGoalPatch(approval.patch)
    ) {
      throw new Error("approval_resource_scope_invalid");
    }
    const current = await this.getLessonFile(args.ownerId, approval.patch.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    let updatedBasis: LessonDesignBasisAggregate | null = null;
    if (isLessonDesignChangePatch(approval.patch)) {
      const currentBasis = await this.getLessonDesignBasis(args.ownerId, current.id);
      if (!currentBasis) throw new Error("lesson_design_basis_not_found");
      updatedBasis = applyLessonDesignBasisPatch(
        currentBasis,
        approval.patch.designBasisPatch,
        now(),
      );
      assertDesignBasisProjectionCurrent(approval.patch, updatedBasis);
    }
    if (approval.patch.projection) {
      const basis = updatedBasis
        ?? await this.getLessonDesignBasis(args.ownerId, current.id);
      if (!basis) throw new Error("lesson_design_basis_not_found");
      assertDesignBasisProjectionCurrent(approval.patch, basis);
    }
    const patch = rebaseDocumentPatch(
      approval.patch,
      current.document,
      current.documentVersion,
    );
    const updated: LessonFileRecord = {
      ...current,
      document: applyDocumentPatch(current.document, patch),
      documentVersion: current.documentVersion + 1,
      updatedAt: now(),
    };
    if (updatedBasis) {
      this.designBases.set(key(args.ownerId, current.id), structuredClone(updatedBasis));
    }
    this.files.set(key(args.ownerId, current.id), updated);
    this.idempotency.set(idempotencyKey, {
      operation: "apply_approval",
      signature,
      file: structuredClone(updated),
    });
    await this.resolveApproval(args.ownerId, args.approvalId, "approved");
    return updated;
  }

  async applyApprovedSemesterFrameworkPatch(
    args: Parameters<LessonRepository["applyApprovedSemesterFrameworkPatch"]>[0],
  ) {
    const idempotencyKey = key(args.ownerId, args.idempotencyKey);
    const replay = this.semesterApprovalIdempotency.get(idempotencyKey);
    if (replay) {
      if (replay.approvalId !== args.approvalId) throw new Error("idempotency_conflict");
      return structuredClone(replay.aggregate);
    }
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== "approved") {
      throw new Error("approval_not_approvable");
    }
    if (!isSemesterFrameworkPatch(approval.patch)) {
      throw new Error("approval_resource_scope_invalid");
    }
    const current = await this.getSemesterFramework(args.ownerId, approval.patch.frameworkId);
    if (!current) throw new Error("semester_framework_not_found");
    const updated = applySemesterFrameworkPatch(current, approval.patch, now());
    this.semesterFrameworks.set(
      key(args.ownerId, updated.framework.id),
      structuredClone(updated),
    );
    this.semesterApprovalIdempotency.set(idempotencyKey, {
      approvalId: args.approvalId,
      aggregate: structuredClone(updated),
    });
    await this.resolveApproval(args.ownerId, args.approvalId, "approved");
    return structuredClone(updated);
  }

  async saveClassroomPresentation(
    presentation: DirectClassroomPresentationRecord,
  ): Promise<DirectClassroomPresentationRecord> {
    const existing = await this.findClassroomPresentationByRequest(
      presentation.ownerId,
      presentation.idempotencyKey,
    );
    if (existing) return existing;
    const file = await this.getLessonFile(presentation.ownerId, presentation.lessonFileId);
    if (!file || file.notebookId !== presentation.notebookId) {
      throw new Error("presentation_source_scope_invalid");
    }
    this.classroomPresentations.set(key(presentation.ownerId, presentation.id), structuredClone(presentation));
    this.presentationCreateRequests.set(key(presentation.ownerId, presentation.idempotencyKey), {
      presentationId: presentation.id,
    });
    return structuredClone(presentation);
  }

  async findClassroomPresentationByRequest(ownerId: string, idempotencyKey: string) {
    const replay = this.presentationCreateRequests.get(key(ownerId, idempotencyKey));
    if (!replay) return null;
    const presentation = this.classroomPresentations.get(key(ownerId, replay.presentationId));
    return presentation?.dashiGoal ? structuredClone(presentation) : null;
  }

  async listClassroomPresentations(ownerId: string, lessonFileId: string) {
    const file = await this.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    return [...this.classroomPresentations.values()]
      .filter((presentation) => presentation?.dashiGoal && presentation.ownerId === ownerId
        && presentation.lessonFileId === lessonFileId && presentation.notebookId === file.notebookId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((presentation) => structuredClone(presentation));
  }

  async listClassroomPresentationsForOwner(ownerId: string) {
    return [...this.classroomPresentations.values()]
      .filter((presentation) => presentation?.dashiGoal && presentation.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((presentation) => structuredClone(presentation));
  }

  async listRecentClassroomPresentations(ownerId: string, limit = 8) {
    return [...this.classroomPresentations.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async getClassroomPresentation(ownerId: string, presentationId: string) {
    const presentation = this.classroomPresentations.get(key(ownerId, presentationId));
    if (!presentation?.dashiGoal) return null;
    const file = await this.getLessonFile(ownerId, presentation.lessonFileId);
    return file && file.notebookId === presentation.notebookId ? structuredClone(presentation) : null;
  }

  async updateClassroomPresentationArtifact(args: {
    ownerId: string; presentationId: string; storageKey: string; byteSize: number; updatedAt: string;
  }) {
    const presentation = await this.getClassroomPresentation(args.ownerId, args.presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    const updated = {
      ...presentation,
      storageKey: args.storageKey,
      byteSize: args.byteSize,
      updatedAt: args.updatedAt,
    };
    this.classroomPresentations.set(key(args.ownerId, args.presentationId), structuredClone(updated));
    return structuredClone(updated);
  }

  async updateClassroomPresentationGoal(args: Parameters<LessonRepository["updateClassroomPresentationGoal"]>[0]) {
    const presentation = this.classroomPresentations.get(key(args.ownerId, args.presentationId));
    if (!presentation) throw new Error("presentation_not_found");
    if (presentation.checksum !== args.expectedChecksum) throw new Error("presentation_edit_conflict");
    const updated = {
      ...presentation,
      title: args.goal.title,
      theme: args.goal.themePack,
      dashiGoal: structuredClone(args.goal),
      ...(args.artifact ?? {}),
      checksum: args.checksum,
      updatedAt: args.updatedAt,
    };
    this.classroomPresentations.set(key(args.ownerId, args.presentationId), structuredClone(updated));
    return structuredClone(updated);
  }

  async deleteClassroomPresentation(ownerId: string, presentationId: string) {
    const presentation = await this.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    this.classroomPresentations.delete(key(ownerId, presentationId));
    for (const [requestKey, request] of this.presentationCreateRequests) {
      if (request.presentationId === presentationId) this.presentationCreateRequests.delete(requestKey);
    }
  }

  async beginClassroomPresentationGeneration(
    generation: ClassroomPresentationGeneration,
  ): Promise<BeginClassroomPresentationGenerationResult> {
    const file = await this.getLessonFile(generation.ownerId, generation.lessonFileId);
    if (!file || file.notebookId !== generation.notebookId) {
      throw new Error("presentation_source_scope_invalid");
    }
    const active = [...this.classroomPresentationGenerations.values()].find((item) => (
      item.ownerId === generation.ownerId
      && item.lessonFileId === generation.lessonFileId
      && item.status === "generating"
    ));
    if (active) return { generation: structuredClone(active), created: false };
    this.classroomPresentationGenerations.set(
      key(generation.ownerId, generation.id),
      structuredClone(generation),
    );
    return { generation: structuredClone(generation), created: true };
  }

  async getLatestClassroomPresentationGeneration(ownerId: string, lessonFileId: string) {
    const file = await this.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    const generations = [...this.classroomPresentationGenerations.values()]
      .filter((item) => item.ownerId === ownerId && item.lessonFileId === lessonFileId
        && item.notebookId === file.notebookId);
    const active = generations.find((item) => item.status === "generating");
    if (active) return structuredClone(active);
    const completed = generations
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return completed[0] ? structuredClone(completed[0]) : null;
  }

  async completeClassroomPresentationGeneration(args: {
    ownerId: string; generationId: string; presentationId: string; completedAt: string; durationMs: number;
  }) {
    const generation = this.classroomPresentationGenerations.get(key(args.ownerId, args.generationId));
    if (!generation) throw new Error("presentation_generation_not_found");
    const updated: ClassroomPresentationGeneration = {
      ...generation, status: "ready", presentationId: args.presentationId, errorCode: null,
      completedAt: args.completedAt, durationMs: args.durationMs,
    };
    this.classroomPresentationGenerations.set(key(args.ownerId, args.generationId), updated);
    return structuredClone(updated);
  }

  async failClassroomPresentationGeneration(args: {
    ownerId: string; generationId: string; errorCode: string; completedAt: string; durationMs: number;
  }) {
    const generation = this.classroomPresentationGenerations.get(key(args.ownerId, args.generationId));
    if (!generation) throw new Error("presentation_generation_not_found");
    const updated: ClassroomPresentationGeneration = {
      ...generation, status: "failed", presentationId: null, errorCode: args.errorCode,
      completedAt: args.completedAt, durationMs: args.durationMs,
    };
    this.classroomPresentationGenerations.set(key(args.ownerId, args.generationId), updated);
    return structuredClone(updated);
  }

  async recoverInterruptedClassroomPresentationGenerations(completedAt: string) {
    let recovered = 0;
    for (const [generationKey, generation] of this.classroomPresentationGenerations) {
      if (generation.status !== "generating") continue;
      this.classroomPresentationGenerations.set(generationKey, {
        ...generation,
        status: "failed",
        presentationId: null,
        errorCode: "presentation_generation_interrupted",
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(generation.startedAt)),
      });
      recovered += 1;
    }
    return recovered;
  }

  async listThreads(
    ownerId: string,
    resource: string | AgentResourceRef,
    includeArchived = false,
  ) {
    const scope = typeof resource === "string"
      ? { resourceType: "lesson_file" as const, lessonFileId: resource }
      : resource;
    return [...this.threads.values()]
      .filter((thread) => {
        if (thread.ownerId !== ownerId || thread.resourceType !== scope.resourceType) return false;
        return scope.resourceType === "lesson_file"
          ? thread.resourceType === "lesson_file" && thread.lessonFileId === scope.lessonFileId
          : thread.resourceType === "semester_framework"
            && thread.semesterFrameworkId === scope.semesterFrameworkId;
      })
      .filter((thread) => !thread.deletedAt && (includeArchived || !thread.archivedAt))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createThread(ownerId: string, input: CreateThreadInput, idempotencyKey: string = crypto.randomUUID()) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify(input);
    const replay = this.createThreadRequests.get(requestKey);
    if (replay) {
      if (replay.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone({ thread: replay.thread, branch: replay.branch });
    }
    const resource: AgentResourceRef = input.resourceType === "semester_framework"
      ? { resourceType: "semester_framework", semesterFrameworkId: input.semesterFrameworkId }
      : { resourceType: "lesson_file", lessonFileId: input.lessonFileId };
    if (resource.resourceType === "lesson_file") {
      const file = await this.getLessonFile(ownerId, resource.lessonFileId);
      if (!file || file.notebookId !== input.notebookId) throw new Error("lesson_file_not_found");
    } else {
      const framework = await this.getSemesterFramework(ownerId, resource.semesterFrameworkId);
      if (!framework || framework.framework.notebookId !== input.notebookId) {
        throw new Error("semester_framework_not_found");
      }
    }
    const timestamp = now();
    const thread: AgentThreadRecord = {
      id: crypto.randomUUID(), ownerId, notebookId: input.notebookId,
      ...resource,
      title: input.title ?? "新会话", status: "idle",
      starterSuggestions: [],
      createdAt: timestamp, updatedAt: timestamp,
    };
    const branch: AgentBranchRecord = {
      id: crypto.randomUUID(), ownerId, threadId: thread.id, label: "主分支", createdAt: timestamp,
    };
    this.threads.set(thread.id, thread);
    this.branches.set(branch.id, branch);
    this.createThreadRequests.set(requestKey, {
      signature,
      thread: structuredClone(thread),
      branch: structuredClone(branch),
    });
    return { thread, branch };
  }

  async getThread(ownerId: string, threadId: string) {
    const thread = this.threads.get(threadId);
    return thread?.ownerId === ownerId && !thread.deletedAt ? thread : null;
  }

  async getConversationSnapshot(ownerId: string, threadId: string, branchId: string) {
    const thread = await this.getThread(ownerId, threadId);
    const branch = await this.getBranch(ownerId, threadId, branchId);
    if (!thread || !branch) return null;
    const [branches, messages, latestRun, approvals] = await Promise.all([
      this.listBranches(ownerId, threadId),
      this.listMessages(ownerId, threadId, branchId),
      this.getLatestRun(ownerId, threadId, branchId),
      this.listApprovals(ownerId, threadId, branchId),
    ]);
    const events = latestRun ? await this.listRunEvents(ownerId, latestRun.id) : [];
    const capturedAt = now();
    return {
      schemaVersion: 1 as const,
      capturedAt,
      aggregateVersion: [thread.updatedAt, latestRun?.id ?? "none", latestRun?.status ?? "idle", events.length].join(":"),
      thread: structuredClone(thread),
      branch: structuredClone(branch),
      branches: structuredClone(branches),
      messages: structuredClone(messages),
      latestRun: latestRun ? structuredClone(latestRun) : null,
      events: structuredClone(events),
      throughSequence: events.length,
      approvals: structuredClone(approvals),
    };
  }

  async updateThread(
    ownerId: string,
    threadId: string,
    patch: Partial<Pick<
      AgentThreadRecord,
      "title" | "archivedAt" | "deletedAt" | "status" | "starterSuggestions"
        | "starterSuggestionsDocumentVersion" | "starterSuggestionsResourceVersion"
    >>,
  ): Promise<AgentThreadRecord> {
    const thread = await this.getThread(ownerId, threadId);
    if (!thread) throw new Error("thread_not_found");
    const updated = {
      ...thread,
      ...patch,
      id: thread.id,
      ownerId,
      updatedAt: now(),
    } as AgentThreadRecord;
    this.threads.set(threadId, updated);
    return updated;
  }

  async createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string) {
    if (!await this.getThread(ownerId, threadId)) throw new Error("thread_not_found");
    const parentBranch = parentBranchId
      ? await this.getBranch(ownerId, threadId, parentBranchId)
      : null;
    if (parentBranchId && !parentBranch) throw new Error("parent_branch_not_found");
    const forkMessage = forkedFromMessageId
      ? this.messages.get(forkedFromMessageId)
      : null;
    if (forkedFromMessageId && (
      !forkMessage
      || forkMessage.ownerId !== ownerId
      || forkMessage.threadId !== threadId
      || forkMessage.branchId !== parentBranchId
    )) {
      throw new Error("fork_message_scope_invalid");
    }
    const forkCursor = forkMessage?.sessionCursor;
    const parentSession = parentBranchId
      ? this.sessionItems.get(key(ownerId, threadId, parentBranchId)) ?? []
      : [];
    const parentPiSession = parentBranchId
      ? this.runtimeSessions.get(key(ownerId, threadId, parentBranchId, "pi"))
      : undefined;
    if (
      forkCursor !== undefined
      && parentSession.length < forkCursor
      && (parentPiSession?.messages.length ?? 0) < forkCursor
    ) {
      throw new Error("fork_session_not_committed");
    }
    const branch: AgentBranchRecord = {
      id: crypto.randomUUID(), ownerId, threadId, parentBranchId, forkedFromMessageId,
      label: `分支 ${[...this.branches.values()].filter((item) => item.threadId === threadId).length + 1}`,
      createdAt: now(),
    };
    this.branches.set(branch.id, branch);
    if (parentBranchId) {
      const parentMessages = [...this.messages.values()].filter((message) => (
        message.ownerId === ownerId
        && message.threadId === threadId
        && message.branchId === parentBranchId
      ));
      const forkIndex = forkedFromMessageId
        ? parentMessages.findIndex((message) => message.id === forkedFromMessageId)
        : parentMessages.length - 1;
      const inherited = parentMessages.slice(0, forkIndex + 1);
      for (const message of inherited) {
        await this.appendMessage({ ...message, id: undefined, branchId: branch.id });
      }
      const inheritedSession = forkCursor === undefined
        ? inherited.map((message) => ({
            type: "message",
            role: message.role,
            content: message.content,
          })) as AgentInputItem[]
        : structuredClone(parentSession.slice(0, forkCursor));
      this.sessionItems.set(key(ownerId, threadId, branch.id), inheritedSession);
      for (const runtime of ["pi"] as const) {
        const parentRuntime = this.runtimeSessions.get(key(ownerId, threadId, parentBranchId, runtime));
        if (!parentRuntime) continue;
        const runtimeMessages = forkCursor === undefined
          ? parentRuntime.messages
          : parentRuntime.messages.slice(0, forkCursor);
        this.runtimeSessions.set(key(ownerId, threadId, branch.id, runtime), {
          ...structuredClone(parentRuntime),
          branchId: branch.id,
          revision: 1,
          messages: structuredClone(runtimeMessages),
          updatedAt: now(),
        });
      }
      const parentMemory = this.threadMemories.get(key(ownerId, threadId, parentBranchId));
      if (parentMemory && forkCursor !== undefined && parentMemory.cursor <= forkCursor) {
        this.threadMemories.set(key(ownerId, threadId, branch.id), structuredClone(parentMemory));
      } else {
        this.threadMemories.delete(key(ownerId, threadId, branch.id));
      }
    }
    return branch;
  }

  async listBranches(ownerId: string, threadId: string) {
    return [...this.branches.values()]
      .filter((branch) => branch.ownerId === ownerId && branch.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getBranch(ownerId: string, threadId: string, branchId: string) {
    const branch = this.branches.get(branchId);
    return branch?.ownerId === ownerId && branch.threadId === threadId ? branch : null;
  }

  async updateBranch(
    ownerId: string,
    threadId: string,
    branchId: string,
    patch: Partial<Pick<AgentBranchRecord, "pendingInteraction">>,
  ) {
    const branch = await this.getBranch(ownerId, threadId, branchId);
    if (!branch) throw new Error("branch_not_found");
    const updated = { ...branch, ...patch };
    this.branches.set(branchId, updated);
    return structuredClone(updated);
  }

  async bindPresentationTheme(args: Parameters<LessonRepository["bindPresentationTheme"]>[0]): Promise<boolean> {
    const { expectedPending, theme } = args;
    if (expectedPending.kind !== "presentation_generation"
      || expectedPending.resourceId !== args.fileId
      || expectedPending.documentVersion !== args.documentVersion
      || !theme.trim() || theme !== theme.trim()
      || (expectedPending.confirmedTheme !== undefined && expectedPending.confirmedTheme !== theme)) return false;
    if (!this.presentationTaskOwner(args, expectedPending)) return false;
    this.branches.set(args.branchId, { ...this.branches.get(args.branchId)!, pendingInteraction: structuredClone({ ...expectedPending, confirmedTheme: theme }) });
    return true;
  }

  /** Ordinary chat may update the task, but only while this run still owns the
   * branch and snapshot. A cancelled or replaced run cannot write a late task. */
  async updatePresentationTask(args: Parameters<LessonRepository["updatePresentationTask"]>[0]): Promise<boolean> {
    // The old task is compared exactly, including a superseded version. The
    // owning run and replacement are still guarded by the current snapshot.
    if (args.previousPending?.resourceId !== undefined && args.previousPending.resourceId !== args.fileId) return false;
    if (args.pendingInteraction && (
      args.pendingInteraction.resourceId !== args.fileId
      || args.pendingInteraction.documentVersion !== args.documentVersion
    )) return false;
    if (!this.presentationTaskOwner(args, args.previousPending)) return false;
    this.branches.set(args.branchId, {
      ...this.branches.get(args.branchId)!,
      pendingInteraction: args.pendingInteraction ? structuredClone(args.pendingInteraction) : null,
    });
    return true;
  }

  /** Shared ownership predicate for presentation-task writes. No await may sit
   * between this check and the Map write. */
  private presentationTaskOwner(
    args: Omit<PresentationTaskOwnerInput, "expectedPending">,
    current: AgentPendingInteraction | null,
  ) {
    const branch = this.branches.get(args.branchId);
    const thread = this.threads.get(args.threadId);
    const run = this.runs.get(args.runId);
    const file = this.files.get(key(args.ownerId, args.fileId));
    if (!branch || branch.ownerId !== args.ownerId || branch.threadId !== args.threadId
      // Branch records may omit the field entirely when no task exists; both
      // stores must compare the same logical "no pending task" value.
      || JSON.stringify(branch.pendingInteraction ?? null) !== JSON.stringify(current)
      || !thread || thread.ownerId !== args.ownerId || thread.deletedAt
      || thread.resourceType !== "lesson_file" || thread.lessonFileId !== args.fileId
      || !file || file.ownerId !== args.ownerId || file.notebookId !== thread.notebookId
      || !this.notebooks.has(key(args.ownerId, file.notebookId))
      || file.documentVersion !== args.documentVersion
      || !run || run.ownerId !== args.ownerId || run.threadId !== args.threadId || run.branchId !== args.branchId
      || run.status !== "running" || run.leaseToken !== args.leaseToken || run.cancelRequestedAt != null
      || !run.leaseExpiresAt || !(Date.parse(run.leaseExpiresAt) > Date.now())) return false;
    return true;
  }

  async listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit = 100) {
    const separator = cursor?.lastIndexOf("|") ?? -1;
    const cursorTime = separator > 0 ? cursor!.slice(0, separator) : cursor;
    const cursorId = separator > 0 ? cursor!.slice(separator + 1) : undefined;
    const values = [...this.messages.values()]
      .filter((message) => message.ownerId === ownerId && message.threadId === threadId && message.branchId === branchId)
      .filter((message) => !cursorTime
        || message.createdAt < cursorTime
        || (message.createdAt === cursorTime && cursorId !== undefined && message.id < cursorId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return values.slice(-limit).map((message) => {
      const run = [...this.runs.values()]
        .filter((candidate) => candidate.assistantMessageId === message.id)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      if (!run) return structuredClone(message);
      const events = this.runEvents
        .filter((event) => event.ownerId === ownerId && event.runId === run.id)
        .map((event) => event.data);
      const turnPhase = persistedTurnPhaseFromEvents(events, run.status);
      return {
        ...structuredClone(message),
        activities: persistedActivitiesFromEvents(events, run.status),
        turnTexts: persistedTurnTextsFromEvents(events),
        turn: {
          runId: run.id,
          status: run.status,
          ...turnPhase,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        },
      };
    });
  }

  async getMessage(ownerId: string, messageId: string) {
    const message = this.messages.get(messageId);
    return message?.ownerId === ownerId ? structuredClone(message) : null;
  }

  async appendMessage(input: Omit<AgentMessageRecord, "id" | "createdAt"> & { id?: string }) {
    if (input.id) {
      const existing = await this.getMessage(input.ownerId, input.id);
      if (existing) {
        if (
          existing.threadId !== input.threadId
          || existing.branchId !== input.branchId
          || existing.role !== input.role
        ) {
          throw new Error("idempotency_conflict");
        }
        return existing;
      }
    }
    const message: AgentMessageRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: this.nextMessageTimestamp(),
    };
    this.messages.set(message.id, message);
    await this.updateThread(input.ownerId, input.threadId, {});
    return message;
  }

  async updateMessage(ownerId: string, messageId: string, patch: Partial<AgentMessageRecord>) {
    const current = this.messages.get(messageId);
    if (!current || current.ownerId !== ownerId) throw new Error("message_not_found");
    const updated = { ...current, ...patch, id: current.id, ownerId };
    this.messages.set(messageId, updated);
    return updated;
  }

  async createRun(input: Omit<AgentRunRecord, "startedAt"> & { startedAt?: string }) {
    if (
      ["queued", "running", "awaiting_approval"].includes(input.status)
      && [...this.runs.values()].some((candidate) => (
        candidate.ownerId === input.ownerId
        && candidate.threadId === input.threadId
        && ["queued", "running", "awaiting_approval"].includes(candidate.status)
      ))
    ) throw new Error("active_run_exists");
    const run: AgentRunRecord = { ...input, startedAt: input.startedAt ?? now() };
    this.runs.set(run.id, run);
    return run;
  }

  async createRunWithInitialMessages(input: {
    run: AgentRunRecord;
    userMessage?: AgentMessageRecord;
    assistantMessage: AgentMessageRecord;
  }) {
    const { run, userMessage, assistantMessage } = input;
    const branch = await this.getBranch(run.ownerId, run.threadId, run.branchId);
    const thread = await this.getThread(run.ownerId, run.threadId);
    if (!branch || !thread) throw new Error("branch_not_found");
    if (
      (run.userMessageId ?? null) !== (userMessage?.id ?? null)
      || run.assistantMessageId !== assistantMessage.id
      || [...(userMessage ? [userMessage] : []), assistantMessage].some((message) => (
        message.ownerId !== run.ownerId
        || message.threadId !== run.threadId
        || message.branchId !== run.branchId
      ))
      || (userMessage !== undefined && userMessage.role !== "user")
      || assistantMessage.role !== "assistant"
    ) throw new Error("run_initial_messages_scope_invalid");
    if (this.runs.has(run.id) || (userMessage && this.messages.has(userMessage.id)) || this.messages.has(assistantMessage.id)) {
      throw new Error("idempotency_conflict");
    }
    if ([...this.runs.values()].some((candidate) => (
      candidate.ownerId === run.ownerId
      && candidate.threadId === run.threadId
      && ["queued", "running", "awaiting_approval"].includes(candidate.status)
    ))) throw new Error("active_run_exists");
    this.runs.set(run.id, structuredClone(run));
    if (userMessage) this.messages.set(userMessage.id, structuredClone(userMessage));
    this.messages.set(assistantMessage.id, structuredClone(assistantMessage));
    this.threads.set(thread.id, { ...thread, status: "running", updatedAt: run.startedAt });
    return {
      run: structuredClone(run),
      userMessage: userMessage ? structuredClone(userMessage) : undefined,
      assistantMessage: structuredClone(assistantMessage),
    };
  }

  async getRun(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? run : null;
  }

  async getRunByClientCommand(ownerId: string, threadId: string, clientCommandId: string) {
    return [...this.runs.values()].find((run) => (
      run.ownerId === ownerId
      && run.threadId === threadId
      && run.clientCommandId === clientCommandId
    )) ?? null;
  }

  async getLatestRun(ownerId: string, threadId: string, branchId: string) {
    return [...this.runs.values()]
      .filter((run) => (
        run.ownerId === ownerId
        && run.threadId === threadId
        && run.branchId === branchId
      ))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))[0] ?? null;
  }

  async getLatestCompletedRun(ownerId: string, threadId: string, branchId: string) {
    return [...this.runs.values()]
      .filter((run) => (
        run.ownerId === ownerId
        && run.threadId === threadId
        && run.branchId === branchId
        && run.status === "completed"
      ))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))[0] ?? null;
  }

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const run = await this.getRun(ownerId, runId);
    if (!run) throw new Error("run_not_found");
    const updated = { ...run, ...patch, id: runId, ownerId };
    this.runs.set(runId, updated);
    return updated;
  }

  async heartbeatRun(args: Parameters<LessonRepository["heartbeatRun"]>[0]) {
    const run = await this.getRun(args.ownerId, args.runId);
    if (!run) throw new Error("run_not_found");
    if (
      (run.status !== "queued" && run.status !== "running")
      || run.leaseToken !== args.leaseToken
      || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt).getTime() <= Date.now()
    ) {
      throw new Error("run_lease_lost");
    }
    for (const approval of this.approvals.values()) {
      if (approval.ownerId === args.ownerId && approval.runId === args.runId
        && approval.continuationStatus === "running" && approval.continuationLeaseToken === args.leaseToken) {
        approval.continuationLeaseExpiresAt = args.leaseExpiresAt;
      }
    }
    return this.updateRun(args.ownerId, args.runId, {
      status: "running",
      heartbeatAt: now(),
      leaseExpiresAt: args.leaseExpiresAt,
    });
  }

  async settleRun(args: Parameters<LessonRepository["settleRun"]>[0]) {
    // No await between reading the run and committing its terminal state.
    const run = this.runs.get(args.runId);
    if (!run || run.ownerId !== args.ownerId) throw new Error("run_not_found");
    if (run.cancelRequestedAt && args.status !== "cancelled") throw new Error("run_cancel_requested");
    if (run.status === args.status && !run.leaseToken) return structuredClone(run);
    if (
      (run.status !== "queued" && run.status !== "running")
      || run.leaseToken !== args.leaseToken
      || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt).getTime() <= Date.now()
    ) {
      throw new Error("run_lease_lost");
    }
    const updated: AgentRunRecord = {
      ...run,
      status: args.status,
      tokenUsage: args.tokenUsage ?? run.tokenUsage,
      error: args.error,
      completedAt: args.status === "awaiting_approval" ? undefined : now(),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: now(),
    };
    this.runs.set(args.runId, updated);
    if (run.assistantMessageId && args.messageStatus) {
      const messagePatch: Partial<AgentMessageRecord> = {
        status: args.messageStatus,
        error: args.error,
      };
      if (args.messageContent !== undefined) messagePatch.content = args.messageContent;
      if (args.messageSources !== undefined) messagePatch.sources = args.messageSources;
      if (args.sessionCursor !== undefined) messagePatch.sessionCursor = args.sessionCursor;
      await this.updateMessage(args.ownerId, run.assistantMessageId, messagePatch);
    }
    await this.updateThread(args.ownerId, run.threadId, {
      status: args.status === "awaiting_approval"
        ? "awaiting_approval"
        : "idle",
    });
    return structuredClone(updated);
  }

  async requestRunCancellation(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== ownerId) throw new Error("run_not_found");
    if (run.status === "cancelled") return true;
    if (run.status !== "queued" && run.status !== "running") return false;
    const updated = { ...run, cancelRequestedAt: run.cancelRequestedAt ?? now() };
    this.runs.set(runId, updated);
    if (!updated.leaseExpiresAt || new Date(updated.leaseExpiresAt).getTime() <= Date.now()) {
      this.runs.set(runId, {
        ...updated,
        status: "cancelled",
        completedAt: now(),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      if (run.assistantMessageId) {
        await this.updateMessage(ownerId, run.assistantMessageId, {
          status: "cancelled",
          error: undefined,
        });
      }
      await this.updateThread(ownerId, run.threadId, { status: "idle" });
    }
    return true;
  }

  async recoverExpiredRuns(ownerId: string, threadId?: string) {
    const staleBefore = Date.now() - 2 * 60_000;
    let recovered = 0;
    for (const run of [...this.runs.values()]) {
      if (
        run.ownerId !== ownerId
        || (threadId && run.threadId !== threadId)
        || (run.status !== "queued" && run.status !== "running")
      ) {
        continue;
      }
      const leaseExpired = Boolean(
        run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= Date.now(),
      );
      const leaseLessZombie = !run.leaseExpiresAt && new Date(
        run.heartbeatAt ?? run.startedAt ?? 0,
      ).getTime() <= staleBefore;
      if (!leaseExpired && !leaseLessZombie) continue;
      const cancelled = Boolean(run.cancelRequestedAt);
      const hasPendingApproval = [...this.approvals.values()].some((approval) => (
        approval.ownerId === ownerId
        && approval.runId === run.id
        && approval.state === "pending"
      ));
      const recovery = expiredRunRecovery({ cancelled, hasPendingApproval });
      for (const approval of this.approvals.values()) {
        if (approval.ownerId === ownerId && approval.runId === run.id && approval.continuationStatus === "running") {
          approval.continuationStatus = cancelled ? "completed" : "ready";
          approval.continuationLeaseToken = undefined;
          approval.continuationLeaseExpiresAt = undefined;
        }
      }
      await this.updateRun(ownerId, run.id, {
        status: recovery.status,
        error: recovery.error,
        completedAt: recovery.status === "awaiting_approval" ? undefined : now(),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      if (run.assistantMessageId) {
        await this.updateMessage(ownerId, run.assistantMessageId, {
          status: recovery.messageStatus,
          error: recovery.error,
        });
      }
      await this.updateThread(ownerId, run.threadId, {
        status: recovery.threadStatus,
      });
      recovered += 1;
    }
    return recovered;
  }

  async appendRunEvent(ownerId: string, runId: string, type: string, data: unknown) {
    this.runEvents.push({ ownerId, runId, type, data: data as NormalizedAgentEvent });
  }

  async listRunEvents(ownerId: string, runId: string) {
    return this.runEvents
      .filter((event) => event.ownerId === ownerId && event.runId === runId)
      .map((event) => structuredClone(event.data));
  }

  async saveApproval(approval: AgentApprovalRecord) { this.approvals.set(approval.id, approval); }

  async getApproval(ownerId: string, approvalId: string) {
    const approval = this.approvals.get(approvalId);
    return approval?.ownerId === ownerId ? approval : null;
  }

  async listApprovals(ownerId: string, threadId: string, branchId: string) {
    return [...this.approvals.values()]
      .filter((approval) => (
        approval.ownerId === ownerId
        && approval.threadId === threadId
        && approval.branchId === branchId
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((approval) => structuredClone(approval));
  }

  async listPendingApprovals(ownerId: string, threadId: string, branchId: string) {
    return [...this.approvals.values()].filter((approval) => (
      approval.ownerId === ownerId
      && approval.threadId === threadId
      && approval.branchId === branchId
      && (
        approval.state === "pending"
        || approval.continuationStatus === "ready"
        || approval.continuationStatus === "running"
      )
      && new Date(approval.expiresAt).getTime() > Date.now()
    ));
  }

  async resolveApproval(ownerId: string, approvalId: string, state: "approved" | "rejected" | "expired") {
    const approval = await this.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== state) throw new Error("approval_already_resolved");
    const updated = { ...approval, state };
    this.approvals.set(approvalId, updated);
    return updated;
  }

  async expireApprovalLifecycle(ownerId: string, approvalId: string) {
    const approval = await this.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    const updated = approval.state === "pending"
      ? { ...approval, state: "expired" as const, continuationError: "approval_expired" }
      : approval;
    this.approvals.set(approvalId, updated);
    const run = await this.getRun(ownerId, approval.runId);
    if (run && run.status !== "completed" && run.status !== "cancelled") {
      await this.updateRun(ownerId, run.id, {
        status: "failed",
        error: "approval_expired",
        completedAt: now(),
      });
    }
    const thread = await this.getThread(ownerId, approval.threadId);
    const anotherActiveRun = [...this.runs.values()].some((item) => item.ownerId === ownerId && item.threadId === approval.threadId && ["queued", "running", "awaiting_approval"].includes(item.status));
    if (!anotherActiveRun && (thread?.status === "awaiting_approval" || thread?.status === "running")) {
      await this.updateThread(ownerId, thread.id, { status: "idle" });
    }
    return structuredClone(updated);
  }

  async decideApproval(args: {
    ownerId: string;
    approvalId: string;
    approved: boolean;
    encryptedRunState: string;
    completeWithoutContinuation?: boolean;
  }) {
    let approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state === "expired" || new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw new Error("approval_expired");
    }
    const desiredState = args.approved ? "approved" : "rejected";
    if (approval.state !== "pending" && approval.state !== desiredState) {
      throw new Error("approval_already_resolved");
    }

    let file: LessonFileRecord | null = null;
    let framework: SemesterFrameworkAggregate | null = null;
    let basis: LessonDesignBasisAggregate | null = null;
    if (approval.state === "pending") {
      if (args.approved) {
        if (isPresentationGoalPatch(approval.patch)) {
          const current = await this.getLessonFile(args.ownerId, approval.patch.fileId);
          if (!current) throw new Error("lesson_file_not_found");
          if (current.documentVersion !== approval.patch.documentVersion) throw new Error("document_conflict");
          approval = await this.resolveApproval(args.ownerId, args.approvalId, "approved");
        } else if (isSemesterFrameworkPatch(approval.patch)) {
          framework = await this.applyApprovedSemesterFrameworkPatch({
            ownerId: args.ownerId,
            approvalId: args.approvalId,
            idempotencyKey: `approval:${args.approvalId}`,
          });
        } else if (isLessonDesignBasisPatch(approval.patch)) {
          basis = await this.applyApprovedLessonDesignBasisPatch({
            ownerId: args.ownerId,
            approvalId: args.approvalId,
            idempotencyKey: `approval:${args.approvalId}`,
          });
        } else {
          file = await this.applyApprovedPatch({
            ownerId: args.ownerId,
            approvalId: args.approvalId,
            idempotencyKey: `approval:${args.approvalId}`,
          });
          if (isLessonDesignChangePatch(approval.patch)) {
            basis = await this.getLessonDesignBasis(args.ownerId, approval.patch.fileId);
          }
        }
      } else {
        approval = await this.resolveApproval(args.ownerId, args.approvalId, "rejected");
      }
    } else if (args.approved) {
      if (isPresentationGoalPatch(approval.patch)) {
        // Confirmation is the durable side effect. Rendering runs only when
        // the approved SDK tool resumes; no A4 mutation is performed here.
      } else if (isSemesterFrameworkPatch(approval.patch)) {
        framework = await this.getSemesterFramework(args.ownerId, approval.patch.frameworkId);
      } else if (isLessonDesignBasisPatch(approval.patch)) {
        basis = await this.getLessonDesignBasis(args.ownerId, approval.patch.fileId);
      } else {
        file = await this.getLessonFile(args.ownerId, approval.patch.fileId);
        if (isLessonDesignChangePatch(approval.patch)) {
          basis = await this.getLessonDesignBasis(args.ownerId, approval.patch.fileId);
        }
      }
    }

    approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    const updated: AgentApprovalRecord = {
      ...approval,
      state: desiredState,
      encryptedRunState: args.encryptedRunState,
      continuationStatus: args.completeWithoutContinuation || approval.continuationStatus === "completed" ? "completed" : "ready",
      continuationLeaseToken: undefined,
      continuationLeaseExpiresAt: undefined,
      continuationError: undefined,
    };
    this.approvals.set(args.approvalId, updated);
    return {
      approval: structuredClone(updated),
      file: file ? structuredClone(file) : null,
      framework: framework ? structuredClone(framework) : null,
      basis: basis ? structuredClone(basis) : null,
    };
  }

  async claimApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }) {
    const approval = this.approvals.get(args.approvalId);
    if (!approval || approval.ownerId !== args.ownerId) throw new Error("approval_not_found");
    if (approval.state === "pending") throw new Error("approval_decision_missing");
    if (approval.continuationStatus === "completed") return structuredClone(approval);
    const run = this.runs.get(approval.runId);
    if (!run || run.ownerId !== args.ownerId) throw new Error("run_not_found");
    if (run.status === "cancelled" || run.status === "completed" || run.cancelRequestedAt) throw new Error("run_not_continuable");
    if ([...this.runs.values()].some(other => other.ownerId === args.ownerId
      && other.threadId === approval.threadId && other.id !== run.id
      && ["queued", "running", "awaiting_approval"].includes(other.status))) throw new Error("active_run_exists");
    const leaseActive = approval.continuationStatus === "running"
      && approval.continuationLeaseExpiresAt
      && new Date(approval.continuationLeaseExpiresAt).getTime() > Date.now();
    if (leaseActive) {
      throw new Error("active_run_exists");
    }
    const updated: AgentApprovalRecord = {
      ...approval,
      continuationStatus: "running",
      continuationLeaseToken: args.leaseToken,
      continuationLeaseExpiresAt: args.leaseExpiresAt,
      continuationAttemptCount: (approval.continuationAttemptCount ?? 0) + 1,
      continuationError: undefined,
      continuationMessageId: approval.continuationMessageId ?? crypto.randomUUID(),
    };
    this.approvals.set(args.approvalId, updated);
    this.runs.set(run.id, { ...run, status: "running", leaseToken: args.leaseToken,
      leaseExpiresAt: args.leaseExpiresAt, heartbeatAt: now(), completedAt: undefined, error: undefined });
    const thread = this.threads.get(approval.threadId);
    if (thread) this.threads.set(thread.id, { ...thread, status: "running", updatedAt: now() });
    return structuredClone(updated);
  }

  async finishApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    status: "ready" | "completed";
    error?: string;
  }) {
    return this.settleApprovalContinuation({ ...args, outcome: args.status });
  }

  async settleApprovalContinuation(args: Parameters<LessonRepository["settleApprovalContinuation"]>[0]) {
    const approval = this.approvals.get(args.approvalId);
    if (!approval || approval.ownerId !== args.ownerId) throw new Error("approval_not_found");
    if (approval.continuationStatus === "completed") return structuredClone(approval);
    if (approval.continuationStatus === "ready" && !approval.continuationLeaseToken) return structuredClone(approval);
    const run = this.runs.get(approval.runId);
    if (!run || run.ownerId !== args.ownerId) throw new Error("run_not_found");
    if (
      approval.continuationStatus !== "running"
      || approval.continuationLeaseToken !== args.leaseToken
      || run.status !== "running" || run.leaseToken !== args.leaseToken
      || !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now()
      || (run.cancelRequestedAt && args.outcome !== "cancelled")
    ) {
      throw new Error("approval_lease_lost");
    }

    if (args.sessionItems) {
      await this.replaceSessionItems(
        args.ownerId,
        approval.threadId,
        approval.branchId,
        args.sessionItems,
      );
    }
    const sessionCursor = args.sessionItems?.length ?? args.sessionCursor;

    const terminal = args.outcome === "completed" || args.outcome === "cancelled";
    const updated: AgentApprovalRecord = {
      ...approval,
      encryptedRunState: args.encryptedRunState ?? approval.encryptedRunState,
      continuationStatus: terminal || args.outcome === "paused" ? "completed" : "ready",
      continuationLeaseToken: undefined,
      continuationLeaseExpiresAt: undefined,
      continuationError: args.error,
    };
    this.approvals.set(args.approvalId, updated);

    if (args.outcome === "paused") {
      await this.updateRun(args.ownerId, run.id, { status: "awaiting_approval", leaseToken: undefined, leaseExpiresAt: undefined });
      await this.updateThread(args.ownerId, approval.threadId, { status: "awaiting_approval" });
      if (args.assistantMessageId) {
        await this.updateMessage(args.ownerId, args.assistantMessageId, {
          content: args.content,
          sources: args.sources,
          sessionCursor,
          status: "completed",
        });
      }
      return structuredClone(updated);
    }

    if (terminal) {
      await this.updateRun(args.ownerId, run.id, {
        status: args.outcome === "cancelled" ? "cancelled" : "completed",
        tokenUsage: args.tokenUsage ?? run.tokenUsage,
        error: undefined,
        completedAt: now(),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      await this.updateThread(args.ownerId, approval.threadId, { status: "idle" });
      if (args.assistantMessageId) {
        await this.updateMessage(args.ownerId, args.assistantMessageId, {
          content: args.content,
          sources: args.sources,
          sessionCursor,
          status: args.outcome === "cancelled" ? "cancelled" : "completed",
        });
      }
    } else {
      await this.updateRun(args.ownerId, run.id, {
        status: "failed",
        tokenUsage: args.tokenUsage ?? run.tokenUsage,
        error: args.error,
        completedAt: now(),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      await this.updateThread(args.ownerId, approval.threadId, { status: "idle" });
      if (args.assistantMessageId) {
        await this.updateMessage(args.ownerId, args.assistantMessageId, {
          content: args.content,
          sources: args.sources,
          sessionCursor,
          status: "failed",
          error: args.error,
        });
      }
    }
    return structuredClone(updated);
  }

  async getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number) {
    const items = this.sessionItems.get(key(ownerId, threadId, branchId)) ?? [];
    return structuredClone(limit ? items.slice(-limit) : items);
  }

  async getSessionItemsAfter(
    ownerId: string,
    threadId: string,
    branchId: string,
    afterCursor: number,
    limit?: number,
  ) {
    const items = this.sessionItems.get(key(ownerId, threadId, branchId)) ?? [];
    const start = limit
      ? Math.max(Math.max(0, afterCursor), items.length - limit)
      : Math.max(0, afterCursor);
    return structuredClone(items.slice(start));
  }

  async getSessionItemCount(ownerId: string, threadId: string, branchId: string) {
    return (this.sessionItems.get(key(ownerId, threadId, branchId)) ?? []).length;
  }

  async addSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
    idempotencyKey?: string,
  ) {
    const itemKey = key(ownerId, threadId, branchId);
    if (idempotencyKey) {
      const batchKey = key(itemKey, idempotencyKey);
      const payload = JSON.stringify(items);
      const existing = this.sessionAppendBatches.get(batchKey);
      if (existing !== undefined) {
        if (existing !== payload) throw new Error("idempotency_conflict");
        return;
      }
      this.sessionAppendBatches.set(batchKey, payload);
    }
    this.sessionItems.set(itemKey, [...(this.sessionItems.get(itemKey) ?? []), ...structuredClone(items)]);
  }

  async replaceSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
  ) {
    const itemKey = key(ownerId, threadId, branchId);
    this.sessionItems.set(itemKey, structuredClone(items));
    this.threadMemories.delete(itemKey);
    for (const batchKey of [...this.sessionAppendBatches.keys()]) {
      if (batchKey.startsWith(`${itemKey}:`)) this.sessionAppendBatches.delete(batchKey);
    }
  }

  async popSessionItem(ownerId: string, threadId: string, branchId: string) {
    const itemKey = key(ownerId, threadId, branchId);
    const items = this.sessionItems.get(itemKey) ?? [];
    const item = items.pop();
    this.sessionItems.set(itemKey, items);
    return item;
  }

  async clearSession(ownerId: string, threadId: string, branchId: string) {
    const itemKey = key(ownerId, threadId, branchId);
    this.sessionItems.delete(itemKey);
    for (const batchKey of [...this.sessionAppendBatches.keys()]) {
      if (batchKey.startsWith(`${itemKey}:`)) this.sessionAppendBatches.delete(batchKey);
    }
  }

  async getAgentRuntimeSession(
    ownerId: string,
    threadId: string,
    branchId: string,
    runtime: "pi",
  ) {
    const branch = await this.getBranch(ownerId, threadId, branchId);
    if (!branch) return null;
    const snapshot = this.runtimeSessions.get(key(ownerId, threadId, branchId, runtime));
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveAgentRuntimeSession(args: {
    ownerId: string;
    threadId: string;
    branchId: string;
    runtime: "pi";
    expectedRevision: number;
    messages: unknown[];
  }) {
    const thread = await this.getThread(args.ownerId, args.threadId);
    const branch = await this.getBranch(args.ownerId, args.threadId, args.branchId);
    if (!thread || !branch) throw new Error("agent_runtime_session_scope_invalid");
    const sessionKey = key(args.ownerId, args.threadId, args.branchId, args.runtime);
    const current = this.runtimeSessions.get(sessionKey);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      throw new Error("agent_runtime_session_conflict");
    }
    const snapshot: AgentRuntimeSessionSnapshot = {
      ownerId: args.ownerId,
      threadId: args.threadId,
      branchId: args.branchId,
      runtime: args.runtime,
      revision: currentRevision + 1,
      messages: structuredClone(args.messages),
      updatedAt: now(),
    };
    this.runtimeSessions.set(sessionKey, snapshot);
    return structuredClone(snapshot);
  }

  async getThreadMemory(ownerId: string, threadId: string, branchId: string) {
    return this.threadMemories.get(key(ownerId, threadId, branchId)) ?? null;
  }

  async saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number) {
    this.threadMemories.set(key(ownerId, threadId, branchId), { summary, cursor });
  }
  async searchKnowledge(): Promise<KnowledgeResult[]> { return []; }
  async searchCurriculumStandards(): Promise<KnowledgeResult[]> { return []; }
  async getPublishedCurriculumStandardFingerprint() {
    return "memory-curriculum-standards-v1";
  }
  async getCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
  }) {
    const cached = this.curriculumStandardSearchCache.get(key(
      input.contextFingerprint,
      input.querySha256,
      String(input.limit),
    ));
    return cached ? structuredClone(cached) : null;
  }
  async saveCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
    results: KnowledgeResult[];
  }) {
    const record: CurriculumStandardSearchCacheRecord = {
      ...input,
      results: structuredClone(input.results),
      updatedAt: now(),
    };
    this.curriculumStandardSearchCache.set(key(
      input.contextFingerprint,
      input.querySha256,
      String(input.limit),
    ), record);
    return structuredClone(record);
  }
  async getKnowledgePassage(): Promise<KnowledgeResult | null> { return null; }
  async getKnowledgeSourcePassages(): Promise<KnowledgeResult[]> { return []; }
  async listProjectSources(): Promise<SourceRef[]> { return []; }
  async attachKnowledgeSources(
    _ownerId: string,
    _lessonFileId: string,
    _messageId: string,
    sourceIds: string[],
  ): Promise<SourceRef[]> {
    if (sourceIds.length) throw new Error("knowledge_attachment_unavailable");
    return [];
  }

  async recordRunEvidence(
    ownerId: string,
    runId: string,
    kind: Parameters<LessonRepository["recordRunEvidence"]>[2],
    sources: SourceRef[],
  ) {
    const run = await this.getRun(ownerId, runId);
    if (!run) throw new Error("run_not_found");
    for (const source of uniqueRunEvidenceSources(sources)) {
      const index = this.runEvidence.findIndex((item) => (
        item.ownerId === ownerId
        && item.runId === runId
        && item.kind === kind
        && runEvidenceIdentity(item.source) === runEvidenceIdentity(source)
      ));
      const record: AgentRunEvidenceRecord = {
        ownerId,
        runId,
        kind,
        source: structuredClone(source),
        createdAt: now(),
      };
      if (index >= 0) this.runEvidence[index] = record;
      else this.runEvidence.push(record);
    }
  }

  async listRunEvidence(ownerId: string, runId: string) {
    return this.runEvidence
      .filter((item) => item.ownerId === ownerId && item.runId === runId)
      .map((item) => structuredClone(item));
  }

  async filterCurrentCurriculumStandardSources(sources: SourceRef[]) {
    if (!await this.getPublishedCurriculumStandardFingerprint()) return [];
    return structuredClone(sources.filter((source) => Boolean(source.chunkId)));
  }

  async createSemesterFramework(
    ownerId: string,
    notebookId: string,
    input: CreateSemesterFrameworkInput,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify({ notebookId, input });
    const existingRequest = this.semesterFrameworkCreateRequests.get(requestKey);
    if (existingRequest) {
      if (existingRequest.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(this.semesterFrameworks.get(key(ownerId, existingRequest.frameworkId))!);
    }

    const notebook = this.notebooks.get(key(ownerId, notebookId));
    if (!notebook) throw new Error("notebook_not_found");
    const textbook = this.curriculumTextbooks.find((book) => book.id === input.textbookId);
    if (!textbook) throw new Error("curriculum_textbook_not_found");
    if (notebook.subject !== textbook.subject) throw new Error("curriculum_subject_mismatch");
    const rootNodes = this.curriculumNodes
      .filter((node) => node.textbookId === textbook.id && node.parentId === null)
      .sort((left, right) => left.sortNo - right.sortNo || left.nodeId.localeCompare(right.nodeId));
    if (!rootNodes.length) throw new Error("curriculum_textbook_has_no_root_nodes");

    const timestamp = now();
    const frameworkId = crypto.randomUUID();
    const semanticReleaseId = this.curriculumNodeSemantics.find((record) => (
      record.textbookId === textbook.id && record.release
    ))?.release?.id ?? null;
    const framework: SemesterFrameworkRecord = {
      id: frameworkId,
      ownerId,
      notebookId,
      textbookId: textbook.id,
      catalogReleaseId: this.curriculumCatalogRelease.id,
      semanticReleaseId,
      title: input.title,
      term: input.term,
      startDate: input.startDate ?? null,
      totalWeeks: input.totalWeeks,
      weeklyPeriods: input.weeklyPeriods,
      lessonDurationMinutes: input.lessonDurationMinutes,
      capacityRatio: input.capacityRatio,
      planningHorizonWeeks: input.planningHorizonWeeks,
      contextProfile: structuredClone(input.contextProfile),
      version: 0,
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const aggregate: SemesterFrameworkAggregate = {
      framework,
      units: rootNodes.map((node, index) => ({
        id: crypto.randomUUID(),
        frameworkId,
        curriculumNodeId: node.nodeId,
        sortNo: index + 1,
        plannedStartWeek: null,
        plannedEndWeek: null,
        plannedPeriods: 0,
        learningGoals: "",
        teacherNotes: "",
        status: "unplanned",
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      blueprints: [],
      outcomeSelections: [],
    };
    this.semesterFrameworks.set(key(ownerId, frameworkId), structuredClone(aggregate));
    this.semesterFrameworkCreateRequests.set(requestKey, { signature, frameworkId });
    return structuredClone(aggregate);
  }

  async listSemesterFrameworks(ownerId: string, notebookId: string) {
    return [...this.semesterFrameworks.values()]
      .map((aggregate) => aggregate.framework)
      .filter((framework) => (
        framework.ownerId === ownerId && framework.notebookId === notebookId
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((framework) => structuredClone(framework));
  }

  async applyManualSemesterFrameworkPatch(
    ownerId: string,
    patch: SemesterFrameworkPatch,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify(patch);
    const existingRequest = this.semesterFrameworkManualRequests.get(requestKey);
    if (existingRequest) {
      if (existingRequest.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(existingRequest.aggregate);
    }
    const aggregate = await this.getSemesterFramework(ownerId, patch.frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const updated = applySemesterFrameworkPatch(aggregate, patch, now());
    this.semesterFrameworks.set(key(ownerId, patch.frameworkId), structuredClone(updated));
    this.semesterFrameworkManualRequests.set(requestKey, {
      signature,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async createLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    input: CreateLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify({ frameworkId, input });
    const existingRequest = this.semesterFrameworkManualRequests.get(requestKey);
    if (existingRequest) {
      if (existingRequest.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(existingRequest.aggregate);
    }
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const unit = aggregate.units.find((candidate) => candidate.id === input.semesterUnitId);
    if (!unit) throw new Error("semester_unit_not_found");
    const timestamp = now();
    const unitBlueprints = aggregate.blueprints.filter((item) => item.semesterUnitId === unit.id);
    const chapterBlueprints = unitBlueprints.filter((item) => (
      item.curriculumNodeId === input.curriculumNodeId
    ));
    const chapterPeriodNo = input.chapterPeriodNo
      ?? Math.max(0, ...chapterBlueprints.map((item) => item.chapterPeriodNo)) + 1;
    if (chapterBlueprints.some((item) => item.chapterPeriodNo === chapterPeriodNo)) {
      throw new Error("duplicate_lesson_blueprint_identity");
    }
    const updated: SemesterFrameworkAggregate = {
      ...aggregate,
      framework: {
        ...aggregate.framework,
        version: aggregate.framework.version + 1,
        updatedAt: timestamp,
      },
      blueprints: [...aggregate.blueprints, {
        id: crypto.randomUUID(),
        frameworkId,
        semesterUnitId: unit.id,
        curriculumNodeId: input.curriculumNodeId,
        chapterPeriodNo,
        plannedPeriod: Math.max(0, ...unitBlueprints.map((item) => item.plannedPeriod)) + 1,
        sortNo: Math.max(0, ...aggregate.blueprints.map((item) => item.sortNo)) + 1,
        title: input.title,
        mainActivity: input.mainActivity,
        observableProduct: input.observableProduct,
        assessmentEvidence: input.assessmentEvidence,
        anticipatedDifficulties: structuredClone(input.anticipatedDifficulties),
        plannedMinutes: input.plannedMinutes ?? aggregate.framework.lessonDurationMinutes,
        teacherNotes: input.teacherNotes,
        status: "draft",
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    };
    this.semesterFrameworks.set(key(ownerId, frameworkId), structuredClone(updated));
    this.semesterFrameworkManualRequests.set(requestKey, {
      signature,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async updateLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: UpdateLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify({ frameworkId, blueprintId, input });
    const existingRequest = this.semesterFrameworkManualRequests.get(requestKey);
    if (existingRequest) {
      if (existingRequest.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(existingRequest.aggregate);
    }
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const blueprint = aggregate.blueprints.find((candidate) => candidate.id === blueprintId);
    if (!blueprint) throw new Error("lesson_blueprint_not_found");
    if (blueprint.version !== input.expectedVersion) throw new Error("stale_resource");
    const timestamp = now();
    const { expectedVersion: _expectedVersion, ...updates } = input;
    const updated: SemesterFrameworkAggregate = {
      ...aggregate,
      framework: {
        ...aggregate.framework,
        version: aggregate.framework.version + 1,
        updatedAt: timestamp,
      },
      blueprints: aggregate.blueprints.map((candidate) => candidate.id === blueprintId
        ? { ...candidate, ...structuredClone(updates), version: candidate.version + 1, updatedAt: timestamp }
        : candidate),
    };
    this.semesterFrameworks.set(key(ownerId, frameworkId), structuredClone(updated));
    this.semesterFrameworkManualRequests.set(requestKey, {
      signature,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async deleteLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: DeleteLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const requestKey = key(ownerId, idempotencyKey);
    const signature = JSON.stringify({ frameworkId, blueprintId, input });
    const existingRequest = this.semesterFrameworkManualRequests.get(requestKey);
    if (existingRequest) {
      if (existingRequest.signature !== signature) throw new Error("idempotency_conflict");
      return structuredClone(existingRequest.aggregate);
    }
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const updated = applySemesterFrameworkPatch(aggregate, {
      frameworkId,
      baseFrameworkVersion: aggregate.framework.version,
      summary: "教师删除课时蓝图",
      operations: [{
        op: "delete_lesson_blueprint",
        blueprintId,
        expectedVersion: input.expectedVersion,
      }],
    }, now());
    this.semesterFrameworks.set(key(ownerId, frameworkId), structuredClone(updated));
    this.semesterFrameworkManualRequests.set(requestKey, {
      signature,
      aggregate: structuredClone(updated),
    });
    return structuredClone(updated);
  }

  async getSemesterFramework(ownerId: string, frameworkId: string) {
    const aggregate = this.semesterFrameworks.get(key(ownerId, frameworkId));
    return aggregate ? structuredClone(aggregate) : null;
  }

  async getSemesterFrameworkContinuity(ownerId: string, frameworkId: string) {
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const decisions = this.frameworkContinuityDecisions.get(key(ownerId, frameworkId)) ?? new Map();
    const candidates = applyContinuityDecisions(
      [...(this.frameworkContinuity.get(key(ownerId, frameworkId))?.values() ?? [])]
        .filter((candidate) => candidate.active)
        .sort((left, right) => (
          left.targetUnitId.localeCompare(right.targetUnitId)
          || left.direction.localeCompare(right.direction)
          || right.confidence - left.confidence
        )),
      decisions,
    );
    return structuredClone({
      status: aggregate.framework.semanticReleaseId
        ? "available" as const
        : "semantic_release_unavailable" as const,
      frameworkVersion: aggregate.framework.version,
      candidates,
    });
  }

  async refreshSemesterFrameworkContinuity(ownerId: string, frameworkId: string) {
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    if (!aggregate.framework.semanticReleaseId) {
      this.frameworkContinuity.delete(key(ownerId, frameworkId));
      return {
        status: "semantic_release_unavailable" as const,
        frameworkVersion: aggregate.framework.version,
        candidates: [],
      };
    }

    const nodes = this.curriculumNodes.filter((node) => (
      node.textbookId === aggregate.framework.textbookId
    ));
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
    const unitByRootNode = new Map(aggregate.units.map((unit) => [unit.curriculumNodeId, unit]));
    const unitForNode = (nodeId: string) => {
      let node = nodeById.get(nodeId);
      const visited = new Set<string>();
      while (node && !visited.has(node.nodeId)) {
        visited.add(node.nodeId);
        const unit = unitByRootNode.get(node.nodeId);
        if (unit) return unit;
        node = node.parentId ? nodeById.get(node.parentId) : undefined;
      }
      return undefined;
    };
    const occurrences = this.curriculumNodeKnowledge.flatMap((record) => {
      if (record.textbookId !== aggregate.framework.textbookId) return [];
      const unit = unitForNode(record.nodeId);
      if (!unit) return [];
      return record.points.map((point) => ({
        unitId: unit.id,
        unitSortNo: unit.sortNo,
        nodeId: record.nodeId,
        sequenceNo: point.sequenceNo,
        entityId: point.point.id,
        pointName: point.point.canonicalName,
        confidence: point.point.confidence,
      }));
    });
    const relationTypes = new Set([
      "prerequisite", "supports", "develops_into", "transfers_to",
    ]);
    const relations = this.curriculumSemanticPaths
      .filter((step) => step.depth === 1 && relationTypes.has(step.relationType))
      .map((step): ReviewedProgressionRelation => ({
        id: step.relationId,
        relationType: step.relationType as ReviewedProgressionRelation["relationType"],
        fromEntityId: step.fromEntity.id,
        toEntityId: step.toEntity.id,
        confidence: step.confidence,
        rationale: step.rationale,
      }));
    const drafts = deriveFrameworkContinuity({ occurrences, relations });
    const storageKey = key(ownerId, frameworkId);
    const existing = this.frameworkContinuity.get(storageKey) ?? new Map();
    const decisions = this.frameworkContinuityDecisions.get(storageKey) ?? new Map();
    for (const record of existing.values()) record.active = false;
    const timestamp = now();
    for (const draft of drafts) {
      const prior = existing.get(draft.fingerprint);
      existing.set(draft.fingerprint, {
        id: prior?.id ?? (
          draft.evidenceKind === "lexical_similarity"
            ? `lexical-${draft.fingerprint}`
            : crypto.randomUUID()
        ),
        frameworkId,
        derivedFromFrameworkVersion: aggregate.framework.version,
        ...draft,
        decision: decisions.get(draft.fingerprint)
          ?? prior?.decision
          ?? "candidate",
        active: true,
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
    this.frameworkContinuity.set(storageKey, existing);
    return this.getSemesterFrameworkContinuity(ownerId, frameworkId);
  }

  async setSemesterFrameworkContinuityDecision(
    ownerId: string,
    frameworkId: string,
    input: SetFrameworkContinuityDecisionInput,
  ) {
    const continuity = await this.getSemesterFrameworkContinuity(ownerId, frameworkId);
    const fingerprint = input.fingerprint
      ?? continuityFingerprintFromCandidateId(input.candidateId ?? "")
      ?? continuity.candidates.find((candidate) => candidate.id === input.candidateId)?.fingerprint;
    if (!fingerprint) throw new Error("continuity_candidate_not_found");
    const storageKey = key(ownerId, frameworkId);
    const decisions = this.frameworkContinuityDecisions.get(storageKey) ?? new Map();
    decisions.set(fingerprint, input.decision);
    this.frameworkContinuityDecisions.set(storageKey, decisions);
    const stored = this.frameworkContinuity.get(storageKey)?.get(fingerprint);
    if (stored) stored.decision = input.decision;
    return this.getSemesterFrameworkContinuity(ownerId, frameworkId);
  }

  async createLessonClassFeedback(
    ownerId: string,
    input: CreateLessonClassFeedbackInput,
  ) {
    const file = await this.getLessonFile(ownerId, input.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    const timestamp = now();
    const writebackStatus = input.writebackStatus
      ?? defaultClassFeedbackWritebackStatus({
        kind: input.kind,
        continuityOutcome: input.continuityOutcome ?? null,
      });
    const record: LessonClassFeedbackRecord = {
      id: crypto.randomUUID(),
      notebookId: file.notebookId,
      lessonFileId: file.id,
      lessonBlueprintId: input.lessonBlueprintId ?? file.lessonBlueprintId ?? null,
      semesterFrameworkId: input.semesterFrameworkId ?? null,
      kind: input.kind,
      statement: input.statement.trim(),
      relatedEntityId: input.relatedEntityId ?? null,
      continuityFingerprint: input.continuityFingerprint ?? null,
      continuityDirection: input.continuityDirection ?? null,
      continuityOutcome: input.continuityOutcome ?? null,
      writebackStatus,
      evidence: input.evidence ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.lessonClassFeedback.unshift(record);
    return structuredClone(record);
  }

  async markLessonClassFeedbackWriteback(
    ownerId: string,
    feedbackId: string,
    status: "pending" | "applied" | "not_applicable",
  ) {
    void ownerId;
    const index = this.lessonClassFeedback.findIndex((item) => item.id === feedbackId);
    if (index < 0) throw new Error("lesson_class_feedback_not_found");
    const current = this.lessonClassFeedback[index]!;
    const updated = {
      ...current,
      writebackStatus: status,
      updatedAt: now(),
    };
    this.lessonClassFeedback[index] = updated;
    return structuredClone(updated);
  }

  async listLessonClassFeedback(
    ownerId: string,
    filter: Parameters<LessonRepository["listLessonClassFeedback"]>[1],
  ) {
    if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100)) {
      throw new Error("class_feedback_limit_invalid");
    }
    return structuredClone(this.lessonClassFeedback.filter((item) => (
      this.files.has(key(ownerId, item.lessonFileId))
      && (!filter.lessonFileId || item.lessonFileId === filter.lessonFileId)
      && (!filter.lessonBlueprintId || item.lessonBlueprintId === filter.lessonBlueprintId)
      && (!filter.semesterFrameworkId || item.semesterFrameworkId === filter.semesterFrameworkId)
    )).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, filter.limit));
  }

  async getPendingSemesterFrameworkWritebackIntent(ownerId: string, frameworkId: string) {
    return structuredClone([...this.semesterFrameworkWritebackIntents.values()].find((intent) => (
      intent.ownerId === ownerId
      && intent.frameworkId === frameworkId
      && intent.state === "pending"
    )) ?? null);
  }

  async enqueueSemesterFrameworkWritebackIntent(input: Parameters<LessonRepository["enqueueSemesterFrameworkWritebackIntent"]>[0]) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("framework_writeback_prompt_empty");
    const feedback = this.lessonClassFeedback.find((record) => (
      record.id === input.feedbackId
      && record.semesterFrameworkId === input.frameworkId
    ));
    if (!feedback) throw new Error("class_feedback_scope_invalid");
    const existing = this.semesterFrameworkWritebackIntents.get(key(input.ownerId, input.feedbackId));
    if (existing) return structuredClone(existing);
    const intent: SemesterFrameworkWritebackIntentRecord = {
      id: crypto.randomUUID(), ownerId: input.ownerId, frameworkId: input.frameworkId,
      feedbackId: input.feedbackId, prompt, state: "pending", createdAt: now(),
    };
    this.semesterFrameworkWritebackIntents.set(key(input.ownerId, input.feedbackId), intent);
    return structuredClone(intent);
  }

  async claimSemesterFrameworkWritebackIntent(input: Parameters<LessonRepository["claimSemesterFrameworkWritebackIntent"]>[0]) {
    const current = await this.getPendingSemesterFrameworkWritebackIntent(input.ownerId, input.frameworkId);
    if (!current || current.id !== input.intentId) throw new Error("semester_framework_writeback_intent_unavailable");
    const claimed: SemesterFrameworkWritebackIntentRecord = {
      ...current, state: "claimed", runId: input.runId, claimedAt: now(),
    };
    this.semesterFrameworkWritebackIntents.set(key(input.ownerId, current.feedbackId), claimed);
    return structuredClone(claimed);
  }

  async getCurrentCurriculumCatalogRelease() {
    return structuredClone(this.curriculumCatalogRelease);
  }

  async getCurriculumCatalogRelease(releaseId: string) {
    return releaseId === this.curriculumCatalogRelease.id
      ? structuredClone(this.curriculumCatalogRelease)
      : null;
  }

  async listCurriculumFacets() {
    return buildCurriculumFacets(this.curriculumTextbooks);
  }

  async searchCurriculumTextbooks(filter: CurriculumTextbookFilter = {}) {
    return filterCurriculumTextbooks(this.curriculumTextbooks, filter).map((book) => structuredClone(book));
  }

  async getCurriculumTextbook(textbookId: string, catalogReleaseId?: string) {
    if (catalogReleaseId && catalogReleaseId !== this.curriculumCatalogRelease.id) return null;
    const book = this.curriculumTextbooks.find((item) => item.id === textbookId);
    return book ? structuredClone(book) : null;
  }

  async listCurriculumNodes(args: {
    textbookId: string;
    catalogReleaseId?: string;
    parentId?: string | null;
    maxLevel?: number;
  }) {
    if (args.catalogReleaseId && args.catalogReleaseId !== this.curriculumCatalogRelease.id) return [];
    const nodes = this.curriculumNodes.filter((node) => node.textbookId === args.textbookId);
    return buildCurriculumOutline(nodes, {
      parentId: args.parentId,
      maxLevel: args.maxLevel,
    }).map((node) => structuredClone(node));
  }

  async searchCurriculumNodes(args: Parameters<LessonRepository["searchCurriculumNodes"]>[0]) {
    return searchCurriculumNodeRecords({
      textbooks: this.curriculumTextbooks,
      nodes: this.curriculumNodes,
      ...args,
    }).map((match) => structuredClone(match));
  }

  async readCurriculumNodeSemantics(
    args: Parameters<LessonRepository["readCurriculumNodeSemantics"]>[0],
  ): Promise<CurriculumNodeSemanticsRecord> {
    const record = this.curriculumNodeSemantics.find((item) => (
      item.textbookId === args.textbookId && item.nodeId === args.nodeId
    ));
    return record
      ? structuredClone({ release: record.release, mappings: record.mappings })
      : { release: null, mappings: [] };
  }

  async getCurriculumSemanticEntity(entityId: string): Promise<CurriculumSemanticEntityRecord | null> {
    const entity = this.curriculumSemanticEntities.find((item) => item.id === entityId);
    return entity ? structuredClone(entity) : null;
  }

  async traceCurriculumSemanticPath(
    args: Parameters<LessonRepository["traceCurriculumSemanticPath"]>[0],
  ): Promise<CurriculumSemanticPathStep[]> {
    const allowed = new Set(args.relationTypes ?? ["prerequisite", "develops_into", "supports"]);
    const maxDepth = Math.min(Math.max(args.maxDepth ?? 3, 1), 6);
    return this.curriculumSemanticPaths.filter((step) => {
      if (!allowed.has(step.relationType) || step.depth > maxDepth) return false;
      return args.direction === "forward"
        ? step.fromEntity.id === args.entityId
        : step.toEntity.id === args.entityId;
    }).map((step) => {
      const reachedEntity = args.direction === "forward" ? step.toEntity : step.fromEntity;
      const locations = this.curriculumNodeSemantics.flatMap((record) => (
        record.mappings
          .filter((mapping) => mapping.entity.id === reachedEntity.id)
          .map((mapping) => {
            const textbook = this.curriculumTextbooks.find((item) => item.id === record.textbookId);
            const node = this.curriculumNodes.find((item) => (
              item.textbookId === record.textbookId && item.nodeId === record.nodeId
            ));
            return textbook && node ? {
              textbook,
              node,
              instructionalRole: mapping.instructionalRole,
              expectedDepth: mapping.expectedDepth,
            } : null;
          })
          .filter((location) => location !== null)
      ));
      return structuredClone({ ...step, reachedEntity, locations });
    });
  }

  async readCurriculumNodeKnowledgePoints(
    args: Parameters<LessonRepository["readCurriculumNodeKnowledgePoints"]>[0],
  ) {
    const record = this.curriculumNodeKnowledge.find((item) => (
      item.textbookId === args.textbookId && item.nodeId === args.nodeId
    ));
    return record
      ? structuredClone({
        release: record.release,
        points: record.points,
        periodRecommendations: record.periodRecommendations,
      })
      : { release: null, points: [], periodRecommendations: [] };
  }

  async readCurriculumNodesKnowledgePoints(
    args: Parameters<LessonRepository["readCurriculumNodesKnowledgePoints"]>[0],
  ) {
    return Object.fromEntries(await Promise.all([...new Set(args.nodeIds)].map(async (nodeId) => [
      nodeId,
      await this.readCurriculumNodeKnowledgePoints({ textbookId: args.textbookId, nodeId }),
    ])));
  }

  async searchCurriculumKnowledgePoints(
    args: Parameters<LessonRepository["searchCurriculumKnowledgePoints"]>[0],
  ) {
    const query = args.query.trim().toLowerCase();
    return this.curriculumKnowledgeSearch
      .filter((result) => result.occurrences.some((occurrence) => (
        this.curriculumNodes.some((node) => (
          node.textbookId === args.textbookId && node.nodeId === occurrence.nodeId
        ))
      )))
      .filter((result) => (
        result.point.canonicalName.toLowerCase().includes(query)
        || result.point.definition.toLowerCase().includes(query)
        || result.point.sources.some((source) => source.title.toLowerCase().includes(query))
      ))
      .slice(0, args.limit ?? 12)
      .map((result) => structuredClone(result));
  }

  async readCurriculumKnowledgeContinuity(
    args: Parameters<LessonRepository["readCurriculumKnowledgeContinuity"]>[0],
  ) {
    if (args.textbookId !== "textbook-math-bnu"
      || args.currentNodeId !== "ch1"
      || args.entityId !== curriculumFixtureKnowledgeContinuity.target?.id) {
      return { status: "unavailable" as const, currentSequenceNo: null, candidates: [] };
    }
    return structuredClone({
      ...curriculumFixtureKnowledgeContinuity,
      candidates: curriculumFixtureKnowledgeContinuity.candidates.slice(0, args.limit ?? 12),
    });
  }
}
