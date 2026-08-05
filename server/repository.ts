import type { AgentInputItem, Session } from "@openai/agents";
import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
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
  CreateSemesterFrameworkInput,
  CreateLessonBlueprintInput,
  DeleteLessonBlueprintInput,
  DocumentPatch,
  FrameworkContinuityResult,
  KnowledgeResult,
  LessonDesignBasisAggregate,
  LessonDesignBasisPatch,
  LessonFileRecord,
  LessonContextProfile,
  LessonPlan,
  NotebookGraphRecord,
  NotebookRecord,
  SourceRef,
  NormalizedAgentEvent,
  SemesterFrameworkAggregate,
  SemesterFrameworkRecord,
  SemesterFrameworkPatch,
  UpdateLessonBlueprintInput,
} from "./domain.js";
import type { CurriculumFacets, CurriculumTextbookFilter } from "./curriculum/catalog.js";
import { durableSessionHistoryItems } from "./agent/session-history.js";

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

export type CreateThreadInput = { notebookId: string; title?: string } & (
  | { resourceType?: "lesson_file"; lessonFileId: string; semesterFrameworkId?: never }
  | { resourceType: "semester_framework"; lessonFileId?: never; semesterFrameworkId: string }
);

export interface LessonRepository {
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
  }, idempotencyKey?: string): Promise<LessonFileRecord>;
  updateLessonFile(ownerId: string, fileId: string, patch: Partial<Pick<
    LessonFileRecord,
    "title" | "type" | "image" | "contextProfile"
  >>): Promise<LessonFileRecord>;
  deleteLessonFile(ownerId: string, fileId: string): Promise<void>;
  getLessonFile(ownerId: string, fileId: string): Promise<LessonFileRecord | null>;
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

  listThreads(
    ownerId: string,
    resource: string | AgentResourceRef,
    includeArchived?: boolean,
  ): Promise<AgentThreadRecord[]>;
  createThread(ownerId: string, input: CreateThreadInput, idempotencyKey?: string): Promise<{ thread: AgentThreadRecord; branch: AgentBranchRecord }>;
  getThread(ownerId: string, threadId: string): Promise<AgentThreadRecord | null>;
  updateThread(ownerId: string, threadId: string, patch: Partial<Pick<
    AgentThreadRecord,
    "title" | "archivedAt" | "deletedAt" | "status" | "starterSuggestions"
      | "starterSuggestionsDocumentVersion" | "starterSuggestionsResourceVersion"
  >>): Promise<AgentThreadRecord>;
  createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string): Promise<AgentBranchRecord>;
  listBranches(ownerId: string, threadId: string): Promise<AgentBranchRecord[]>;
  getBranch(ownerId: string, threadId: string, branchId: string): Promise<AgentBranchRecord | null>;
  listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit?: number): Promise<AgentMessageRecord[]>;
  getMessage(ownerId: string, messageId: string): Promise<AgentMessageRecord | null>;
  appendMessage(input: Omit<AgentMessageRecord, "id" | "createdAt"> & { id?: string }): Promise<AgentMessageRecord>;
  updateMessage(ownerId: string, messageId: string, patch: Partial<Pick<
    AgentMessageRecord,
    "content" | "status" | "error" | "sources" | "sessionCursor"
  >>): Promise<AgentMessageRecord>;

  createRun(input: Omit<AgentRunRecord, "startedAt"> & { startedAt?: string }): Promise<AgentRunRecord>;
  getRun(ownerId: string, runId: string): Promise<AgentRunRecord | null>;
  getLatestRun(ownerId: string, threadId: string, branchId: string): Promise<AgentRunRecord | null>;
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
  getThreadMemory(ownerId: string, threadId: string, branchId: string): Promise<{ summary: string; cursor: number } | null>;
  saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number): Promise<void>;

  searchKnowledge(ownerId: string, scopes: string[], query: string, limit: number, embedding?: number[]): Promise<KnowledgeResult[]>;
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

  constructor(
    private readonly repository: LessonRepository,
    private readonly ownerId: string,
    private readonly threadId: string,
    private readonly branchId: string,
    private readonly persistenceKey?: string,
    private readonly historyLoader?: () => Promise<AgentInputItem[]>,
  ) {}

  async getSessionId() {
    return `${this.threadId}:${this.branchId}`;
  }

  async getItems(limit?: number) {
    if (limit === undefined && this.historyLoader) {
      return this.historyLoader();
    }
    return this.repository.getSessionItems(this.ownerId, this.threadId, this.branchId, limit);
  }

  async addItems(items: AgentInputItem[]) {
    const durableItems = durableSessionHistoryItems(items);
    if (durableItems.length) {
      const idempotencyKey = this.persistenceKey
        ? `${this.persistenceKey}:${this.appendIndex}`
        : undefined;
      this.appendIndex += 1;
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

  async popItem() {
    return this.repository.popSessionItem(this.ownerId, this.threadId, this.branchId);
  }

  async clearSession() {
    await this.repository.clearSession(this.ownerId, this.threadId, this.branchId);
  }
}

export type ApprovalPayload = {
  patch: DocumentPatch;
  capabilityPlan: CapabilityPlan;
};
