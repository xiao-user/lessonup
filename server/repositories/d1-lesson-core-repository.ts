import { D1LearningRepository } from "./d1-learning-repository.js";
import { D1DecisionRepository } from "./d1-decision-repository.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { D1AgentApprovalStore, type AgentApprovalStore } from "./d1-agent-approval-store.js";
import { D1AgentRuntimeStore, type AgentRuntimeStore } from "./d1-agent-runtime-store.js";
import { D1DocumentApprovalCoordinator } from "./d1-document-approval-coordinator.js";
import { D1ApprovalCoordinator } from "./d1-approval-coordinator.js";
import { D1KnowledgeReadRepository, type D1KnowledgeRepository } from "./d1-knowledge-repository.js";
import { D1CurriculumCatalogRepository, type D1CurriculumCatalogStore } from "./d1-curriculum-catalog-repository.js";
import { D1CurriculumStandardCacheRepository, type D1CurriculumStandardCache } from "./d1-curriculum-standard-cache.js";
import { D1CurriculumStandardReadRepository, type D1CurriculumStandardRepository } from "./d1-curriculum-standard-repository.js";
import { D1CurriculumSemanticReadRepository, type D1CurriculumSemanticRepository } from "./d1-curriculum-semantic-repository.js";
import { D1CurriculumKnowledgeReadRepository, type D1CurriculumKnowledgeRepository } from "./d1-curriculum-knowledge-repository.js";
import { D1SemesterFrameworkReadRepository, type D1SemesterFrameworkReadStore } from "./d1-semester-framework-read-repository.js";
import { D1SemesterFrameworkWriteRepository, type D1SemesterFrameworkWriteStore } from "./d1-semester-framework-write-repository.js";
import { D1LessonWorkspaceStore, type LessonWorkspaceStore } from "./d1-workspace-store.js";
import { D1ClassroomPresentationRepository, type D1ClassroomPresentationStore } from "./d1-classroom-presentation-repository.js";
import { D1LessonClassFeedbackRepository, type D1LessonClassFeedbackStore } from "./d1-lesson-class-feedback-repository.js";
import { D1SemesterFrameworkMutationRepository, type D1SemesterFrameworkMutationStore } from "./d1-semester-framework-mutation-repository.js";
import { D1LessonDesignBasisRepository, type D1LessonDesignBasisStore } from "./d1-lesson-design-basis-repository.js";
import { D1SemesterFrameworkContinuityRepository, type D1SemesterFrameworkContinuityStore } from "./d1-semester-framework-continuity-repository.js";

/**
 * The first complete D1 vertical slice. Services depend on this portable
 * repository surface; only the Cloudflare composition root constructs the
 * SqlDatabase adapter around a D1 binding.
 */
export type D1LessonCoreRepository = LessonRepository;

