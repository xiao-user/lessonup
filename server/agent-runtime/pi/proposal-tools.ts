import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  documentFieldPatchToolSchema,
  designBasisProjectionToolSchema,
  lessonDesignBasisPatchToolSchema,
  lessonDesignChangeToolSchema,
  presentationGoalToolSchema,
  semesterFrameworkPatchToolSchema,
  type CapabilityPlan,
  type LessonAgentContext,
  type ResourcePatch,
  type SemesterFrameworkAgentContext,
} from "../../domain.js";
import { applyDocumentPatch, materializeDocumentPatchProposal } from "../../document-patch.js";
import { materializeSemesterFrameworkPatch } from "../../semester-framework-patch.js";
import { materializeDesignBasisProjection } from "../../design-basis-projection.js";
import { materializeLessonDesignBasisPatch } from "../../lesson-design-basis-patch.js";
import { materializeLessonDesignChange } from "../../lesson-design-change.js";
import type { LessonRepository } from "../../repository.js";
import { findKnownLessonContentIssues } from "../../agent/lesson-content-validation.js";
import { evidenceRequiredToolError, validateObservedEvidence } from "../../agent/evidence-validation.js";
import { assertDocumentWriteScope } from "../../agent/write-scope.js";
import { validateLessonDesignProposalReferences } from "../../agent/design-basis-validation.js";
import { typeBoxFromZod } from "./schema-adapter.js";
import { dashiGoalSchema, type DashiGoal } from "../../presentations/dashi-goal.js";

export type PiCapturedProposal = {
  /**
   * The tool call that produced this proposal. The approval created from it
   * carries the same id, so the browser can attribute a confirmation item to
   * the exact call instead of guessing from the tool name — a run that
   * self-corrects after a rejected preflight must keep its earlier attempt
   * visibly unsuccessful.
   */
  toolCallId: string;
  patch: ResourcePatch;
  resourceType: "lesson_file" | "semester_framework";
  patchKind: "document" | "semester_framework" | "lesson_design_basis" | "presentation_storyboard";
  lessonFileId?: string;
  semesterFrameworkId?: string;
  baseResourceVersion: number;
  documentVersion?: number;
};

const pendingResult = (summary: string) => ({
  content: [{
    type: "text" as const,
    text: JSON.stringify({ status: "approval_required", summary }),
  }],
  details: null,
  terminate: true,
});

function dashiPreflightError(error: unknown) {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") {
    try {
      const report = JSON.parse(detail) as { goalSpecErrors?: unknown; propErrors?: unknown };
      const errors = [...new Set([
        ...(Array.isArray(report.goalSpecErrors) ? report.goalSpecErrors : []),
        ...(Array.isArray(report.propErrors) ? report.propErrors : []),
      ].filter((value): value is string => typeof value === "string"))].slice(0, 8);
      if (errors.length) return new Error(`dashi_goal_preflight_failed:${JSON.stringify(errors)}`);
    } catch {
      // The native error code remains the safe fallback when output is not JSON.
    }
  }
  return error instanceof Error ? error : new Error("dashi_goal_preflight_failed");
}

function captureSlot() {
  let captured: PiCapturedProposal | null = null;
  return {
    set(toolCallId: string, value: Omit<PiCapturedProposal, "toolCallId">) {
      if (captured) throw new Error("multiple_write_proposals_not_allowed");
      captured = { ...value, toolCallId };
    },
    get: () => captured,
  };
}

export function createPiDocumentProposalTool(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  plan: CapabilityPlan;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(documentFieldPatchToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_document_patch",
    label: "准备教案修改确认",
    description: "提交当前 A4 教案的语义字段修改供教师确认。每项 operation 提交完整字段 replacement，当前原文快照由服务端绑定；未经批准不会写入。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      if (args.plan.writeMode === "consultative") {
        throw new Error("document_write_not_requested");
      }
      const proposal = documentFieldPatchToolSchema.parse(raw);
      assertDocumentWriteScope(proposal, args.plan.requestedDocumentFields);
      if (args.plan.minimalWriteRequested && proposal.operations.length > 1) {
        throw new Error("too_many_document_operations");
      }
      const file = await args.repository.getLessonFile(args.context.userId, args.context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      if (file.documentVersion !== args.context.documentVersion) {
        throw new Error("document_context_stale");
      }
      const patch = materializeDocumentPatchProposal({
        proposal,
        fileId: file.id,
        documentVersion: file.documentVersion,
        plan: file.document,
      });
      const issues = findKnownLessonContentIssues(applyDocumentPatch(file.document, patch));
      if (issues.length) throw new Error("curriculum_example_conflict");
      if (args.plan.evidenceRequired) {
        const validation = validateObservedEvidence({
          plan: args.plan,
          evidence: await args.repository.listRunEvidence(args.context.userId, args.context.runId),
        });
        if (validation.tripwireTriggered) {
          throw evidenceRequiredToolError(validation.outputInfo.missingKinds ?? []);
        }
      }
      slot.set(toolCallId, {
        patch,
        resourceType: "lesson_file",
        patchKind: "document",
        lessonFileId: file.id,
        baseResourceVersion: file.documentVersion,
        documentVersion: file.documentVersion,
      });
      return pendingResult(patch.summary);
    },
  };
  return { tool, getProposal: slot.get };
}

