import { isPresentationGoalPatch, type AgentMessageRecord, type AgentRunRecord, type SourceRef } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { encryptRunState } from "../../security/state-crypto.js";
import { publicPiAgentError } from "../../agent/public-error.js";
import { SkillRegistry, type PlatformSkill } from "../../agent/skill-registry.js";
import type { PresentationService } from "../../presentations/service.js";
import { createMessageCheckpoint } from "./message-checkpoint.js";
import { type PiCapturedProposal } from "./proposal-tools.js";
import { approvalOutcomeMessage } from "./runtime-messages.js";
import { type PiTransportTiming } from "./transport-timing.js";
import { type Emit, type PiDashi, RUN_LEASE_MS, piAgentDefinitionVersion } from "./contracts.js";
import type { PiRunLifecycle } from "./run-lifecycle.js";
import type { PiAgentExecutor } from "./executor.js";
import type { PiToolSurface } from "./tool-surface.js";
import { emitRunEvidence } from "./run-evidence.js";
import { isDocumentDraftPatch } from "./document-draft.js";

/** Coordinates teacher decisions and durable delivery. Completed A4 drafts settle
 * independently; workflows that need continuation share ordinary Pi execution. */
export class PiApprovalWorkflow {
  constructor(
    private readonly repository: LessonRepository,
    private readonly lifecycle: PiRunLifecycle,
    private readonly executor: PiAgentExecutor,
    private readonly toolSurface: PiToolSurface,
    private readonly ready: Promise<SkillRegistry>,
    private readonly dashi: PiDashi | null,
    private readonly presentations: PresentationService | null,
  ) {}
  async commit(args: {
    userId: string;
    threadId: string;
    branchId: string;
    runId: string;
    leaseToken: string;
    assistant: AgentMessageRecord;
    proposal: PiCapturedProposal;
    content: string;
    sources?: SourceRef[];
    sessionRevision: number;
    sessionCursor: number;
    skillVersions: Record<string, string>;
    tokenUsage?: AgentRunRecord["tokenUsage"];
    emit: Emit;
    settle?: boolean;
    emitCompletedMessage?: boolean;
    transportTiming?: PiTransportTiming;
    clearPresentationPending?: boolean;
  }) {
    const pending = await this.repository.listPendingApprovals(
      args.userId,
      args.threadId,
      args.branchId,
    );
    let approval = pending.find((item) => (
      item.runId === args.runId && item.toolCallId === args.proposal.toolCallId
    ));
    if (!approval) {
      approval = {
        id: crypto.randomUUID(),
        ownerId: args.userId,
        runId: args.runId,
        threadId: args.threadId,
        branchId: args.branchId,
        assistantMessageId: args.assistant.id,
        toolCallId: args.proposal.toolCallId,
        state: "pending",
        patch: args.proposal.patch,
        encryptedRunState: encryptRunState(JSON.stringify({
          runtime: "pi",
          sessionRevision: args.sessionRevision,
          sessionCursor: args.sessionCursor,
          skillVersions: args.skillVersions,
        })),
        agentDefinitionVersion: piAgentDefinitionVersion,
        resourceType: args.proposal.resourceType,
        patchKind: args.proposal.patchKind,
        lessonFileId: args.proposal.lessonFileId,
        semesterFrameworkId: args.proposal.semesterFrameworkId,
        baseResourceVersion: args.proposal.baseResourceVersion,
        documentVersion: args.proposal.documentVersion,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      await this.repository.saveApproval(approval);
    }
    if (args.clearPresentationPending && isPresentationGoalPatch(args.proposal.patch) && args.proposal.lessonFileId) {
      const branch = await this.repository.getBranch(args.userId, args.threadId, args.branchId);
      if (!branch) throw new Error("thread_scope_invalid");
      if (branch.pendingInteraction) {
        const cleared = await this.repository.updatePresentationTask({
          ownerId: args.userId, threadId: args.threadId, branchId: args.branchId,
          runId: args.runId, leaseToken: args.leaseToken, fileId: args.proposal.lessonFileId,
          documentVersion: args.proposal.baseResourceVersion,
          previousPending: branch.pendingInteraction,
          pendingInteraction: null,
        });
        if (!cleared) throw new Error("presentation_theme_binding_failed");
      }
    }
    if (args.settle !== false) {
      await this.repository.settleRun({
        ownerId: args.userId,
        runId: args.runId,
        leaseToken: args.leaseToken,
        status: isDocumentDraftPatch(args.proposal.patch) ? "completed" : "awaiting_approval",
        tokenUsage: args.tokenUsage,
        messageStatus: "completed",
        messageContent: args.content,
        messageSources: args.sources,
        sessionCursor: args.sessionCursor,
      });
    }
    await args.emit({
      type: "approval.required",
      runId: args.runId,
      approvalId: approval.id,
      assistantMessageId: args.assistant.id,
      toolCallId: args.proposal.toolCallId,
      patch: args.proposal.patch,
      transportTiming: args.transportTiming,
    });
    if (args.settle !== false && args.emitCompletedMessage !== false) {
      const message = await this.repository.getMessage(args.userId, args.assistant.id) ?? args.assistant;
      await args.emit({ type: "message.completed", runId: args.runId, message });
      if (isDocumentDraftPatch(args.proposal.patch)) {
        await args.emit({ type: "run.completed", runId: args.runId });
      }
    }
  }

  async resume(args: {
    userId: string;
    runId: string;
    approvalId: string;
    approved: boolean;
    idempotencyKey: string;
    emit: Emit;
  }) {
    let approval = await this.repository.getApproval(args.userId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (isPresentationGoalPatch(approval.patch)) await this.ready;
    if (approval.runId !== args.runId) throw new Error("run_scope_invalid");
    if (
      "kind" in approval.patch
      && approval.patch.kind === "presentation_storyboard"
      && !isPresentationGoalPatch(approval.patch)
    ) throw new Error("presentation_plan_legacy");
    if (new Date(approval.expiresAt).getTime() <= Date.now()) throw new Error("approval_expired");
    const desired = args.approved ? "approved" : "rejected";
    if (approval.state !== "pending" && approval.state !== desired) {
      throw new Error("approval_already_resolved");
    }
    await this.repository.recoverExpiredRuns(args.userId, approval.threadId);
    const run = await this.repository.getRun(args.userId, args.runId);
    if (!run?.capabilityPlan) throw new Error("run_not_found");
    if (run.status === "cancelled") {
      await args.emit({ type: "run.cancelled", runId: run.id });
      return;
    }
    // A completed A4 draft is an independent decision, not another model run.
    // It can be adopted while the teacher continues a different chat turn.
    if (isDocumentDraftPatch(approval.patch) && run.status === "completed") {
      const decision = await this.repository.decideApproval({
        ownerId: args.userId, approvalId: approval.id, approved: args.approved,
        encryptedRunState: approval.encryptedRunState, completeWithoutContinuation: true,
      });
      if (decision.file) await args.emit({ type: "document.updated", runId: run.id, file: decision.file });
      if (decision.basis) await args.emit({ type: "design_basis.updated", runId: run.id, basis: decision.basis });
      await args.emit({ type: "approval.settled", runId: run.id, approvalId: approval.id, decision: desired });
      return;
    }
    await args.emit({
      type: "run.started",
      runId: approval.runId,
      threadId: approval.threadId,
      branchId: approval.branchId,
      startedAt: run.startedAt,
    });
    if (approval.continuationStatus === "completed") {
      await args.emit({
        type: "approval.decided",
        runId: approval.runId,
        approvalId: approval.id,
        decision: desired,
      });
      await args.emit({ type: "run.completed", runId: approval.runId });
      return;
    }
    const decisionWasPending = approval.state === "pending";
    const decision = await this.repository.decideApproval({
      ownerId: args.userId,
      approvalId: args.approvalId,
      approved: args.approved,
      encryptedRunState: approval.encryptedRunState,
    });
    approval = decision.approval;
    if (decisionWasPending) {
      await args.emit({
        type: "approval.decided",
        runId: approval.runId,
        approvalId: approval.id,
        decision: desired,
      });
      if (decision.file) await args.emit({ type: "document.updated", runId: approval.runId, file: decision.file });
      if (decision.framework) {
        await args.emit({
          type: "resource.updated",
          runId: approval.runId,
          resourceType: "semester_framework",
          framework: decision.framework,
        });
      }
      if (decision.basis) await args.emit({ type: "design_basis.updated", runId: approval.runId, basis: decision.basis });
    }
    // An HTTP retry is not the same execution owner. Fence every attempt.
    const leaseToken = crypto.randomUUID();
    const claimed = await this.repository.claimApprovalContinuation({
      ownerId: args.userId,
      approvalId: args.approvalId,
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
    });
    if (claimed.continuationStatus === "completed") {
      const settled = await this.repository.getRun(args.userId, claimed.runId);
      await args.emit({ type: settled?.status === "cancelled" ? "run.cancelled" : "run.completed", runId: claimed.runId });
      return;
    }
    const controller = new AbortController();
    let execution: ReturnType<PiRunLifecycle["open"]> | undefined;
    let content = "";
    try {
      execution = this.lifecycle.open({ userId: args.userId, runId: args.runId, leaseToken, controller }, args.emit);
      await execution.startHeartbeat();
      const assistant = await this.repository.getMessage(args.userId, claimed.continuationMessageId!)
        ?? await this.repository.appendMessage({
          id: claimed.continuationMessageId!,
          ownerId: args.userId,
          threadId: claimed.threadId,
          branchId: claimed.branchId,
          role: "assistant",
          content: "",
          status: "streaming",
        });
      content = assistant.content;
      if (args.approved && isPresentationGoalPatch(approval.patch)) {
        if (!this.dashi || !this.presentations) {
          throw new Error("presentation_renderer_unavailable");
        }
        const dashi = this.dashi;
        const presentations = this.presentations;
        const generation = await presentations.beginApprovedGoalGeneration(
          args.userId,
          approval.patch.fileId,
          {
            expectedDocumentVersion: approval.patch.documentVersion,
            goal: approval.patch.goal,
          },
          `approval:${approval.id}`,
        );
        if (!("presentation" in generation)) {
          try {
            const deck = await dashi.renderGoal({
              presentationId: generation.presentationId,
              goal: approval.patch.goal,
              signal: controller.signal,
            });
            await presentations.completeApprovedGoalGeneration({
              generation: generation.generation,
              presentationId: generation.presentationId,
              idempotencyKey: `approval:${approval.id}`,
              goal: approval.patch.goal,
              deck,
            });
          } catch (error) {
            await presentations.failApprovedGoalGeneration(generation.generation, error).catch(() => undefined);
            throw error;
          }
        }
        // Delivery is settled. Later reply or transport errors must not fail it.
        await args.emit({
          type: "approval.delivered",
          runId: approval.runId,
          approvalId: approval.id,
          presentationId: "presentation" in generation ? generation.presentation.id : generation.presentationId,
        });
      }
      const approvedPatchKind = "kind" in approval.patch
        ? approval.patch.kind
        : approval.patchKind ?? "document_patch";
      const approvalResourceType = approval.resourceType;
      const approvalSummary = approval.patch.summary;
      if (!approvalResourceType || !approvalSummary) throw new Error("approval_context_invalid");
      const thread = await this.repository.getThread(args.userId, approval.threadId);
      if (!thread) throw new Error("thread_scope_invalid");
      const continuationPlan = run.capabilityPlan;
      let continuationTools: ReturnType<PiToolSurface["toolsForLesson"]>;
      let continuationSkills: PlatformSkill[] = [];
      if (thread.resourceType === "semester_framework") {
        const aggregate = await this.repository.getSemesterFramework(args.userId, thread.semesterFrameworkId);
        if (!aggregate) throw new Error("thread_scope_invalid");
        continuationTools = this.toolSurface.toolsForSemester({
          resourceType: "semester_framework",
          userId: args.userId,
          notebookId: thread.notebookId,
          semesterFrameworkId: thread.semesterFrameworkId,
          threadId: thread.id,
          branchId: approval.branchId,
          runId: args.runId,
          frameworkVersion: aggregate.framework.version,
          contextProfile: aggregate.framework.contextProfile,
          allowedKnowledgeScopes: ["public", `user:${args.userId}`, `notebook:${thread.notebookId}`],
          attachmentSourceIds: [],
          abortSignal: controller.signal,
        }, continuationPlan, "write");
      } else {
        const [file, basis] = await Promise.all([
          this.repository.getLessonFile(args.userId, thread.lessonFileId),
          this.repository.getLessonDesignBasis(args.userId, thread.lessonFileId),
        ]);
        if (!file || !basis) throw new Error("thread_scope_invalid");
        continuationSkills = this.toolSurface.skillsForSurface(continuationPlan, "write");
        continuationTools = this.toolSurface.toolsForLesson({
          resourceType: "lesson_file",
          userId: args.userId,
          notebookId: thread.notebookId,
          lessonFileId: thread.lessonFileId,
          threadId: thread.id,
          branchId: approval.branchId,
          runId: args.runId,
          activeSectionId: "process",
          documentVersion: file.documentVersion,
          designBasisVersion: basis.basis.version,
          contextProfile: file.contextProfile,
          allowedKnowledgeScopes: [
            "public",
            `user:${args.userId}`,
            `notebook:${thread.notebookId}`,
            `file:${thread.lessonFileId}`,
          ],
          attachmentSourceIds: run.attachmentSourceIds ?? [],
          abortSignal: controller.signal,
        }, continuationPlan, continuationSkills, "write", args.runId);
      }
      const checkpoint = createMessageCheckpoint({
        persist: (snapshot) => this.repository.updateMessage(args.userId, assistant.id, {
          content: snapshot,
          status: "streaming",
        }),
      });
      const result = await this.executor.run({
        runId: args.runId,
        scope: { ownerId: args.userId, threadId: approval.threadId, branchId: approval.branchId },
        turnContext: {
          resource: { type: approvalResourceType },
          policy: {
            mode: "approval_continuation",
            completion: "brief_reply_only",
          },
        },
        input: approvalOutcomeMessage({
          approvalId: approval.id,
          decision: args.approved ? "approved" : "rejected",
          action: approvedPatchKind === "presentation_storyboard"
            ? "classroom_presentation"
            : approvedPatchKind,
          summary: approvalSummary,
          resourceType: approvalResourceType,
        }),
        continueExisting: false,
        tools: continuationTools.tools,
        skills: continuationSkills,
        maxTurns: 2,
        signal: controller.signal,
        emit: args.emit,
        onTextDelta: async (delta, turn) => {
          content += delta;
          checkpoint.update(content);
          await args.emit({ type: "message.delta", runId: args.runId, delta, turn });
        },
      });
      content = result.content || content || "";
      await checkpoint.flush(content);
      const sources = await emitRunEvidence(this.repository, args.userId, args.runId, args.emit);
      await this.repository.settleApprovalContinuation({
        ownerId: args.userId,
        approvalId: approval.id,
        leaseToken,
        outcome: "completed",
        assistantMessageId: assistant.id,
        content,
        sources,
        sessionCursor: result?.sessionCursor,
        tokenUsage: result?.tokenUsage,
        encryptedRunState: result ? encryptRunState(JSON.stringify({
          runtime: "pi",
          sessionRevision: result.sessionRevision,
          sessionCursor: result.sessionCursor,
          skillVersions: result.skillVersions,
        })) : undefined,
      });
      if ((await this.repository.getRun(args.userId, args.runId))?.status === "cancelled") {
        await args.emit({ type: "run.cancelled", runId: args.runId });
        return;
      }
      const message = await this.repository.getMessage(args.userId, assistant.id) ?? assistant;
      await args.emit({ type: "message.completed", runId: args.runId, message });
      await args.emit({
        type: "run.completed",
        runId: args.runId,
        transportTiming: result?.transportTiming,
      });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === "user_cancelled") {
        await this.repository.settleApprovalContinuation({
          ownerId: args.userId,
          approvalId: approval.id,
          leaseToken,
          outcome: "cancelled",
          assistantMessageId: claimed.continuationMessageId,
          content,
        }).catch(() => undefined);
        await args.emit({ type: "run.cancelled", runId: args.runId });
        return;
      }
      const code = publicPiAgentError(error, "approval_resume_failed");
      await this.repository.settleApprovalContinuation({
        ownerId: args.userId,
        approvalId: approval.id,
        leaseToken,
        outcome: "ready",
        assistantMessageId: claimed.continuationMessageId,
        content,
        error: code,
      }).catch(() => undefined);
      throw new Error(code, { cause: error });
    } finally {
      await execution?.close();
    }
  }
}