export function createD1LessonCoreRepository(
  database: SqlDatabase,
  clock = () => new Date().toISOString(),
): D1LessonCoreRepository {
  const learning = new D1LearningRepository(database);
  const decisions = new D1DecisionRepository(database);
  const workspace = new D1LessonWorkspaceStore(database, clock);
  const runtime = new D1AgentRuntimeStore(database, clock);
  const approvals = new D1AgentApprovalStore(database, clock);
  const documentApprovals = new D1DocumentApprovalCoordinator(database, clock);
  const approvalCoordinator = new D1ApprovalCoordinator(database, clock);
  const knowledge = new D1KnowledgeReadRepository(database, clock);
  const curriculum = new D1CurriculumCatalogRepository(database);
  const curriculumCache = new D1CurriculumStandardCacheRepository(database, clock);
  const curriculumStandards = new D1CurriculumStandardReadRepository(database);
  const curriculumSemantics = new D1CurriculumSemanticReadRepository(database);
  const curriculumKnowledge = new D1CurriculumKnowledgeReadRepository(database);
  const semesterFrameworks = new D1SemesterFrameworkReadRepository(database);
  const semesterFrameworkWrites = new D1SemesterFrameworkWriteRepository(database, clock);
  const presentations = new D1ClassroomPresentationRepository(database);
  const feedback = new D1LessonClassFeedbackRepository(database, clock);
  const semesterMutations = new D1SemesterFrameworkMutationRepository(database, clock);
  const designBasis = new D1LessonDesignBasisRepository(database, clock);
  const continuity = new D1SemesterFrameworkContinuityRepository(database, clock);

  return {
    ...bind(learning, ["listLearningReviews", "listLearningEvidence", "getLearningEvidence", "listLearningInquiries", "getLearningInquiry", "replayLearningCommand", "getLearningCommandResult", "saveLearningEvidence", "saveLearningInquiry"]),
    ...bind(decisions, decisionMethods),
    ...bind(workspace, workspaceMethods),
    ...bind(runtime, runtimeMethods),
    ...bind(approvals, approvalMethods),
    ...bind(knowledge, knowledgeMethods),
    ...bind(curriculum, curriculumMethods),
    ...bind(curriculumCache, curriculumCacheMethods),
    ...bind(curriculumStandards, curriculumStandardMethods),
    ...bind(curriculumSemantics, curriculumSemanticMethods),
    ...bind(curriculumKnowledge, curriculumKnowledgeMethods),
    ...bind(semesterFrameworks, semesterFrameworkMethods),
    ...bind(semesterFrameworkWrites, semesterFrameworkWriteMethods),
    ...bind(presentations, presentationMethods),
    ...bind(feedback, feedbackMethods),
    ...bind(semesterMutations, semesterMutationMethods),
    ...bind(designBasis, designBasisMethods),
    ...bind(continuity, continuityMethods),
    applyApprovedPatch: documentApprovals.applyApprovedPatch.bind(documentApprovals),
    decideApproval: approvalCoordinator.decideApproval.bind(approvalCoordinator),
  };
}

function bind<T extends object, K extends keyof T>(source: T, names: readonly K[]): Pick<T, K> {
  return Object.fromEntries(names.map((name) => [name, (source[name] as Function).bind(source)])) as Pick<T, K>;
}

const decisionMethods = [
  "listDecisions", "getDecision", "listDecisionVersions", "listDecisionEvidenceCards",
  "getDecisionCommandResult", "replayDecisionCommand", "saveDecision", "saveDecisionEvent", "listDecisionEvents",
] as const;

const workspaceMethods = [
  "importNotebookGraph", "listNotebooks", "createNotebook", "updateNotebook", "deleteNotebook",
  "getNotebook", "createLessonFile", "updateLessonFile", "deleteLessonFile", "getLessonFile", "getLessonFileContext",
  "getPendingLessonGenerationIntent", "enqueueLessonGenerationIntent", "claimLessonGenerationIntent",
  "saveLessonDocument", "updateLessonPageCount",
] as const satisfies ReadonlyArray<keyof LessonWorkspaceStore>;

const runtimeMethods = [
  "listThreads", "createThread", "getThread", "getConversationSnapshot", "updateThread", "createBranch", "listBranches",
  "getBranch", "updateBranch", "listMessages", "getMessage", "appendMessage", "updateMessage",
  "createRun", "createRunWithInitialMessages", "getRun", "getRunByClientCommand", "getLatestRun", "getLatestCompletedRun", "updateRun", "heartbeatRun",
  "settleRun", "requestRunCancellation", "recoverExpiredRuns", "appendRunEvent", "listRunEvents",
  "getSessionItems", "getSessionItemsAfter", "getSessionItemCount", "addSessionItems",
  "replaceSessionItems", "popSessionItem", "clearSession", "getAgentRuntimeSession",
  "saveAgentRuntimeSession", "getThreadMemory", "saveThreadMemory",
] as const satisfies ReadonlyArray<keyof AgentRuntimeStore>;

const approvalMethods = [
  "saveApproval", "getApproval", "listApprovals", "listPendingApprovals", "resolveApproval",
  "expireApprovalLifecycle", "claimApprovalContinuation", "finishApprovalContinuation",
  "settleApprovalContinuation",
] as const satisfies ReadonlyArray<keyof AgentApprovalStore>;