export function createPiPresentationProposalTool(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  prepareGoal: (goal: DashiGoal) => Promise<DashiGoal>;
  getTheme: () => DashiGoal["themePack"] | undefined;
  language?: DashiGoal["language"];
  randomSeed?: string;
  normalizeGoal?: (goal: DashiGoal) => DashiGoal;
  assertPlanningEvidence?: (goal: DashiGoal) => void;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(presentationGoalToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_classroom_presentation",
    label: "提交 Dashi 演示确认",
    description: "直接提交最终课堂演示的标题、目标和 slides；主题与教案版本已由服务端绑定，批准后原样渲染。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const proposal = presentationGoalToolSchema.parse(raw);
      const file = await args.repository.getLessonFile(args.context.userId, args.context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      if (file.documentVersion !== args.context.documentVersion) throw new Error("document_context_stale");
      let goal: DashiGoal;
      try {
        const theme = args.getTheme();
        if (!theme) throw new Error("presentation_theme_required");
        const parsed = dashiGoalSchema.parse({
          title: proposal.title,
          goal: proposal.goal,
          audience: proposal.audience,
          language: args.language,
          themePack: theme,
          slides: proposal.slides,
        });
        const normalized = args.normalizeGoal?.(parsed) ?? parsed;
        args.assertPlanningEvidence?.(normalized);
        goal = await args.prepareGoal({ ...normalized, randomSeed: args.randomSeed ?? normalized.randomSeed });
        // props:safe may normalize or replace a layout. Re-check the exact
        // post-normalization goal so approval never covers a contract the
        // Agent did not inspect or a slide whose visible defaults can leak.
        args.assertPlanningEvidence?.(goal);
      } catch (error) {
        throw dashiPreflightError(error);
      }
      const patch: ResourcePatch = {
        kind: "presentation_storyboard",
        fileId: file.id,
        documentVersion: file.documentVersion,
        summary: proposal.summary,
        goal,
      };
      slot.set(toolCallId, {
        patch,
        resourceType: "lesson_file",
        patchKind: "presentation_storyboard",
        lessonFileId: file.id,
        baseResourceVersion: file.documentVersion,
        documentVersion: file.documentVersion,
      });
      return pendingResult(proposal.summary);
    },
  };
  return { tool, getProposal: slot.get };
}

export function createPiSemesterProposalTool(args: {
  repository: LessonRepository;
  context: SemesterFrameworkAgentContext;
  plan: CapabilityPlan;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(semesterFrameworkPatchToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_semester_framework_patch",
    label: "准备学期框架修改确认",
    description: "提交当前学期框架、单元或课时蓝图修改供教师确认。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const proposal = semesterFrameworkPatchToolSchema.parse(raw);
      if (args.plan.minimalWriteRequested && proposal.operations.length > 1) {
        throw new Error("too_many_framework_operations");
      }
      const aggregate = await args.repository.getSemesterFramework(
        args.context.userId,
        args.context.semesterFrameworkId,
      );
      if (!aggregate) throw new Error("semester_framework_not_found");
      if (aggregate.framework.version !== args.context.frameworkVersion) {
        throw new Error("resource_context_stale");
      }
      const patch = materializeSemesterFrameworkPatch({ proposal, aggregate });
      slot.set(toolCallId, {
        patch,
        resourceType: "semester_framework",
        patchKind: "semester_framework",
        semesterFrameworkId: aggregate.framework.id,
        baseResourceVersion: aggregate.framework.version,
      });
      return pendingResult(patch.summary);
    },
  };
  return { tool, getProposal: slot.get };
}

