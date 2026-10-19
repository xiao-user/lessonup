import type { LearningRepository } from "./learning/domain.js";
import type { DecisionRepository } from "./decisions/repository.js";
export type AgentSessionItem = Record<string, unknown>;
type AgentInputItem = AgentSessionItem;
interface Session {
  getSessionId(): Promise<string>;
  getItems(limit?: number): Promise<AgentInputItem[]>;
  addItems(items: AgentInputItem[]): Promise<void>;
  popItem(): Promise<AgentInputItem | undefined>;
  clearSession(): Promise<void>;
}
import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
  AgentPendingInteraction,
  AgentRunRecord,
  AgentRunEvidenceKind,
  AgentRunEvidenceRecord,
  AgentResourceRef,
  AgentThreadRecord,
  CapabilityPlan,
  CurriculumNodeRecord,
  CurriculumCatalogReleaseRecord,
  CurriculumNodeKnowledgeRecord,
  CurriculumNodeMatch,
  CurriculumNodeSemanticsRecord,
  CurriculumKnowledgeContinuityRecord,
  CurriculumKnowledgeSearchResult,
  CurriculumSemanticEntityRecord,
  CurriculumSemanticPathStep,
  CurriculumSemanticRelation,
  CurriculumTextbookRecord,
  CurriculumStandardSearchCacheRecord,
  CreateSemesterFrameworkInput,
  CreateLessonBlueprintInput,
  DeleteLessonBlueprintInput,
  DocumentPatch,
  CreateLessonClassFeedbackInput,
  FrameworkContinuityResult,
  KnowledgeResult,
  LessonClassFeedbackRecord,
  LessonDesignBasisAggregate,
  LessonDesignBasisPatch,
  LessonGenerationIntentRecord,
  SemesterFrameworkWritebackIntentRecord,
  LessonFileRecord,
  LessonContextProfile,
  LessonPlan,
  NotebookGraphRecord,
  NotebookRecord,
  SetFrameworkContinuityDecisionInput,
  SourceRef,
  NormalizedAgentEvent,
  SemesterFrameworkAggregate,
  SemesterFrameworkRecord,
  SemesterFrameworkPatch,
  UpdateLessonBlueprintInput,
} from "./domain.js";
import type { CurriculumFacets, CurriculumTextbookFilter } from "./curriculum/catalog.js";
import type {
  BeginClassroomPresentationGenerationResult,
  ClassroomPresentationGeneration,
  DirectClassroomPresentationRecord,
} from "./presentations/domain.js";
import type { DashiGoal } from "./presentations/dashi-goal.js";

export type ImportedNotebook = Omit<
  NotebookRecord,
  "ownerId" | "tone" | "updatedAt" | "stage" | "grade" | "edition"
> & {
  tone?: NotebookRecord["tone"];
  stage?: string;
  grade?: string;
  edition?: string;
  files: Array<{
    id: string;
    title: string;
    type?: string;
    image?: string;
    pages?: number;
    documentVersion?: number;
    lessonPlan: LessonPlan;
  }>;
};

export type ConversationSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  aggregateVersion: string;
  thread: AgentThreadRecord;
  branch: AgentBranchRecord;
  branches: AgentBranchRecord[];
  messages: AgentMessageRecord[];
  latestRun: AgentRunRecord | null;
  events: NormalizedAgentEvent[];
  throughSequence: number;
  approvals: AgentApprovalRecord[];
};

export type LessonFileContextRecord = Pick<LessonFileRecord,
  "id" | "ownerId" | "notebookId" | "documentVersion" | "contextProfile"
>;

export type CreateThreadInput = { notebookId: string; title?: string } & (
  | { resourceType?: "lesson_file"; lessonFileId: string; semesterFrameworkId?: never }
  | { resourceType: "semester_framework"; lessonFileId?: never; semesterFrameworkId: string }
);

/**
 * Provider-neutral storage boundary for runtimes that own their full protocol
 * transcript. Pi snapshots use their own canonical store instead of the
 * legacy provider-session table because the protocols are not wire compatible.
 * D1 stores the protocol as append-only sequence rows; the session header
 * holds only the CAS revision. Callers still submit the desired prefix.
 */