const knowledgeMethods = [
  "searchKnowledge", "getKnowledgePassage", "getKnowledgeSourcePassages", "listProjectSources",
  "attachKnowledgeSources", "recordRunEvidence", "listRunEvidence",
] as const satisfies ReadonlyArray<keyof D1KnowledgeRepository>;

const curriculumMethods = [
  "getCurrentCurriculumCatalogRelease", "getCurriculumCatalogRelease", "listCurriculumFacets",
  "searchCurriculumTextbooks", "getCurriculumTextbook", "listCurriculumNodes", "searchCurriculumNodes",
] as const satisfies ReadonlyArray<keyof D1CurriculumCatalogStore>;
const curriculumCacheMethods = ["getCurriculumStandardSearchCache", "saveCurriculumStandardSearchCache"] as const satisfies ReadonlyArray<keyof D1CurriculumStandardCache>;
const curriculumStandardMethods = ["searchCurriculumStandards", "getPublishedCurriculumStandardFingerprint", "filterCurrentCurriculumStandardSources"] as const satisfies ReadonlyArray<keyof D1CurriculumStandardRepository>;
const curriculumSemanticMethods = ["readCurriculumNodeSemantics", "getCurriculumSemanticEntity", "traceCurriculumSemanticPath"] as const satisfies ReadonlyArray<keyof D1CurriculumSemanticRepository>;
const curriculumKnowledgeMethods = ["readCurriculumNodeKnowledgePoints", "readCurriculumNodesKnowledgePoints", "searchCurriculumKnowledgePoints", "readCurriculumKnowledgeContinuity"] as const satisfies ReadonlyArray<keyof D1CurriculumKnowledgeRepository>;
const semesterFrameworkMethods = ["listSemesterFrameworks", "getSemesterFramework"] as const satisfies ReadonlyArray<keyof D1SemesterFrameworkReadStore>;
const semesterFrameworkWriteMethods = ["createSemesterFramework"] as const satisfies ReadonlyArray<keyof D1SemesterFrameworkWriteStore>;
const presentationMethods = [
  "findClassroomPresentationByRequest", "saveClassroomPresentation", "listClassroomPresentations",
  "listClassroomPresentationsForOwner", "listRecentClassroomPresentations", "getClassroomPresentation",
  "updateClassroomPresentationArtifact", "updateClassroomPresentationGoal", "deleteClassroomPresentation", "beginClassroomPresentationGeneration",
  "getLatestClassroomPresentationGeneration", "completeClassroomPresentationGeneration",
  "failClassroomPresentationGeneration", "recoverInterruptedClassroomPresentationGenerations",
] as const satisfies ReadonlyArray<keyof D1ClassroomPresentationStore>;
const feedbackMethods = [
  "createLessonClassFeedback", "markLessonClassFeedbackWriteback", "listLessonClassFeedback",
  "getPendingSemesterFrameworkWritebackIntent", "enqueueSemesterFrameworkWritebackIntent",
  "claimSemesterFrameworkWritebackIntent",
] as const satisfies ReadonlyArray<keyof D1LessonClassFeedbackStore>;
const semesterMutationMethods = ["applyManualSemesterFrameworkPatch", "applyApprovedSemesterFrameworkPatch", "createLessonBlueprint", "updateLessonBlueprint", "deleteLessonBlueprint"] as const satisfies ReadonlyArray<keyof D1SemesterFrameworkMutationStore>;
const designBasisMethods = ["getLessonDesignBasis", "applyManualLessonDesignBasisPatch", "applyApprovedLessonDesignBasisPatch"] as const satisfies ReadonlyArray<keyof D1LessonDesignBasisStore>;
const continuityMethods = ["getSemesterFrameworkContinuity", "refreshSemesterFrameworkContinuity", "setSemesterFrameworkContinuityDecision"] as const satisfies ReadonlyArray<keyof D1SemesterFrameworkContinuityStore>;