export function createPiLessonDesignChangeProposalTool(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  plan: CapabilityPlan;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(lessonDesignChangeToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_lesson_design_change",
    label: "准备完整备课调整",
    description: "将结构化设计依据与 A4 教案修改作为一个原子确认项提交。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const proposal = lessonDesignChangeToolSchema.parse(raw);
      assertDocumentWriteScope({ operations: proposal.documentOperations }, args.plan.requestedDocumentFields);
      const [file, aggregate, observedEvidence] = await Promise.all([
        args.repository.getLessonFile(args.context.userId, args.context.lessonFileId),
        args.repository.getLessonDesignBasis(args.context.userId, args.context.lessonFileId),
        args.repository.listRunEvidence(args.context.userId, args.context.runId),
      ]);
      if (!file) throw new Error("lesson_file_not_found");
      if (!aggregate) throw new Error("lesson_design_basis_not_found");
      if (file.documentVersion !== args.context.documentVersion) throw new Error("document_context_stale");
      if (aggregate.basis.version !== args.context.designBasisVersion) throw new Error("design_basis_context_stale");
      await validateLessonDesignProposalReferences({
        repository: args.repository,
        context: args.context,
        proposal: { summary: proposal.summary, operations: proposal.designBasisOperations },
      });
      const patch = materializeLessonDesignChange({ proposal, aggregate, file, observedEvidence });
      slot.set(toolCallId, {
        patch,
        resourceType: "lesson_file",
        patchKind: "document",
        lessonFileId: file.id,
        baseResourceVersion: file.documentVersion,
        documentVersion: file.documentVersion,
      });
      return pendingResult(patch.summary);
    },
  };
  return { tool, getProposal: slot.get };
}

export function createPiDesignBasisProjectionProposalTool(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  plan: CapabilityPlan;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(designBasisProjectionToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_design_basis_projection",
    label: "准备将设计依据落实到教案",
    description: "将现有结构化设计依据投影为 A4 教案修改确认项。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const proposal = designBasisProjectionToolSchema.parse(raw);
      assertDocumentWriteScope(proposal, args.plan.requestedDocumentFields);
      const [file, aggregate] = await Promise.all([
        args.repository.getLessonFile(args.context.userId, args.context.lessonFileId),
        args.repository.getLessonDesignBasis(args.context.userId, args.context.lessonFileId),
      ]);
      if (!file || !aggregate) throw new Error("lesson_design_basis_not_found");
      if (file.documentVersion !== args.context.documentVersion) throw new Error("document_context_stale");
      if (aggregate.basis.version !== args.context.designBasisVersion) throw new Error("design_basis_context_stale");
      const patch = materializeDesignBasisProjection({ proposal, aggregate, file });
      slot.set(toolCallId, {
        patch,
        resourceType: "lesson_file",
        patchKind: "document",
        lessonFileId: file.id,
        baseResourceVersion: file.documentVersion,
        documentVersion: file.documentVersion,
      });
      return pendingResult(patch.summary);
    },
  };
  return { tool, getProposal: slot.get };
}

export function createPiDesignBasisPatchProposalTool(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
}) {
  const slot = captureSlot();
  const parameters = typeBoxFromZod(lessonDesignBasisPatchToolSchema);
  const tool: AgentTool<typeof parameters> = {
    name: "propose_lesson_design_basis_patch",
    label: "准备设计依据修改",
    description: "仅在教师明确要求维护结构化设计依据时提交确认。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const proposal = lessonDesignBasisPatchToolSchema.parse(raw);
      const [aggregate, observedEvidence] = await Promise.all([
        args.repository.getLessonDesignBasis(args.context.userId, args.context.lessonFileId),
        args.repository.listRunEvidence(args.context.userId, args.context.runId),
      ]);
      if (!aggregate) throw new Error("lesson_design_basis_not_found");
      if (aggregate.basis.version !== args.context.designBasisVersion) throw new Error("design_basis_context_stale");
      await validateLessonDesignProposalReferences({ repository: args.repository, context: args.context, proposal });
      const patch = materializeLessonDesignBasisPatch({ proposal, aggregate, observedEvidence });
      slot.set(toolCallId, {
        patch,
        resourceType: "lesson_file",
        patchKind: "lesson_design_basis",
        lessonFileId: args.context.lessonFileId,
        baseResourceVersion: aggregate.basis.version,
      });
      return pendingResult(patch.summary);
    },
  };
  return { tool, getProposal: slot.get };
}