export type AgentRuntimeName = "pi";

export type AgentRuntimeSessionSnapshot = {
  ownerId: string;
  threadId: string;
  branchId: string;
  runtime: AgentRuntimeName;
  revision: number;
  messages: unknown[];
  updatedAt: string;
};

export type BindPresentationThemeInput = {
  ownerId: string;
  threadId: string;
  branchId: string;
  runId: string;
  leaseToken: string;
  fileId: string;
  documentVersion: number;
  expectedPending: AgentPendingInteraction;
  theme: string;
};

/** A presentation-task write is only valid while its run still owns the branch
 * and the lesson snapshot has not moved. */
export type UpdatePresentationTaskInput = Omit<BindPresentationThemeInput, "theme" | "expectedPending"> & {
  /** The task this run read before deciding, or null when the branch had none.
   * Concurrent writes compare against this, not against the new task. */
  previousPending: AgentPendingInteraction | null;
  pendingInteraction: AgentPendingInteraction | null;
};

/** Ownership guards shared by every presentation-task write. */
export type PresentationTaskOwnerInput = Omit<BindPresentationThemeInput, "theme" | "expectedPending"> & {
  expectedPending: AgentPendingInteraction | null;
};

export interface LessonRepository extends LearningRepository, DecisionRepository {
  importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]): Promise<{ imported: number }>;
  listNotebooks(ownerId: string): Promise<NotebookGraphRecord[]>;
  createNotebook(ownerId: string, input: {
    title: string;
    className: string;
    year: string;
    subject: string;
    stage?: string;
    grade?: string;
    edition?: string;
    tone: NotebookRecord["tone"];
  }): Promise<NotebookRecord>;
  updateNotebook(ownerId: string, notebookId: string, patch: Partial<Pick<
    NotebookRecord,
    "title" | "className" | "year" | "subject" | "stage" | "grade" | "edition" | "tone"
  >>): Promise<NotebookRecord>;
  deleteNotebook(ownerId: string, notebookId: string): Promise<void>;
  getNotebook(ownerId: string, notebookId: string): Promise<NotebookRecord | null>;
  createLessonFile(ownerId: string, input: {
    notebookId: string;
    title: string;
    type: string;
    image?: string;
    document: LessonPlan;
    contextProfile?: LessonContextProfile;
    lessonBlueprintId?: string;
    pageCount: number;
    /** Persisted with the new lesson aggregate; never held only in React. */
    initialAgentPrompt?: string;
  }, idempotencyKey?: string): Promise<LessonFileRecord>;
  updateLessonFile(ownerId: string, fileId: string, patch: Partial<Pick<
    LessonFileRecord,
    "title" | "type" | "image" | "contextProfile"
  >>): Promise<LessonFileRecord>;
  deleteLessonFile(ownerId: string, fileId: string): Promise<void>;
  getLessonFile(ownerId: string, fileId: string): Promise<LessonFileRecord | null>;
  getLessonFileContext(ownerId: string, fileId: string): Promise<LessonFileContextRecord | null>;
  getPendingLessonGenerationIntent(
    ownerId: string,
    lessonFileId: string,
  ): Promise<LessonGenerationIntentRecord | null>;
  enqueueLessonGenerationIntent(input: {
    ownerId: string;
    lessonFileId: string;
    prompt: string;
    idempotencyKey: string;
  }): Promise<LessonGenerationIntentRecord>;
  claimLessonGenerationIntent(input: {
    ownerId: string;
    lessonFileId: string;
    intentId: string;
    runId: string;
  }): Promise<LessonGenerationIntentRecord>;
  saveLessonDocument(args: {
    ownerId: string;
    fileId: string;
    baseVersion: number;
    document: LessonPlan;
    pageCount: number;
    source: "manual" | "agent" | "undo" | "import";
    runId?: string;
    idempotencyKey: string;
  }): Promise<LessonFileRecord>;
  updateLessonPageCount(args: {
    ownerId: string;
    fileId: string;
    documentVersion: number;
    pageCount: number;
  }): Promise<LessonFileRecord>;
  applyApprovedPatch(args: {
    ownerId: string;
    approvalId: string;
    idempotencyKey: string;
  }): Promise<LessonFileRecord>;
  applyApprovedSemesterFrameworkPatch(args: {
    ownerId: string;
    approvalId: string;
    idempotencyKey: string;
  }): Promise<SemesterFrameworkAggregate>;
  getLessonDesignBasis(ownerId: string, lessonFileId: string): Promise<LessonDesignBasisAggregate | null>;
  applyManualLessonDesignBasisPatch(
    ownerId: string,
    patch: LessonDesignBasisPatch,
    idempotencyKey: string,
  ): Promise<LessonDesignBasisAggregate>;
  applyApprovedLessonDesignBasisPatch(args: {
    ownerId: string;
    approvalId: string;
    idempotencyKey: string;
  }): Promise<LessonDesignBasisAggregate>;

  findClassroomPresentationByRequest(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<DirectClassroomPresentationRecord | null>;
  saveClassroomPresentation(
    presentation: DirectClassroomPresentationRecord,
  ): Promise<DirectClassroomPresentationRecord>;
  listClassroomPresentations(
    ownerId: string,
    lessonFileId: string,
  ): Promise<DirectClassroomPresentationRecord[]>;
  listClassroomPresentationsForOwner(ownerId: string): Promise<DirectClassroomPresentationRecord[]>;
  listRecentClassroomPresentations(
    ownerId: string,
    limit?: number,
  ): Promise<DirectClassroomPresentationRecord[]>;
  getClassroomPresentation(
    ownerId: string,
    presentationId: string,
  ): Promise<DirectClassroomPresentationRecord | null>;
  updateClassroomPresentationArtifact(args: {
    ownerId: string;
    presentationId: string;
    storageKey: string;
    byteSize: number;
    updatedAt: string;
  }): Promise<DirectClassroomPresentationRecord>;
  updateClassroomPresentationGoal(args: {
    ownerId: string;
    presentationId: string;
    expectedChecksum: string;
    goal: DashiGoal;
    checksum: string;
    updatedAt: string;
    artifact?: { storageKey: string; byteSize: number };
  }): Promise<DirectClassroomPresentationRecord>;
  deleteClassroomPresentation(ownerId: string, presentationId: string): Promise<void>;
  beginClassroomPresentationGeneration(
    generation: ClassroomPresentationGeneration,
  ): Promise<BeginClassroomPresentationGenerationResult>;
  getLatestClassroomPresentationGeneration(
    ownerId: string,
    lessonFileId: string,
  ): Promise<ClassroomPresentationGeneration | null>;
  completeClassroomPresentationGeneration(args: {
    ownerId: string;
    generationId: string;
    presentationId: string;
    completedAt: string;
    durationMs: number;
  }): Promise<ClassroomPresentationGeneration>;
  failClassroomPresentationGeneration(args: {
    ownerId: string;
    generationId: string;
    errorCode: string;
    completedAt: string;
    durationMs: number;
  }): Promise<ClassroomPresentationGeneration>;
  /**
   * Direct Dashi work is owned by one API process. If that process exits, its
   * detached promises cannot resume safely, so surface those records as
   * retryable failures on the next boot rather than leaving a false spinner.
   */
  recoverInterruptedClassroomPresentationGenerations(completedAt: string): Promise<number>;

  listThreads(
    ownerId: string,
    resource: string | AgentResourceRef,
    includeArchived?: boolean,
  ): Promise<AgentThreadRecord[]>;
  createThread(ownerId: string, input: CreateThreadInput, idempotencyKey?: string): Promise<{ thread: AgentThreadRecord; branch: AgentBranchRecord }>;
  getThread(ownerId: string, threadId: string): Promise<AgentThreadRecord | null>;
  getConversationSnapshot(ownerId: string, threadId: string, branchId: string): Promise<ConversationSnapshot | null>;
  updateThread(ownerId: string, threadId: string, patch: Partial<Pick<
    AgentThreadRecord,
    "title" | "archivedAt" | "deletedAt" | "status" | "starterSuggestions"
      | "starterSuggestionsDocumentVersion" | "starterSuggestionsResourceVersion"
  >>): Promise<AgentThreadRecord>;
  createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string): Promise<AgentBranchRecord>;
  listBranches(ownerId: string, threadId: string): Promise<AgentBranchRecord[]>;
  getBranch(ownerId: string, threadId: string, branchId: string): Promise<AgentBranchRecord | null>;
  updateBranch(ownerId: string, threadId: string, branchId: string, patch: Partial<Pick<
    AgentBranchRecord,
    "pendingInteraction"
  >>): Promise<AgentBranchRecord>;
  /** Atomically binds the first theme while this exact task/run lease/version still owns the branch. */
  bindPresentationTheme(args: BindPresentationThemeInput): Promise<boolean>;
  updatePresentationTask(args: UpdatePresentationTaskInput): Promise<boolean>;
  listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit?: number): Promise<AgentMessageRecord[]>;
  getMessage(ownerId: string, messageId: string): Promise<AgentMessageRecord | null>;
  appendMessage(input: Omit<AgentMessageRecord, "id" | "createdAt"> & { id?: string }): Promise<AgentMessageRecord>;
  updateMessage(ownerId: string, messageId: string, patch: Partial<Pick<
    AgentMessageRecord,
    "content" | "status" | "error" | "sources" | "sessionCursor"
  >>): Promise<AgentMessageRecord>;

  createRun(input: Omit<AgentRunRecord, "startedAt"> & { startedAt?: string }): Promise<AgentRunRecord>;
  createRunWithInitialMessages(input: {
    run: AgentRunRecord;
    userMessage?: AgentMessageRecord;
    assistantMessage: AgentMessageRecord;
  }): Promise<{
    run: AgentRunRecord;
    userMessage?: AgentMessageRecord;
    assistantMessage: AgentMessageRecord;
  }>;
  getRun(ownerId: string, runId: string): Promise<AgentRunRecord | null>;
  getRunByClientCommand(ownerId: string, threadId: string, clientCommandId: string): Promise<AgentRunRecord | null>;
  getLatestRun(ownerId: string, threadId: string, branchId: string): Promise<AgentRunRecord | null>;
  getLatestCompletedRun(ownerId: string, threadId: string, branchId: string): Promise<AgentRunRecord | null>;
  updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>): Promise<AgentRunRecord>;
  heartbeatRun(args: {
    ownerId: string;
    runId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<AgentRunRecord>;
  settleRun(args: {
    ownerId: string;
    runId: string;
    leaseToken: string;
    status: "awaiting_approval" | "completed" | "cancelled" | "failed";
    tokenUsage?: Record<string, number>;
    error?: string;
    messageStatus?: "completed" | "cancelled" | "failed";
    messageContent?: string;
    messageSources?: SourceRef[];
    sessionCursor?: number;
  }): Promise<AgentRunRecord>;
  requestRunCancellation(ownerId: string, runId: string): Promise<boolean>;
  recoverExpiredRuns(ownerId: string, threadId?: string): Promise<number>;
  appendRunEvent(ownerId: string, runId: string, type: string, data: unknown): Promise<void>;
  listRunEvents(ownerId: string, runId: string): Promise<NormalizedAgentEvent[]>;

  saveApproval(approval: AgentApprovalRecord): Promise<void>;
  getApproval(ownerId: string, approvalId: string): Promise<AgentApprovalRecord | null>;
  listApprovals(ownerId: string, threadId: string, branchId: string): Promise<AgentApprovalRecord[]>;
  listPendingApprovals(ownerId: string, threadId: string, branchId: string): Promise<AgentApprovalRecord[]>;
  resolveApproval(ownerId: string, approvalId: string, state: "approved" | "rejected" | "expired"): Promise<AgentApprovalRecord>;
  expireApprovalLifecycle(ownerId: string, approvalId: string): Promise<AgentApprovalRecord>;
  decideApproval(args: {
    ownerId: string;
    approvalId: string;
    approved: boolean;
    encryptedRunState: string;
    completeWithoutContinuation?: boolean;
  }): Promise<{
    approval: AgentApprovalRecord;
    file: LessonFileRecord | null;
    framework: SemesterFrameworkAggregate | null;
    basis: LessonDesignBasisAggregate | null;
  }>;
  claimApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<AgentApprovalRecord>;
  finishApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    status: "ready" | "completed";
    error?: string;
  }): Promise<AgentApprovalRecord>;
  settleApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    outcome: "ready" | "paused" | "completed" | "cancelled";
    assistantMessageId?: string;
    content?: string;
    sources?: SourceRef[];
    sessionItems?: AgentInputItem[];
    sessionCursor?: number;
    tokenUsage?: Record<string, number>;
    encryptedRunState?: string;
    error?: string;
  }): Promise<AgentApprovalRecord>;

  getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number): Promise<AgentInputItem[]>;
  getSessionItemsAfter(
    ownerId: string,
    threadId: string,
    branchId: string,
    afterCursor: number,
    limit?: number,
  ): Promise<AgentInputItem[]>;
  getSessionItemCount(ownerId: string, threadId: string, branchId: string): Promise<number>;
  addSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
    idempotencyKey?: string,
  ): Promise<void>;
  replaceSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
  ): Promise<void>;
  popSessionItem(ownerId: string, threadId: string, branchId: string): Promise<AgentInputItem | undefined>;
  clearSession(ownerId: string, threadId: string, branchId: string): Promise<void>;
  getAgentRuntimeSession(
    ownerId: string,
    threadId: string,
    branchId: string,
    runtime: AgentRuntimeName,
  ): Promise<AgentRuntimeSessionSnapshot | null>;
  saveAgentRuntimeSession(args: {
    ownerId: string;
    threadId: string;
    branchId: string;
    runtime: AgentRuntimeName;
    expectedRevision: number;
    messages: unknown[];
    rewriteFrom?: number;
  }): Promise<AgentRuntimeSessionSnapshot>;
  getThreadMemory(ownerId: string, threadId: string, branchId: string): Promise<{ summary: string; cursor: number } | null>;
  saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number): Promise<void>;

  searchKnowledge(ownerId: string, scopes: string[], query: string, limit: number, embedding?: number[]): Promise<KnowledgeResult[]>;
  searchCurriculumStandards(input: {
    query: string;
    subject: string;
    stage?: string;
    grade?: string;
    limit: number;
    embedding?: number[];
  }): Promise<KnowledgeResult[]>;
  getPublishedCurriculumStandardFingerprint(): Promise<string | null>;
  getCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
  }): Promise<CurriculumStandardSearchCacheRecord | null>;
  saveCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
    results: KnowledgeResult[];
  }): Promise<CurriculumStandardSearchCacheRecord>;
  getKnowledgePassage(ownerId: string, scopes: string[], chunkId: string): Promise<KnowledgeResult | null>;
  getKnowledgeSourcePassages(ownerId: string, scopes: string[], sourceId: string, limit: number): Promise<KnowledgeResult[]>;
  listProjectSources(ownerId: string, scopes: string[]): Promise<SourceRef[]>;
  attachKnowledgeSources(
    ownerId: string,
    lessonFileId: string,
    messageId: string,
    sourceIds: string[],
  ): Promise<SourceRef[]>;
  recordRunEvidence(
    ownerId: string,
    runId: string,
    kind: AgentRunEvidenceKind,
    sources: SourceRef[],
  ): Promise<void>;
  listRunEvidence(ownerId: string, runId: string): Promise<AgentRunEvidenceRecord[]>;
  filterCurrentCurriculumStandardSources(sources: SourceRef[]): Promise<SourceRef[]>;

  createSemesterFramework(
    ownerId: string,
    notebookId: string,
    input: CreateSemesterFrameworkInput,
    idempotencyKey: string,
  ): Promise<SemesterFrameworkAggregate>;
  applyManualSemesterFrameworkPatch(
    ownerId: string,
    patch: SemesterFrameworkPatch,
    idempotencyKey: string,
  ): Promise<SemesterFrameworkAggregate>;
  createLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    input: CreateLessonBlueprintInput,
    idempotencyKey: string,
  ): Promise<SemesterFrameworkAggregate>;
  updateLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: UpdateLessonBlueprintInput,
    idempotencyKey: string,
  ): Promise<SemesterFrameworkAggregate>;
  deleteLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: DeleteLessonBlueprintInput,
    idempotencyKey: string,
  ): Promise<SemesterFrameworkAggregate>;
  listSemesterFrameworks(ownerId: string, notebookId: string): Promise<SemesterFrameworkRecord[]>;
  getSemesterFramework(ownerId: string, frameworkId: string): Promise<SemesterFrameworkAggregate | null>;
  getSemesterFrameworkContinuity(
    ownerId: string,
    frameworkId: string,
  ): Promise<FrameworkContinuityResult>;
  refreshSemesterFrameworkContinuity(
    ownerId: string,
    frameworkId: string,
  ): Promise<FrameworkContinuityResult>;
  setSemesterFrameworkContinuityDecision(
    ownerId: string,
    frameworkId: string,
    input: SetFrameworkContinuityDecisionInput,
  ): Promise<FrameworkContinuityResult>;
  createLessonClassFeedback(
    ownerId: string,
    input: CreateLessonClassFeedbackInput,
  ): Promise<LessonClassFeedbackRecord>;
  markLessonClassFeedbackWriteback(
    ownerId: string,
    feedbackId: string,
    status: "pending" | "applied" | "not_applicable",
  ): Promise<LessonClassFeedbackRecord>;
  listLessonClassFeedback(
    ownerId: string,
    filter: {
      lessonFileId?: string;
      lessonBlueprintId?: string;
      semesterFrameworkId?: string;
      /** Bounded Agent reads; omitted keeps the existing full-list API. */
      limit?: number;
    },
  ): Promise<LessonClassFeedbackRecord[]>;
  getPendingSemesterFrameworkWritebackIntent(
    ownerId: string,
    frameworkId: string,
  ): Promise<SemesterFrameworkWritebackIntentRecord | null>;
  enqueueSemesterFrameworkWritebackIntent(input: {
    ownerId: string;
    frameworkId: string;
    feedbackId: string;
    prompt: string;
  }): Promise<SemesterFrameworkWritebackIntentRecord>;
  claimSemesterFrameworkWritebackIntent(input: {
    ownerId: string;
    frameworkId: string;
    intentId: string;
    runId: string;
  }): Promise<SemesterFrameworkWritebackIntentRecord>;

  getCurrentCurriculumCatalogRelease(): Promise<CurriculumCatalogReleaseRecord | null>;
  getCurriculumCatalogRelease(releaseId: string): Promise<CurriculumCatalogReleaseRecord | null>;
  listCurriculumFacets(): Promise<CurriculumFacets>;
  searchCurriculumTextbooks(filter?: CurriculumTextbookFilter): Promise<CurriculumTextbookRecord[]>;
  getCurriculumTextbook(
    textbookId: string,
    catalogReleaseId?: string,
  ): Promise<CurriculumTextbookRecord | null>;
  listCurriculumNodes(args: {
    textbookId: string;
    catalogReleaseId?: string;
    parentId?: string | null;
    maxLevel?: number;
  }): Promise<CurriculumNodeRecord[]>;
  searchCurriculumNodes(args: {
    query: string;
    textbookId?: string;
    subject?: string;
    stage?: string;
    limit?: number;
  }): Promise<CurriculumNodeMatch[]>;
  readCurriculumNodeSemantics(args: {
    textbookId: string;
    nodeId: string;
  }): Promise<CurriculumNodeSemanticsRecord>;
  getCurriculumSemanticEntity(entityId: string): Promise<CurriculumSemanticEntityRecord | null>;
  traceCurriculumSemanticPath(args: {
    entityId: string;
    direction: "backward" | "forward";
    relationTypes?: CurriculumSemanticRelation[];
    maxDepth?: number;
  }): Promise<CurriculumSemanticPathStep[]>;
  readCurriculumNodeKnowledgePoints(args: {
    textbookId: string;
    nodeId: string;
  }): Promise<CurriculumNodeKnowledgeRecord>;
  readCurriculumNodesKnowledgePoints(args: {
    textbookId: string;
    nodeIds: string[];
  }): Promise<Record<string, CurriculumNodeKnowledgeRecord>>;
  searchCurriculumKnowledgePoints(args: {
    textbookId: string;
    query: string;
    embedding?: number[];
    limit?: number;
  }): Promise<CurriculumKnowledgeSearchResult[]>;
  readCurriculumKnowledgeContinuity(args: {
    textbookId: string;
    currentNodeId: string;
    entityId: string;
    limit?: number;
  }): Promise<CurriculumKnowledgeContinuityRecord>;
}

