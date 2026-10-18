import {
  type AgentTaskIntent,
  type LessonAgentSelection,
  type LessonFileRecord,
  type LessonPlan,
  type PreparationAgentContext,
} from "../../domain.js";
import { prepareCurrentSelection } from "./selection-snapshot.js";
import type { LessonRepository } from "../../repository.js";

export type PreparationContextInput = {
  userId: string;
  threadId: string;
  branchId: string;
  runId: string;
  documentVersion: number;
  activeSectionId: string;
  activeUnitId?: string;
  selection?: LessonAgentSelection;
  taskIntent?: AgentTaskIntent;
  signal: AbortSignal;
  skipDesignBasis?: boolean;
};

export type LoadedPreparationContext = {
  context: PreparationAgentContext;
  document?: LessonPlan;
  hasUpstreamPlanningContext: boolean;
};

/**
 * Loads and verifies the canonical business resource for one run. Keeping this
 * outside the model coordinator makes the isolation chain independently
 * testable and prevents Fast-path I/O decisions from leaking into the loop.
 */
export async function loadPreparationContext(
  repository: LessonRepository,
  args: PreparationContextInput,
): Promise<LoadedPreparationContext> {
  const [thread, branch] = await Promise.all([
    repository.getThread(args.userId, args.threadId),
    repository.getBranch(args.userId, args.threadId, args.branchId),
  ]);
  if (!thread || !branch) throw new Error("thread_scope_invalid");

  const decisionRef = args.taskIntent?.type === "document_write" ? args.taskIntent.decisionRef : undefined;
  if (thread.resourceType === "semester_framework") {
    if (decisionRef) throw new Error("decision_context_stale");
    const aggregate = await repository.getSemesterFramework(args.userId, thread.semesterFrameworkId);
    if (!aggregate || aggregate.framework.notebookId !== thread.notebookId) {
      throw new Error("thread_scope_invalid");
    }
    if (aggregate.framework.version !== args.documentVersion) throw new Error("resource_context_stale");
    return {
      context: {
        resourceType: "semester_framework",
        userId: args.userId,
        notebookId: thread.notebookId,
        semesterFrameworkId: thread.semesterFrameworkId,
        threadId: thread.id,
        branchId: branch.id,
        runId: args.runId,
        frameworkVersion: aggregate.framework.version,
        activeUnitId: args.activeUnitId,
        contextProfile: aggregate.framework.contextProfile,
        allowedKnowledgeScopes: ["public", `user:${args.userId}`, `notebook:${thread.notebookId}`],
        attachmentSourceIds: [],
        abortSignal: args.signal,
      },
      hasUpstreamPlanningContext: false,
    };
  }

  const [file, basis] = await Promise.all([
    args.skipDesignBasis && !args.selection
      ? repository.getLessonFileContext(args.userId, thread.lessonFileId)
      : repository.getLessonFile(args.userId, thread.lessonFileId),
    args.skipDesignBasis
      ? Promise.resolve(null)
      : repository.getLessonDesignBasis(args.userId, thread.lessonFileId),
  ]);
  if (!file || file.notebookId !== thread.notebookId) throw new Error("thread_scope_invalid");
  if (file.documentVersion !== args.documentVersion) throw new Error("document_context_stale");
  if (!args.skipDesignBasis && !basis) throw new Error("thread_scope_invalid");
  let confirmedDecision;
  if (decisionRef) {
    const decision = await repository.getDecision(args.userId, decisionRef.id);
    const chosenOption = decision?.options.find(option => option.id === decisionRef.chosenOptionId);
    if (!decision || decision.ownerId !== args.userId || decision.lessonFileId !== file.id
      || decision.notebookId !== thread.notebookId || decision.version !== decisionRef.version
      || !["teacher_confirmed", "implemented"].includes(decision.status)
      || decision.provenance.confirmedBy !== args.userId
      || decision.chosenOptionId !== decisionRef.chosenOptionId || !chosenOption) {
      throw new Error("decision_context_stale");
    }
    if (decision.provenance.modelRunId) {
      const origin = await repository.getRun(args.userId, decision.provenance.modelRunId);
      const originThread = origin ? await repository.getThread(args.userId, origin.threadId) : null;
      if (!origin || origin.ownerId !== args.userId || origin.status !== "completed"
        || !originThread || originThread.resourceType === "semester_framework"
        || originThread.lessonFileId !== file.id) throw new Error("decision_context_stale");
    }
    confirmedDecision = {
      id: decision.id, version: decision.version, question: decision.question,
      chosenOption, assumptions: decision.assumptions, observationPlan: decision.observationPlan ?? null,
    };
  }

  return {
    context: {
      resourceType: "lesson_file",
      userId: args.userId,
      notebookId: thread.notebookId,
      lessonFileId: thread.lessonFileId,
      threadId: thread.id,
      branchId: branch.id,
      runId: args.runId,
      activeSectionId: args.activeSectionId,
      confirmedDecision,
      selection: prepareCurrentSelection(args.selection, (file as LessonFileRecord).document, file.documentVersion),
      documentVersion: file.documentVersion,
      designBasisVersion: basis?.basis.version ?? 0,
      contextProfile: file.contextProfile,
      allowedKnowledgeScopes: [
        "public", `user:${args.userId}`, `notebook:${thread.notebookId}`, `file:${thread.lessonFileId}`,
      ],
      attachmentSourceIds: [],
      abortSignal: args.signal,
    },
    document: args.skipDesignBasis ? undefined : (file as LessonFileRecord).document,
    hasUpstreamPlanningContext: Boolean(
      basis?.basis.frameworkId || basis?.basis.lessonBlueprintId || basis?.entries.length,
    ),
  };
}
