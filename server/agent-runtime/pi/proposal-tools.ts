import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
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
import { dashiGoalSchema, dashiJsonValueSchema, type DashiGoal } from "../../presentations/dashi-goal.js";
import { deriveReadingEmphasis } from "./reading-emphasis.js";
import { documentDeliveryReceipt } from "./document-delivery-receipt.js";

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

function dashiPreflightErrors(error: unknown) {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") {
    try {
      const report = JSON.parse(detail) as { goalSpecErrors?: unknown; propErrors?: unknown };
      const errors = [...new Set([
        ...(Array.isArray(report.goalSpecErrors) ? report.goalSpecErrors : []),
        ...(Array.isArray(report.propErrors) ? report.propErrors : []),
      ].filter((value): value is string => typeof value === "string"))].slice(0, 8);
      if (errors.length) return errors;
    } catch {
      // Fall through to the server-authored error code.
    }
  }
  const message = error instanceof Error ? error.message : "";
  const prefix = "dashi_visible_copy_incomplete:";
  if (message.startsWith(prefix)) {
    try {
      const parsed = JSON.parse(message.slice(prefix.length));
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string").slice(0, 8);
      }
    } catch {
      // The safe code below is enough for an unexpected validation failure.
    }
  }
  return ["dashi_goal_preflight_failed"];
}

function dashiPreflightError(error: unknown, baseToolCallId: string) {
  return new Error(`dashi_goal_preflight_failed:${JSON.stringify({
    errors: dashiPreflightErrors(error),
    revision: {
      baseToolCallId,
      instruction: "只提交需要修正的标题、目标、audience 或 slides[].index，不要重发整份演示。",
    },
  })}`);
}

const presentationProposalSlideRevisionSchema = z.object({
  index: z.number().int().min(0).max(39),
  layout: z.string().regex(/^theme(?:0[1-9]|1[0-2])_page\d{3}$/).optional(),
  props: z.record(z.string(), dashiJsonValueSchema),
}).strict().superRefine((slide, context) => {
  if (!slide.layout && !Object.keys(slide.props).length) {
    context.addIssue({
      code: "custom",
      path: ["props"],
      message: "slide_revision_required",
    });
  }
});

const presentationProposalRevisionSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  baseToolCallId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(240).optional(),
  goal: z.string().trim().min(1).max(2_000).optional(),
  audience: z.string().trim().max(500).optional(),
  slides: z.array(presentationProposalSlideRevisionSchema).max(40).optional(),
}).strict().superRefine((proposal, context) => {
  if (
    proposal.title === undefined
    && proposal.goal === undefined
    && proposal.audience === undefined
    && !proposal.slides?.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["baseToolCallId"],
      message: "presentation_revision_required",
    });
  }
});

const presentationProposalInputSchema = z.union([
  presentationGoalToolSchema,
  presentationProposalRevisionSchema,
]);