export class RepositorySession implements Session {
  private appendIndex = 0;
  private bufferedItems?: AgentInputItem[];
  private bufferedDirty = false;
  private transactionState: "open" | "committed" | "discarded" = "open";

  constructor(
    private readonly repository: LessonRepository,
    private readonly ownerId: string,
    private readonly threadId: string,
    private readonly branchId: string,
    private readonly persistenceKey?: string,
    private readonly historyLoader?: () => Promise<AgentInputItem[]>,
    private readonly buffered = false,
  ) {}

  async getSessionId() {
    return `${this.threadId}:${this.branchId}`;
  }

  private async transactionItems() {
    if (!this.bufferedItems) {
      this.bufferedItems = await this.repository.getSessionItems(
        this.ownerId,
        this.threadId,
        this.branchId,
      );
    }
    return this.bufferedItems;
  }

  async getItems(limit?: number) {
    if (this.buffered && (this.bufferedDirty || limit !== undefined)) {
      const items = await this.transactionItems();
      return limit === undefined ? structuredClone(items) : structuredClone(items.slice(-limit));
    }
    if (limit === undefined && this.historyLoader) {
      return this.historyLoader();
    }
    return this.repository.getSessionItems(this.ownerId, this.threadId, this.branchId, limit);
  }

  async addItems(items: AgentInputItem[]) {
    if (this.transactionState !== "open") {
      throw new Error("session_transaction_closed");
    }
    const durableItems = structuredClone(items);
    if (durableItems.length) {
      const idempotencyKey = this.persistenceKey
        ? `${this.persistenceKey}:${this.appendIndex}`
        : undefined;
      this.appendIndex += 1;
      if (this.buffered) {
        const transactionItems = await this.transactionItems();
        transactionItems.push(...structuredClone(durableItems));
        this.bufferedDirty = true;
        return;
      }
      if (idempotencyKey) {
        await this.repository.addSessionItems(
          this.ownerId,
          this.threadId,
          this.branchId,
          durableItems,
          idempotencyKey,
        );
      } else {
        await this.repository.addSessionItems(
          this.ownerId,
          this.threadId,
          this.branchId,
          durableItems,
        );
      }
    }
  }