// Function-call providers require a root object with named properties. A root
// anyOf can be interpreted as an empty parameter object by compatible hosts.
// Keep the conditional full/revision validation in the business parser above.
const presentationProposalParametersSchema = z.object({
  summary: presentationGoalToolSchema.shape.summary,
  baseToolCallId: presentationProposalRevisionSchema.shape.baseToolCallId.optional(),
  title: presentationGoalToolSchema.shape.title.optional(),
  goal: presentationGoalToolSchema.shape.goal.optional(),
  audience: presentationGoalToolSchema.shape.audience,
  slides: z.array(z.object({
    index: z.number().int().min(0).max(39).optional(),
    layout: z.string().regex(/^theme(?:0[1-9]|1[0-2])_page\d{3}$/).optional(),
    props: z.record(z.string(), dashiJsonValueSchema),
  })).min(1).max(40).optional(),
}).strict();

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
  // Provider-side validation sees the same shape the business validator parses.
  // An output-mode schema would reject the call before any handler can explain
  // the problem to the model.
  const parameters = typeBoxFromZod(documentFieldPatchToolSchema, "input");
  const tool: AgentTool<typeof parameters> = {
    name: "propose_document_patch",
    label: "准备教案修改确认",
    description: "提交当前 A4 教案的完整 Markdown 字段正文供教师确认。按本课重要性将适合局部强调的重点直接写成 ==重点==、=={pink}重点== 等荧光或 =={blue}重点== 等划线，遵守系统 A4 阅读指导，不以加粗替代或机械涂色；保留无关原文与教师标记。交付摘要由服务端从实际 replacement 推导，不由说明文字或重复清单决定。每项 operation 为完整字段 replacement，当前原文快照由服务端绑定；未经批准不会写入。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      if (args.plan.writeMode === "consultative") {
        throw new Error("document_write_not_requested");
      }
      const proposal = documentFieldPatchToolSchema.parse(raw);
      const readingEmphasis = deriveReadingEmphasis(proposal.operations);
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
        proposal: { summary: documentDeliveryReceipt(proposal.operations, readingEmphasis), operations: proposal.operations },
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
      return { ...pendingResult(patch.summary), details: { readingEmphasis } };
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
  let correctionCandidate: {
    toolCallId: string;
    proposal: z.infer<typeof presentationGoalToolSchema>;
  } | null = null;
  const parameters = typeBoxFromZod(presentationProposalParametersSchema, "input");
  const tool: AgentTool<typeof parameters> = {
    name: "propose_classroom_presentation",
    label: "提交 Dashi 演示确认",
    description: "直接提交最终课堂演示的标题、目标和 slides；主题与教案版本已由服务端绑定，批准后原样渲染。若预检返回 baseToolCallId，只提交需要修正的字段或 slide 索引，不必重发整份演示；只有该 ID 已不可用时才重新提交完整提案。",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, raw) => {
      const input = presentationProposalInputSchema.parse(raw);
      let proposal: z.infer<typeof presentationGoalToolSchema>;
      if ("baseToolCallId" in input) {
        const base = correctionCandidate?.toolCallId === input.baseToolCallId
          ? correctionCandidate.proposal
          : null;
        if (!base) throw new Error("presentation_revision_base_unavailable");
        const slideRevisions = input.slides ?? [];
        const indices = slideRevisions.map((slide) => slide.index);
        if (new Set(indices).size !== indices.length) {
          throw new Error("presentation_revision_duplicate_slide");
        }
        const revisions = new Map(slideRevisions.map((slide) => [slide.index, slide]));
        if (indices.some((index) => index >= base.slides.length)) {
          throw new Error("presentation_revision_slide_out_of_range");
        }
        proposal = {
          ...base,
          summary: input.summary,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.audience === undefined ? {} : { audience: input.audience }),
          slides: base.slides.map((slide, index) => {
            const revision = revisions.get(index);
            return revision ? {
              layout: revision.layout ?? slide.layout,
              props: revision.props,
            } : slide;
          }),
        };
      } else {
        proposal = input;
      }
      const file = await args.repository.getLessonFile(args.context.userId, args.context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      if (file.documentVersion !== args.context.documentVersion) throw new Error("document_context_stale");
      correctionCandidate = {
        toolCallId,
        proposal: structuredClone(proposal),
      };
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
        throw dashiPreflightError(error, toolCallId);
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
      if (args.plan.writeMode === "consultative") throw new Error("write_not_requested");
      const proposal = semesterFrameworkPatchToolSchema.parse(raw);
      if (args.plan.minimalWriteRequested && proposal.operations.length > 1) {
        throw new Error("too_many_framework_operations");
      }
      const aggregate = await args.repository.getSemesterFramework(
        args.context.userId,
        args.context.semesterFrameworkId,
      );
      if (!aggregate || aggregate.framework.notebookId !== args.context.notebookId) {
        throw new Error("semester_framework_not_found");
      }
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