  /**
   * Flushes all Session writes as one logical unit after the SDK run reaches a
   * stable result. Approval continuations use this mode so a provider failure
   * cannot leak a partial tool/result protocol unit into the durable branch.
   */
  async commit() {
    if (!this.buffered || this.transactionState === "committed") return;
    if (this.transactionState === "discarded") {
      throw new Error("session_transaction_discarded");
    }
    if (this.bufferedDirty) {
      await this.repository.replaceSessionItems(
        this.ownerId,
        this.threadId,
        this.branchId,
        await this.transactionItems(),
      );
    }
    this.transactionState = "committed";
    this.bufferedItems = undefined;
    this.bufferedDirty = false;
  }

  async snapshot() {
    if (!this.buffered || this.transactionState === "discarded" || !this.bufferedDirty) {
      return undefined;
    }
    return structuredClone(await this.transactionItems());
  }

  discard() {
    if (!this.buffered || this.transactionState !== "open") return;
    this.transactionState = "discarded";
    this.bufferedItems = undefined;
    this.bufferedDirty = false;
  }

  async popItem() {
    if (this.buffered && this.transactionState === "open") {
      const items = await this.transactionItems();
      const item = items.pop();
      if (item) this.bufferedDirty = true;
      return item;
    }
    return this.repository.popSessionItem(this.ownerId, this.threadId, this.branchId);
  }

  async clearSession() {
    if (this.buffered && this.transactionState === "open") {
      const items = await this.transactionItems();
      items.splice(0, items.length);
      this.bufferedDirty = true;
      return;
    }
    await this.repository.clearSession(this.ownerId, this.threadId, this.branchId);
  }
}

export type ApprovalPayload = {
  patch: DocumentPatch;
  capabilityPlan: CapabilityPlan;
};
